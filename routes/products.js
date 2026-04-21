const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
const { body, param, query, validationResult } = require("express-validator");
const sanitizeHtml = require("sanitize-html");
const db = require("../database");
const { requireAdmin } = require("../middleware/auth");

const uploadDir = path.join(__dirname, "../uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const NAME_REGEX = /^[\p{L}\p{N}\s\-_.,()]{1,80}$/u;
const MAX_DESC_LEN = 1000;

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const allowedMime = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "image/bmp",
    ];
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExt = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"];
    if (!allowedMime.includes(file.mimetype))
      return cb(new Error("Invalid image MIME type"));
    if (!allowedExt.includes(ext))
      return cb(new Error("Invalid image extension"));
    cb(null, true);
  },
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

function safeDeleteUploadFile(fileUrlPath) {
  if (!fileUrlPath) return;
  // prevent path traversal, only allow files under /uploads with .jpg suffix
  if (!/^\/uploads\/[a-zA-Z0-9._-]+\.jpg$/.test(fileUrlPath)) return;
  const abs = path.join(__dirname, "..", fileUrlPath);
  if (fs.existsSync(abs)) fs.unlinkSync(abs);
}

async function processAndSaveImages(buffer, pid) {
  const id = Number(pid);
  // Use versioned file names to avoid browser cache showing old images
  const version = Date.now();
  const fullName = `${id}_${version}.jpg`;
  const thumbName = `${id}_${version}_thumb.jpg`;
  const fullPath = path.join(uploadDir, fullName);
  const thumbPath = path.join(uploadDir, thumbName);

  await sharp(buffer)
    .rotate()
    .resize(1200, 1200, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toFile(fullPath);

  await sharp(buffer)
    .rotate()
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

const sanitizeText = (v) =>
  sanitizeHtml(String(v || ""), {
    allowedTags: [],
    allowedAttributes: {},
  }).trim();

router.get(
  "/",
  query("catid").optional().isInt({ min: 1 }),
  validate,
  (req, res) => {
    const rows = req.query.catid
      ? db
          .prepare("SELECT * FROM products WHERE catid = ? ORDER BY pid")
          .all(Number(req.query.catid))
      : db.prepare("SELECT * FROM products ORDER BY pid").all();
    res.json(rows);
  },
);

router.get("/:id", param("id").isInt({ min: 1 }), validate, (req, res) => {
  const row = db
    .prepare("SELECT * FROM products WHERE pid = ?")
    .get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: "Product not found" });
  res.json(row);
});

router.post(
  "/",
  requireAdmin,
  upload.single("image"),
  body("catid").isInt({ min: 1 }).withMessage("catid must be positive integer"),
  body("name")
    .customSanitizer(sanitizeText)
    .matches(NAME_REGEX)
    .withMessage("Invalid product name"),
  body("price").isFloat({ gt: 0, lt: 1000000 }).withMessage("Invalid price"),
  body("description")
    .optional()
    .customSanitizer(sanitizeText)
    .isLength({ max: MAX_DESC_LEN })
    .withMessage("Description too long"),
  validate,
  async (req, res) => {
    try {
      const catid = Number(req.body.catid);
      const name = req.body.name;
      const price = Number(req.body.price);
      const description = req.body.description || "";

      // verify category exists (anti tampering)
      const cat = db
        .prepare("SELECT catid FROM categories WHERE catid = ?")
        .get(catid);
      if (!cat) return res.status(400).json({ error: "Invalid category id" });

      const result = db
        .prepare(
          "INSERT INTO products (catid, name, price, description) VALUES (?, ?, ?, ?)",
        )
        .run(catid, name, price, description);

      const pid = Number(result.lastInsertRowid);
      let imagePaths = { image_path: null, image_thumb_path: null };

      if (req.file) {
        imagePaths = await processAndSaveImages(req.file.buffer, pid);
        db.prepare(
          "UPDATE products SET image_path = ?, image_thumb_path = ? WHERE pid = ?",
        ).run(imagePaths.image_path, imagePaths.image_thumb_path, pid);
      }

      res.status(201).json({
        pid,
        catid,
        name,
        price,
        description,
        ...imagePaths,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Failed to create product" });
    }
  },
);

router.put(
  "/:id",
  requireAdmin,
  upload.single("image"),
  param("id").isInt({ min: 1 }),
  body("catid").optional().isInt({ min: 1 }),
  body("name")
    .optional()
    .customSanitizer(sanitizeText)
    .matches(NAME_REGEX)
    .withMessage("Invalid product name"),
  body("price").optional().isFloat({ gt: 0, lt: 1000000 }),
  body("description")
    .optional()
    .customSanitizer(sanitizeText)
    .isLength({ max: MAX_DESC_LEN }),
  validate,
  async (req, res) => {
    try {
      const pid = Number(req.params.id);
      const existing = db
        .prepare("SELECT * FROM products WHERE pid = ?")
        .get(pid);
      if (!existing)
        return res.status(404).json({ error: "Product not found" });

      const catid = req.body.catid ? Number(req.body.catid) : existing.catid;
      const name = req.body.name ?? existing.name;
      const price = req.body.price ? Number(req.body.price) : existing.price;
      const description = req.body.description ?? existing.description;

      const cat = db
        .prepare("SELECT catid FROM categories WHERE catid = ?")
        .get(catid);
      if (!cat) return res.status(400).json({ error: "Invalid category id" });

      let image_path = existing.image_path;
      let image_thumb_path = existing.image_thumb_path;

      if (req.file) {
        const paths = await processAndSaveImages(req.file.buffer, pid);
        // Remove old image files after new files are successfully generated
        safeDeleteUploadFile(existing.image_path);
        safeDeleteUploadFile(existing.image_thumb_path);
        image_path = paths.image_path;
        image_thumb_path = paths.image_thumb_path;
      }

      db.prepare(
        "UPDATE products SET catid = ?, name = ?, price = ?, description = ?, image_path = ?, image_thumb_path = ? WHERE pid = ?",
      ).run(catid, name, price, description, image_path, image_thumb_path, pid);

      res.json({
        pid,
        catid,
        name,
        price,
        description,
        image_path,
        image_thumb_path,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Failed to update product" });
    }
  },
);

router.delete(
  "/:id",
  requireAdmin,
  param("id").isInt({ min: 1 }),
  validate,
  (req, res) => {
    const pid = Number(req.params.id);

    const row = db
      .prepare(
        "SELECT image_path, image_thumb_path FROM products WHERE pid = ?",
      )
      .get(pid);

    if (row) {
      [row.image_path, row.image_thumb_path].forEach((p) => {
        safeDeleteUploadFile(p);
      });
    }

    const result = db.prepare("DELETE FROM products WHERE pid = ?").run(pid);
    if (result.changes === 0)
      return res.status(404).json({ error: "Product not found" });

    res.json({ message: "Deleted" });
  },
);

module.exports = router;
