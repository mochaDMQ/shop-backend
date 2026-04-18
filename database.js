const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const { hashPassword } = require("./utils/password");

const dbDir = path.join(__dirname, "db");
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir);

const db = new Database(path.join(dbDir, "shop.db")); // Store data in db/shop.db
db.pragma("foreign_keys = ON"); // Enable fk constraints

// Create categories, products & users tables
db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    catid INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT    NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS products (
    pid              INTEGER PRIMARY KEY AUTOINCREMENT,
    catid            INTEGER NOT NULL,
    name             TEXT    NOT NULL,
    price            REAL    NOT NULL,
    description      TEXT,
    image_path       TEXT,
    image_thumb_path TEXT,
    FOREIGN KEY (catid) REFERENCES categories(catid) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS users (
    userid   INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT    NOT NULL UNIQUE,
    email    TEXT    NOT NULL UNIQUE,
    password TEXT    NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS orders (
    orderid                     INTEGER PRIMARY KEY AUTOINCREMENT,
    userid                      INTEGER NOT NULL,
    currency                    TEXT    NOT NULL,
    salt                        TEXT    NOT NULL,
    digest                      TEXT    NOT NULL,
    total_price_cents           INTEGER NOT NULL,
    status                      TEXT    NOT NULL DEFAULT 'pending',
    stripe_checkout_session_id  TEXT UNIQUE,
    stripe_payment_intent_id    TEXT UNIQUE,
    created_at                  TEXT    NOT NULL DEFAULT (datetime('now')),
    paid_at                     TEXT,
    FOREIGN KEY (userid) REFERENCES users(userid) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS order_items (
    order_item_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    orderid            INTEGER NOT NULL,
    pid                INTEGER NOT NULL,
    quantity           INTEGER NOT NULL,
    unit_price_cents   INTEGER NOT NULL,
    created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (orderid) REFERENCES orders(orderid) ON DELETE CASCADE,
    FOREIGN KEY (pid) REFERENCES products(pid) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS order_transactions (
    txid                       INTEGER PRIMARY KEY AUTOINCREMENT,
    orderid                    INTEGER NOT NULL UNIQUE,
    stripe_event_id            TEXT    NOT NULL UNIQUE,
    stripe_checkout_session_id TEXT,
    stripe_payment_intent_id   TEXT UNIQUE,
    currency                   TEXT    NOT NULL,
    amount_total_cents         INTEGER NOT NULL,
    stripe_payload             TEXT,
    created_at                 TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (orderid) REFERENCES orders(orderid) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_orders_userid_created_at
    ON orders(userid, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_order_items_orderid
    ON order_items(orderid);
`);

//If categories table is empty, initialize with seed data
const catCount = db.prepare("SELECT COUNT(*) AS c FROM categories").get().c;
if (catCount === 0) {
  const insertCat = db.prepare("INSERT INTO categories (name) VALUES (?)");
  const insertProd = db.prepare(
    "INSERT INTO products (catid, name, price, description) VALUES (?, ?, ?, ?)",
  );
  const freshFruit = insertCat.run("Fresh Fruit Collection").lastInsertRowid;
  const cheeseChestnut = insertCat.run(
    "Cheese & Chestnut Collection",
  ).lastInsertRowid;
  const chocolate = insertCat.run("Chocolate Collection").lastInsertRowid;

  // Fresh Fruit Collection
  insertProd.run(
    freshFruit,
    "Organic Strawberry",
    48.0,
    "Fresh organic strawberries, sweet and juicy, perfect for desserts.",
  );
  insertProd.run(
    freshFruit,
    "Mango Paradise",
    62.0,
    "Golden ripe mangoes with smooth texture and tropical flavor.",
  );
  insertProd.run(
    freshFruit,
    "Blueberry Delight",
    55.0,
    "Bursting with fresh blueberries on a light cream base.",
  );

  // Cheese & Chestnut Collection
  insertProd.run(
    cheeseChestnut,
    "Classic Cheesecake",
    58.0,
    "Rich and creamy New York-style cheesecake with graham cracker crust.",
  );
  insertProd.run(
    cheeseChestnut,
    "Chestnut Mousse Cake",
    65.0,
    "Velvety chestnut mousse layered with light sponge.",
  );
  insertProd.run(
    cheeseChestnut,
    "Burnt Basque Cheesecake",
    72.0,
    "Caramelised top with a custardy, molten centre.",
  );

  // Chocolate Collection
  insertProd.run(
    chocolate,
    "Dark Chocolate Truffle",
    68.0,
    "Intense dark chocolate ganache with a bittersweet finish.",
  );
  insertProd.run(
    chocolate,
    "Chocolate Lava Cake",
    45.0,
    "Warm chocolate cake with a gooey molten chocolate centre.",
  );
  insertProd.run(
    chocolate,
    "Matcha Chocolate Fusion",
    60.0,
    "Premium matcha sponge layered with dark chocolate cream.",
  );

  console.log("[DB] Seed data inserted.");
}

// Initialize users table with seed data if empty
const userCount = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
if (userCount === 0) {
  const insertUser = db.prepare(
    "INSERT INTO users (username, email, password, is_admin) VALUES (?, ?, ?, ?)",
  );

  // Insert admin user (password: admin123)
  const adminPassword = hashPassword("admin123");
  insertUser.run("admin", "admin@shop.com", adminPassword, 1);

  // Insert normal user (password: user123)
  const userPassword = hashPassword("user123");
  insertUser.run("user", "user@shop.com", userPassword, 0);

  console.log("[DB] User seed data inserted.");
}

module.exports = db;
