const express = require("express");
const router = express.Router();
const { body, param, validationResult } = require("express-validator");
const db = require("../database");
const { requireAdmin } = require("../middleware/auth");

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty())
    return res.status(400).json({ errors: errors.array() });
  next();
};

router.get("/", (req, res) => {
  const { type } = req.query;
  const rows = type
    ? db
        .prepare("SELECT * FROM categories WHERE type = ? ORDER BY catid")
        .all(type)
    : db.prepare("SELECT * FROM categories ORDER BY catid").all();
  res.json(rows);
});

router.get("/:id", param("id").isInt(), validate, (req, res) => {
  const row = db
    .prepare("SELECT * FROM categories WHERE catid = ?")
    .get(req.params.id);
  if (!row) return res.status(404).json({ error: "Category not found" });
  res.json(row);
});

router.post(
  "/",
  requireAdmin,
  body("name").trim().notEmpty().withMessage("Name is required").escape(),
  validate,
  (req, res) => {
    try {
      const result = db
        .prepare("INSERT INTO categories (name) VALUES (?)")
        .run(req.body.name);
      res
        .status(201)
        .json({ catid: result.lastInsertRowid, name: req.body.name });
    } catch (e) {
      res.status(409).json({ error: "Category name already exists" });
    }
  },
);

// PUT /api/categories/:id (Admin only)
router.put(
  "/:id",
  requireAdmin,
  param("id").isInt(),
  body("name").trim().notEmpty().escape(),
  validate,
  (req, res) => {
    const result = db
      .prepare("UPDATE categories SET name = ? WHERE catid = ?")
      .run(req.body.name, req.params.id);
    if (result.changes === 0)
      return res.status(404).json({ error: "Category not found" });
    res.json({ catid: Number(req.params.id), name: req.body.name });
  },
);

// DELETE /api/categories/:id (Admin only)
router.delete(
  "/:id",
  requireAdmin,
  param("id").isInt(),
  validate,
  (req, res) => {
    const result = db
      .prepare("DELETE FROM categories WHERE catid = ?")
      .run(req.params.id);
    if (result.changes === 0)
      return res.status(404).json({ error: "Category not found" });
    res.json({ message: "Deleted" });
  },
);

module.exports = router;
