const express = require("express");
const cors = require("cors");
const path = require("path");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const session = require("express-session");
const crypto = require("crypto");
const { issueCsrfNonce, verifyCsrf } = require("./middleware/csrf");
const { requireAdmin, optionalAuth } = require("./middleware/auth");
require("dotenv").config({ path: ".env.development" });

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === "production";
const PROD_ORIGIN = "http://s75.iems5718.iecuhk.cc";
const DEV_ORIGIN = "http://localhost:8080";
const allowedOrigins = isProd ? [PROD_ORIGIN] : [DEV_ORIGIN];

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

// CORS
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-CSRF-Token"],
  }),
);

// Body & Cookie parser

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));
app.use(cookieParser());

// Session
const sessionSecret =
  process.env.SESSION_SECRET || crypto.randomBytes(48).toString("hex");

app.use(
  session({
    name: "sid",
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    genid: () => crypto.randomUUID(),
    cookie: {
      httpOnly: true,
      // secure: isProd,
      sameSite: "lax",
      maxAge: 3 * 24 * 60 * 60 * 1000, // 3 days
    },
  }),
);

// CSRF Nonce endpoint
app.get("/api/csrf-nonce", issueCsrfNonce);

app.use(
  "/uploads",
  (req, res, next) => {
    // Allow frontend pages to embed image resources cross-origin
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
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("X-Content-Type-Options", "nosniff");
    },
  }),
);

// API routes

app.use("/api/auth", verifyCsrf, require("./routes/auth"));
app.use("/api/categories", verifyCsrf, require("./routes/categories"));
app.use("/api/products", verifyCsrf, require("./routes/products"));

// Admin verification endpoint, used for frontend route guards
app.get("/api/admin/verify", requireAdmin, (req, res) => {
  res.json({ authorized: true, user: req.user });
});

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

// Global error handler
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
