'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'chocolatique.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

const tableExists = (n) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(n);
const hasColumn = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((r) => r.name === c);
const addCol = (t, c, def) => { if (tableExists(t) && !hasColumn(t, c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };

// v1 had password-only sessions: they are throw-away, so rebuild them.
if (tableExists('sessions') && !hasColumn('sessions', 'user_id')) db.exec('DROP TABLE sessions');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff',
  must_change INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_en TEXT NOT NULL DEFAULT '', name_ar TEXT NOT NULL DEFAULT '',
  desc_en TEXT NOT NULL DEFAULT '', desc_ar TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '', category_ar TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '',
  food_cost REAL, packaging REAL, pieces_per_batch REAL, hours_per_batch REAL,
  price REAL, distribution REAL,
  published INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ingredients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_en TEXT NOT NULL DEFAULT '', name_ar TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT 'kg', kind TEXT NOT NULL DEFAULT 'ingredient',
  cost REAL NOT NULL DEFAULT 0, last_price REAL, last_price_at TEXT
);
CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ingredient_id INTEGER NOT NULL, date TEXT NOT NULL,
  old_cost REAL NOT NULL, new_cost REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS recipe_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL,
  ingredient_id INTEGER, component_id INTEGER, qty REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recipe_product ON recipe_lines(product_id);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, date TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'Shop', note TEXT NOT NULL DEFAULT '', order_id INTEGER
);
CREATE TABLE IF NOT EXISTS invoice_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER NOT NULL, product_id INTEGER,
  name TEXT NOT NULL DEFAULT '', qty REAL NOT NULL, price REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invlines ON invoice_lines(invoice_id);
CREATE INDEX IF NOT EXISTS idx_inv_date ON invoices(date);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER, date TEXT NOT NULL, note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS purchase_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT, purchase_id INTEGER NOT NULL, ingredient_id INTEGER NOT NULL,
  qty REAL NOT NULL, total REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_purlines ON purchase_lines(purchase_id);
CREATE INDEX IF NOT EXISTS idx_pur_date ON purchases(date);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, doc_type TEXT NOT NULL, doc_id INTEGER NOT NULL,
  date TEXT NOT NULL, amount REAL NOT NULL, note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_pay_doc ON payments(doc_type, doc_id);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL, customer_name TEXT NOT NULL, phone TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
  items TEXT NOT NULL, total REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'new', lang TEXT NOT NULL DEFAULT 'en',
  source TEXT NOT NULL DEFAULT 'website', customer_id INTEGER
);
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_exp_date ON expenses(date);
CREATE TABLE IF NOT EXISTS monthly_inputs (
  month TEXT PRIMARY KEY,
  cash_start REAL NOT NULL DEFAULT 0, stock_start REAL NOT NULL DEFAULT 0, stock_end REAL NOT NULL DEFAULT 0,
  hours REAL NOT NULL DEFAULT 0, pieces_made REAL NOT NULL DEFAULT 0, pieces_wasted REAL NOT NULL DEFAULT 0,
  pay_taken REAL NOT NULL DEFAULT 0, equipment_life REAL NOT NULL DEFAULT 12
);
`);

// Columns added in v2 to tables that may already exist from v1.
addCol('orders', 'source', "TEXT NOT NULL DEFAULT 'website'");
addCol('orders', 'customer_id', 'INTEGER');
addCol('products', 'category_ar', "TEXT NOT NULL DEFAULT ''");

// Run fn inside a transaction. Calls can nest: inner ones become savepoints.
let depth = 0;
function tx(fn) {
  if (depth > 0) {
    const sp = `sp${depth}`;
    db.exec(`SAVEPOINT ${sp}`);
    depth++;
    try { const r = fn(); db.exec(`RELEASE ${sp}`); return r; } catch (e) { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); throw e; } finally { depth--; }
  }
  db.exec('BEGIN');
  depth = 1;
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } finally { depth = 0; }
}

// v1 kept sales as flat rows: turn each into an invoice with one line (+ one payment).
if (tableExists('sales') && hasColumn('sales', 'pieces')) {
  tx(() => {
    const insInv = db.prepare('INSERT INTO invoices(customer_id,date,channel,note,order_id) VALUES(NULL,?,?,?,?)');
    const insLine = db.prepare('INSERT INTO invoice_lines(invoice_id,product_id,name,qty,price) VALUES(?,?,?,?,?)');
    const insPay = db.prepare("INSERT INTO payments(doc_type,doc_id,date,amount,note) VALUES('sale',?,?,?,'')");
    for (const s of db.prepare('SELECT * FROM sales ORDER BY id').all()) {
      const r = insInv.run(s.date, s.channel, s.note || '', s.order_id ?? null);
      const iid = Number(r.lastInsertRowid);
      insLine.run(iid, s.product_id ?? null, s.product_name || '', s.pieces, s.price);
      if (s.paid > 0) insPay.run(iid, s.date_paid || s.date, s.paid);
    }
    db.exec('ALTER TABLE sales RENAME TO legacy_sales');
  });
}

module.exports = { db, tx, DATA_DIR };
