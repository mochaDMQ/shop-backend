const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')
const { hashPassword } = require('./utils/password')

const dbDir = path.join(__dirname, 'db')
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir)

const db = new Database(path.join(dbDir, 'shop.db')) // Store data in db/shop.db
db.pragma('foreign_keys = ON') // Enable fk constraints

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
`)

//If categories table is empty, initialize with seed data
const catCount = db.prepare('SELECT COUNT(*) AS c FROM categories').get().c
if (catCount === 0) {
  const insertCat = db.prepare(
    'INSERT INTO categories (name) VALUES (?)'
  )
  const insertProd = db.prepare(
    'INSERT INTO products (catid, name, price, description) VALUES (?, ?, ?, ?)'
  )
  const freshFruit = insertCat.run('Fresh Fruit Collection').lastInsertRowid
  const cheeseChestnut = insertCat.run('Cheese & Chestnut Collection').lastInsertRowid
  const chocolate = insertCat.run('Chocolate Collection').lastInsertRowid

  // Fresh Fruit Collection
  insertProd.run(freshFruit, 'Organic Strawberry', 48.0, 'Fresh organic strawberries, sweet and juicy, perfect for desserts.')
  insertProd.run(freshFruit, 'Mango Paradise', 62.0, 'Golden ripe mangoes with smooth texture and tropical flavor.')
  insertProd.run(freshFruit, 'Blueberry Delight', 55.0, 'Bursting with fresh blueberries on a light cream base.')

  // Cheese & Chestnut Collection
  insertProd.run(cheeseChestnut, 'Classic Cheesecake', 58.0, 'Rich and creamy New York-style cheesecake with graham cracker crust.')
  insertProd.run(cheeseChestnut, 'Chestnut Mousse Cake', 65.0, 'Velvety chestnut mousse layered with light sponge.')
  insertProd.run(cheeseChestnut, 'Burnt Basque Cheesecake', 72.0, 'Caramelised top with a custardy, molten centre.')

  // Chocolate Collection 
  insertProd.run(chocolate, 'Dark Chocolate Truffle', 68.0, 'Intense dark chocolate ganache with a bittersweet finish.')
  insertProd.run(chocolate, 'Chocolate Lava Cake', 45.0, 'Warm chocolate cake with a gooey molten chocolate centre.')
  insertProd.run(chocolate, 'Matcha Chocolate Fusion', 60.0, 'Premium matcha sponge layered with dark chocolate cream.')

  console.log('[DB] Seed data inserted.')
}

// Initialize users table with seed data if empty
const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c
if (userCount === 0) {
  const insertUser = db.prepare(
    'INSERT INTO users (username, email, password, is_admin) VALUES (?, ?, ?, ?)'
  )
  
  // Insert admin user (password: admin123)
  const adminPassword = hashPassword('admin123')
  insertUser.run('admin', 'admin@shop.com', adminPassword, 1)
  
  // Insert normal user (password: user123)
  const userPassword = hashPassword('user123')
  insertUser.run('user', 'user@shop.com', userPassword, 0)
  
  console.log('[DB] User seed data inserted.')
}

module.exports = db