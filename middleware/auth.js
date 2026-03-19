const db = require("../database");

// Verify if user is authenticated, requires userId to exist in session
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const user = db
    .prepare(
      "SELECT userid, username, email, is_admin FROM users WHERE userid = ?",
    )
    .get(req.session.userId);

  if (!user) {
    // Destroy session if user not found
    req.session.destroy((err) => {
      if (err) console.error("Session destroy error:", err);
    });
    return res.status(401).json({ error: "User not found" });
  }

  req.user = user;
  next();
}

// requireAuth -> requireAdmin,  adminFlag == 1
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const user = db
    .prepare(
      "SELECT userid, username, email, is_admin FROM users WHERE userid = ?",
    )
    .get(req.session.userId);

  if (!user) {
    req.session.destroy((err) => {
      if (err) console.error("Session destroy error:", err);
    });
    return res.status(401).json({ error: "User not found" });
  }

  if (user.is_admin !== 1) {
    return res.status(403).json({ error: "Admin access required" });
  }

  req.user = user;
  next();
}

function optionalAuth(req, res, next) {
  if (req.session && req.session.userId) {
    const user = db
      .prepare(
        "SELECT userid, username, email, is_admin FROM users WHERE userid = ?",
      )
      .get(req.session.userId);
    if (user) {
      req.user = user;
    }
  }
  next();
}

// Regenerate session ID after successful login to prevent session fixation
function regenerateSession(req, userId, callback) {
  req.session.regenerate((err) => {
    if (err) {
      return callback(err);
    }
    req.session.userId = userId;
    callback(null);
  });
}

module.exports = {
  requireAuth,
  requireAdmin,
  optionalAuth,
  regenerateSession,
};
