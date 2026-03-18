// csrf.js
const crypto = require("crypto");
function issueCsrfNonce(req, res) {
  // 每次请求都生成新 nonce，覆盖旧值
  const nonce = crypto.randomBytes(32).toString("hex");
  req.session.csrfNonce = nonce;
  res.json({ nonce });
}

function verifyCsrf(req, res, next) {
  const method = req.method.toUpperCase();
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return next();
  const clientNonce =
    req.get("X-CSRF-Token") || req.body?.csrfToken || req.body?._csrf;
  const sessionNonce = req.session?.csrfNonce;
  req.session.csrfNonce = null;

  if (!clientNonce || !sessionNonce || clientNonce !== sessionNonce) {
    return res.status(403).json({ error: "Invalid or missing CSRF token" });
  }

  next();
}

module.exports = { issueCsrfNonce, verifyCsrf };
