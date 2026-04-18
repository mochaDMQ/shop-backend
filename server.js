const express = require("express");
const cors = require("cors");
const path = require("path");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const session = require("express-session");
const crypto = require("crypto");
const { issueCsrfNonce, verifyCsrf } = require("./middleware/csrf");
const { requireAdmin, optionalAuth } = require("./middleware/auth");

// ─────────────────────────────────────────────────────────────
// Environment Detection
// Priority: NODE_ENV env var > auto-detect > default to development
// ─────────────────────────────────────────────────────────────

function detectEnvironment() {
  // 1. If NODE_ENV is explicitly set, use it
  if (process.env.NODE_ENV) {
    return process.env.NODE_ENV;
  }

  // 2. Auto-detect based on environment characteristics
  const cwd = process.cwd();
  const hostname = require("os").hostname();

  // Check if running in a typical production environment
  const isProductionPath =
    cwd.includes("/var/www") || (cwd.includes("/home") && cwd.includes("www"));
  const isProductionHost =
    hostname.includes("iems") ||
    hostname.includes("prod") ||
    hostname.includes("server");

  if (isProductionPath || isProductionHost) {
    return "production";
  }

  // 3. Default to development
  return "development";
}

// Set NODE_ENV if not already set
const detectedEnv = detectEnvironment();
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = detectedEnv;
}

// Load the appropriate .env file
const envFile =
  process.env.NODE_ENV === "production"
    ? ".env.production"
    : ".env.development";
const envPath = path.join(__dirname, envFile);

console.log(`[Server] Environment: ${process.env.NODE_ENV}`);
console.log(`[Server] Loading config: ${envPath}`);

require("dotenv").config({ path: envPath });

const { ordersRouter, stripeWebhookRouter } = require("./routes/orders");

// ─────────────────────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === "production";
const PROD_ORIGIN =
  process.env.FRONTEND_ORIGIN || "https://s75.iems5718.iecuhk.cc";
const DEV_ORIGIN = "http://localhost:8080";
const allowedOrigins = isProd ? [PROD_ORIGIN] : [DEV_ORIGIN];

// Debug: Log CORS configuration on startup
console.log(`[Server] NODE_ENV: ${process.env.NODE_ENV}`);
console.log(`[Server] FRONTEND_ORIGIN: ${process.env.FRONTEND_ORIGIN}`);
console.log(`[Server] Allowed Origins:`, allowedOrigins);

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
          "https://s75.iems5718.iecuhk.cc",
        ],
        connectSrc: [
          "'self'",
          "http://localhost:3000",
          "https://s75.iems5718.iecuhk.cc",
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
      // Allow requests with no origin (like mobile apps, curl, or same-origin requests)
      if (!origin) return cb(null, true);

      // Debug log
      console.log(`[CORS] Request from origin: ${origin}`);
      console.log(`[CORS] Allowed origins:`, allowedOrigins);

      if (allowedOrigins.includes(origin)) {
        return cb(null, true);
      }

      // In production, also allow the same domain
      if (
        isProd &&
        (origin === "https://s75.iems5718.iecuhk.cc" ||
          origin === "http://s75.iems5718.iecuhk.cc")
      ) {
        return cb(null, true);
      }

      console.error(`[CORS] Blocked origin: ${origin}`);
      return cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-CSRF-Token", "Authorization"],
  }),
);

// Body & Cookie parser

app.use(
  "/api/webhooks",
  express.raw({ type: "application/json", limit: "100kb" }),
  stripeWebhookRouter(),
);

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
      secure: isProd, // Enable secure cookies in production (HTTPS required)
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
app.use("/api/orders", verifyCsrf, ordersRouter);

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
