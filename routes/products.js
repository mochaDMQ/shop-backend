const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
const { body, param, validationResult } = require("express-validator");
const db = require("../database");

// Image uploads
const uploadDir = path.join(__dirname, "../uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// Config multer for handling multipart/form-data (img uploads)
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const allowed = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"];
    const ext = path.extname(file.originalname).toLowerCase();
    allowed.includes(ext)
      ? cb(null, true)
      : cb(new Error("Invalid image format"));
  },
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

// Automatic image processing, generate full-size + thumbnail, return paths
async function processAndSaveImages(buffer, pid) {
  const fullName = `${pid}.jpg`;
  const thumbName = `${pid}_thumb.jpg`;
  const fullPath = path.join(uploadDir, fullName);
  const thumbPath = path.join(uploadDir, thumbName);

  // Resize
  await sharp(buffer)
    .resize(1200, 1200, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toFile(fullPath);

  // Thumbnail
  await sharp(buffer)
    .resize(400, 400, { fit: "cover" })
    .jpeg({ quality: 75 })
    .toFile(thumbPath);

  return {
    image_path: `/uploads/${fullName}`,
    image_thumb_path: `/uploads/${thumbName}`,
  };
}

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty())
    return res.status(400).json({ errors: errors.array() });
  next();
};

// GET /api/products  (?catid=x)
router.get("/", (req, res) => {
  const rows = req.query.catid
    ? db
        .prepare("SELECT * FROM products WHERE catid = ? ORDER BY pid")
        .all(req.query.catid)
    : db.prepare("SELECT * FROM products ORDER BY pid").all();
  res.json(rows);
});

// GET /api/products/:id
router.get("/:id", param("id").isInt(), validate, (req, res) => {
  const row = db
    .prepare("SELECT * FROM products WHERE pid = ?")
    .get(req.params.id);
  if (!row) return res.status(404).json({ error: "Product not found" });
  res.json(row);
});

// POST /api/products
router.post(
  "/",
  upload.single("image"),
  body("catid").isInt().withMessage("catid must be integer"),
  body("name").trim().notEmpty().escape(),
  body("price").isFloat({ gt: 0 }),
  body("description").optional().trim().escape(),
  validate,
  async (req, res) => {
    try {
      const { catid, name, price, description } = req.body;
      const result = db
        .prepare(
          "INSERT INTO products (catid, name, price, description) VALUES (?, ?, ?, ?)",
        )
        .run(catid, name, parseFloat(price), description || "");
      const pid = result.lastInsertRowid;

      let imagePaths = { image_path: null, image_thumb_path: null };

      if (req.file) {
        // resize, thumbail+original size
        imagePaths = await processAndSaveImages(req.file.buffer, pid);
        db.prepare(
          "UPDATE products SET image_path = ?, image_thumb_path = ? WHERE pid = ?",
        ).run(imagePaths.image_path, imagePaths.image_thumb_path, pid);
      }

      res.status(201).json({
        pid,
        catid: Number(catid),
        name,
        price: parseFloat(price),
        description,
        ...imagePaths,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  },
);

// PUT /api/products/:id
router.put(
  "/:id",
  upload.single("image"),
  param("id").isInt(),
  body("catid").optional().isInt(),
  body("name").optional().trim().notEmpty().escape(),
  body("price").optional().isFloat({ gt: 0 }),
  body("description").optional().trim().escape(),
  validate,
  async (req, res) => {
    try {
      const existing = db
        .prepare("SELECT * FROM products WHERE pid = ?")
        .get(req.params.id);
      if (!existing)
        return res.status(404).json({ error: "Product not found" });

      const catid = req.body.catid ?? existing.catid;
      const name = req.body.name ?? existing.name;
      const price = req.body.price
        ? parseFloat(req.body.price)
        : existing.price;
      const description = req.body.description ?? existing.description;

      let image_path = existing.image_path;
      let image_thumb_path = existing.image_thumb_path;

      if (req.file) {
        const paths = await processAndSaveImages(
          req.file.buffer,
          req.params.id,
        );
        image_path = paths.image_path;
        image_thumb_path = paths.image_thumb_path;
      }

      db.prepare(
        "UPDATE products SET catid=?, name=?, price=?, description=?, image_path=?, image_thumb_path=? WHERE pid=?",
      ).run(
        catid,
        name,
        price,
        description,
        image_path,
        image_thumb_path,
        req.params.id,
      );

      res.json({
        pid: Number(req.params.id),
        catid: Number(catid),
        name,
        price,
        description,
        image_path,
        image_thumb_path,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  },
);

// DELETE /api/products/:id
router.delete("/:id", param("id").isInt(), validate, (req, res) => {
  // Delete associated images if exist
  const row = db
    .prepare("SELECT image_path, image_thumb_path FROM products WHERE pid = ?")
    .get(req.params.id);
  if (row) {
    [row.image_path, row.image_thumb_path].forEach((p) => {
      if (p) {
        const abs = path.join(__dirname, "..", p);
        if (fs.existsSync(abs)) fs.unlinkSync(abs);
      }
    });
  }
  const result = db
    .prepare("DELETE FROM products WHERE pid = ?")
    .run(req.params.id);
  if (result.changes === 0)
    return res.status(404).json({ error: "Product not found" });
  res.json({ message: "Deleted" });
});

module.exports = router;
