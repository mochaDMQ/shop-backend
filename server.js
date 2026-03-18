// server.js
const express = require("express");
const cors = require("cors");
const path = require("path");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const session = require("express-session");
const crypto = require("crypto");
// ✅ 使用新的 csrf.js 导出
const { issueCsrfNonce, verifyCsrf } = require("./csrf");
require("dotenv").config({ path: ".env.development" });

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// 环境配置
// ─────────────────────────────────────────────
const isProd = process.env.NODE_ENV === "production";
const PROD_ORIGIN = "http://s75.iems5718.iecuhk.cc";
const DEV_ORIGIN = "http://localhost:8080";
const allowedOrigins = isProd ? [PROD_ORIGIN] : [DEV_ORIGIN];

// ─────────────────────────────────────────────
// 基础安全配置
// ─────────────────────────────────────────────
app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: [
          "'self'",
          "data:",
          "blob:",
          "http://localhost:3000",
          "http://s75.iems5718.iecuhk.cc",
        ],
        connectSrc: [
          "'self'",
          "http://localhost:3000",
          "http://s75.iems5718.iecuhk.cc",
        ],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    noSniff: true,
    hidePoweredBy: true,
    crossOriginResourcePolicy: { policy: "same-site" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  }),
);

// ─────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    // ✅ 确保 X-CSRF-Token 在 allowedHeaders 中，前端才能发送该请求头
    allowedHeaders: ["Content-Type", "X-CSRF-Token"],
  }),
);

// ─────────────────────────────────────────────
// Body 解析 & Cookie
// ─────────────────────────────────────────────
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));
app.use(cookieParser());

// ─────────────────────────────────────────────
// Session
// ─────────────────────────────────────────────
const sessionSecret =
  process.env.SESSION_SECRET || crypto.randomBytes(48).toString("hex");

app.use(
  session({
    name: "sid",
    secret: sessionSecret,
    resave: false,
    // ✅ 改为 false：只有 session 被修改时才保存
    // issueCsrfNonce 会写入 csrfNonce，触发保存
    // 未登录的纯 GET 请求不会创建无意义的空 session
    saveUninitialized: false,
    rolling: true,
    genid: () => crypto.randomUUID(),
    cookie: {
      httpOnly: true,
      secure: isProd, // ✅ 生产环境自动启用 HTTPS-only
      sameSite: "lax",
      maxAge: 30 * 60 * 1000,
    },
  }),
);

// ─────────────────────────────────────────────
// CSRF Nonce 端点
// ✅ 路径改为 /api/csrf-nonce，与前端 getCsrfNonce() 对应
// 移除原来的 ensureCsrfToken 全局中间件：
//   原中间件在每个请求上自动生成 token，
//   但 nonce 策略要求"按需生成、用后即废"，
//   全局自动生成会导致旧 nonce 被意外覆盖
// ─────────────────────────────────────────────
app.get("/api/csrf-nonce", issueCsrfNonce);

// ─────────────────────────────────────────────
// 静态文件
// ─────────────────────────────────────────────
app.use(
  "/uploads",
  (req, res, next) => {
    // 允许前端页面跨源嵌入图片资源（例如 <img src="http://localhost:3000/uploads/...">）
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  },
  express.static(path.join(__dirname, "uploads"), {
    fallthrough: false,
    dotfiles: "deny",
    index: false,
    etag: true,
    maxAge: "7d",
    setHeaders: (res) => {
      // 确保 200/304 都带上同样的安全头，避免浏览器判定 NOT-SET
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("X-Content-Type-Options", "nosniff");
    },
  }),
);

// ─────────────────────────────────────────────
// API 路由
// verifyCsrf 已在内部判断 method，GET 请求自动放行
// ─────────────────────────────────────────────
app.use("/api/categories", verifyCsrf, require("./routes/categories"));
app.use("/api/products", verifyCsrf, require("./routes/products"));

// ─────────────────────────────────────────────
// 健康检查（无需 CSRF 保护）
// ─────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// 全局错误处理
// ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err);
  if (err.message?.includes("CORS")) {
    return res.status(403).json({ error: "CORS blocked" });
  }
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
