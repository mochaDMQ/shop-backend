const express = require("express");
const router = express.Router();
const { body, validationResult } = require("express-validator");
const sanitizeHtml = require("sanitize-html");
const db = require("../database");
const { hashPassword, verifyPassword } = require("../utils/password");
const { requireAuth, regenerateSession } = require("../middleware/auth");

// Sanitize user input by removing HTML tags

function sanitizeInput(input) {
  if (typeof input !== "string") return "";
  return sanitizeHtml(input, {
    allowedTags: [],
    allowedAttributes: {},
    textFilter: (text) => text,
  }).trim();
}

function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function isStrongPassword(password) {
  if (password.length < 8) return false;
  if (!/[a-zA-Z]/.test(password)) return false;
  if (!/[0-9]/.test(password)) return false;
  return true;
}

// user login
router.post(
  "/login",
  [
    body("email").isEmail().withMessage("Invalid email format"),
    body("password").notEmpty().withMessage("Password is required"),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const email = sanitizeInput(req.body.email).toLowerCase();
    const password = req.body.password;

    // Parameterized query to prevent SQL injection
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);

    if (!user) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    if (!verifyPassword(password, user.password)) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    //  Regenerate session ID to prevent Session Fixation
    regenerateSession(req, user.userid, (err) => {
      if (err) {
        console.error("Session regeneration error:", err);
        return res.status(500).json({ error: "Login failed" });
      }

      res.json({
        message: "Login successful",
        user: {
          userid: user.userid,
          username: user.username,
          email: user.email,
          is_admin: user.is_admin,
        },
      });
    });
  },
);

router.post(
  "/register",
  [
    body("username")
      .isLength({ min: 3, max: 50 })
      .withMessage("Username must be 3-50 characters"),
    body("email").isEmail().withMessage("Invalid email format"),
    body("password")
      .isLength({ min: 8 })
      .withMessage("Password must be at least 8 characters"),
    body("confirmPassword")
      .notEmpty()
      .withMessage("Password confirmation is required"),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const username = sanitizeInput(req.body.username);
    const email = sanitizeInput(req.body.email).toLowerCase();
    const password = req.body.password;
    const confirmPassword = req.body.confirmPassword;

    const usernameRegex = /^[\p{L}\p{N}_-]{3,50}$/u;
    if (!usernameRegex.test(username)) {
      return res.status(400).json({
        error:
          "Username can only contain letters, numbers, underscores and hyphens",
      });
    }

    if (!isStrongPassword(password)) {
      return res.status(400).json({
        error:
          "Password must be at least 8 characters with letters and numbers",
      });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ error: "Passwords do not match" });
    }

    // Check if username already exists
    const existingUsername = db
      .prepare("SELECT userid FROM users WHERE username = ?")
      .get(username);
    if (existingUsername) {
      return res.status(400).json({ error: "Username already exists" });
    }

    // Check if email already registered
    const existingEmail = db
      .prepare("SELECT userid FROM users WHERE email = ?")
      .get(email);
    if (existingEmail) {
      return res.status(400).json({ error: "Email already registered" });
    }

    const hashedPassword = hashPassword(password);

    try {
      const result = db
        .prepare(
          "INSERT INTO users (username, email, password, is_admin) VALUES (?, ?, ?, 0)",
        )
        .run(username, email, hashedPassword);

      regenerateSession(req, result.lastInsertRowid, (err) => {
        if (err) {
          console.error("Session regeneration error:", err);
          return res.status(500).json({ error: "Registration failed" });
        }

        res.status(201).json({
          message: "Registration successful",
          user: {
            userid: result.lastInsertRowid,
            username: username,
            email: email,
            is_admin: 0,
          },
        });
      });
    } catch (dbErr) {
      console.error("Database error:", dbErr);
      res.status(500).json({ error: "Registration failed" });
    }
  },
);

// Logout
router.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("Logout error:", err);
      return res.status(500).json({ error: "Logout failed" });
    }
    res.clearCookie("sid");
    res.json({ message: "Logout successful" });
  });
});

// Get current user info
router.get("/me", requireAuth, (req, res) => {
  res.json({
    user: {
      userid: req.user.userid,
      username: req.user.username,
      email: req.user.email,
      is_admin: req.user.is_admin,
    },
  });
});

// Change password
router.post(
  "/change-password",
  requireAuth,
  [
    body("currentPassword")
      .notEmpty()
      .withMessage("Current password is required"),
    body("newPassword")
      .isLength({ min: 8 })
      .withMessage("New password must be at least 8 characters"),
    body("confirmPassword")
      .notEmpty()
      .withMessage("Password confirmation is required"),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const currentPassword = req.body.currentPassword;
    const newPassword = req.body.newPassword;
    const confirmPassword = req.body.confirmPassword;
    const user = db
      .prepare("SELECT * FROM users WHERE userid = ?")
      .get(req.user.userid);

    if (!verifyPassword(currentPassword, user.password)) {
      return res.status(400).json({ error: "Current password is incorrect" });
    }

    if (!isStrongPassword(newPassword)) {
      return res.status(400).json({
        error:
          "New password must be at least 8 characters with letters and numbers",
      });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: "Passwords do not match" });
    }

    if (verifyPassword(newPassword, user.password)) {
      return res.status(400).json({
        error: "New password must be different from current password",
      });
    }

    const hashedPassword = hashPassword(newPassword);

    try {
      db.prepare("UPDATE users SET password = ? WHERE userid = ?").run(
        hashedPassword,
        req.user.userid,
      );

      req.session.destroy((err) => {
        if (err) {
          console.error("Session destroy error:", err);
        }
        res.clearCookie("sid");
        res.json({
          message: "Password changed successfully. Please login again.",
        });
      });
    } catch (dbErr) {
      console.error("Database error:", dbErr);
      res.status(500).json({ error: "Password change failed" });
    }
  },
);

router.get("/check-admin", requireAuth, (req, res) => {
  res.json({
    isAdmin: req.user.is_admin === 1,
    user: {
      userid: req.user.userid,
      username: req.user.username,
      email: req.user.email,
      is_admin: req.user.is_admin,
    },
  });
});

module.exports = router;
