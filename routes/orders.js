'use strict';
// Orders from the website and orders typed in by hand (WhatsApp, phone, shop).
// When an order is Delivered it becomes a paid sales invoice (cash on delivery).
const express = require('express');
const { db, tx } = require('../lib/db');
const { saveDoc, deleteDoc } = require('../lib/docs');
const { requireAdmin } = require('../lib/auth');
const { httpError, str, wrap, toId, optId, today, posNum, numOrNull, round2 } = require('../lib/util');

const STATUSES = ['new', 'confirmed', 'delivered', 'cancelled'];
const out = (o) => ({ ...o, items: JSON.parse(o.items), invoice_id: (db.prepare('SELECT id FROM invoices WHERE order_id=?').get(o.id) || {}).id || null });

function customerFor(order) {
  if (order.customer_id && db.prepare('SELECT 1 FROM customers WHERE id=?').get(order.customer_id)) return order.customer_id;
  const tail = String(order.phone || '').replace(/\D/g, '').slice(-8);
  let c = null;
  if (tail.length >= 6) c = db.prepare("SELECT id FROM customers WHERE REPLACE(REPLACE(REPLACE(REPLACE(phone,' ',''),'+',''),'-',''),'(','') LIKE ?").get(`%${tail}`);
  if (c) return c.id;
  const r = db.prepare('INSERT INTO customers(name,phone,address,notes,created_at) VALUES(?,?,?,?,?)')
    .run(order.customer_name, order.phone || '', order.address || '', `From order #${order.id}`, new Date().toISOString());
  return Number(r.lastInsertRowid);
}

function syncInvoice(order, status) {
  tx(() => {
    const existing = db.prepare('SELECT id FROM invoices WHERE order_id=?').get(order.id);
    if (existing && status !== 'delivered') deleteDoc('sale', existing.id);
    if (!existing && status === 'delivered') {
      const items = JSON.parse(order.items);
      const cid = customerFor(order);
      const id = saveDoc('sale', null, {
        customer_id: cid, date: today(), channel: order.source === 'website' ? 'Website' : 'WhatsApp', note: `Order #${order.id}`,
        lines: items.map((i) => ({ product_id: i.id, name: i.name_en || i.name_ar, qty: i.qty, price: i.price })), paid: order.total,
      });
      db.prepare('UPDATE invoices SET order_id=? WHERE id=?').run(order.id, id);
      db.prepare('UPDATE orders SET customer_id=? WHERE id=?').run(cid, order.id);
    }
  });
}

const router = express.Router();

router.get('/', (req, res) => res.json({ orders: db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 500').all().map(out) }));

// Polled by the app every few seconds to raise the "new order" alert.
router.get('/pending', (req, res) => {
  const c = db.prepare("SELECT COUNT(*) AS c FROM orders WHERE status='new'").get().c;
  const latest = db.prepare("SELECT id, customer_name, total FROM orders WHERE status='new' ORDER BY id DESC LIMIT 1").get() || null;
  res.json({ count: c, latest });
});

// Order typed in by hand, e.g. one that arrived on WhatsApp.
router.post('/manual', wrap((req, res) => {
  const b = req.body || {};
  const cid = optId(b.customer_id);
  let name = str(b.name, 80), phone = str(b.phone, 30), address = str(b.address, 300);
  if (cid) {
    const c = db.prepare('SELECT * FROM customers WHERE id=?').get(cid);
    if (!c) throw httpError(400, 'Unknown customer');
    name = c.name; phone = c.phone; address = address || c.address;
  }
  if (!name) throw httpError(400, 'Customer name required');
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 50) throw httpError(400, 'Add at least one item');
  const lines = b.items.map((it) => {
    const p = db.prepare('SELECT id,name_en,name_ar,price FROM products WHERE id=?').get(toId(it.product_id));
    if (!p) throw httpError(400, 'Unknown product');
    const price = numOrNull(it.price) ?? p.price ?? 0;
    return { id: p.id, name_en: p.name_en, name_ar: p.name_ar, qty: posNum(it.qty), price };
  });
  const total = round2(lines.reduce((a, l) => a + l.qty * l.price, 0));
  const r = db.prepare('INSERT INTO orders(created_at,customer_name,phone,address,notes,items,total,status,lang,source,customer_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(new Date().toISOString(), name, phone, address, str(b.notes, 500), JSON.stringify(lines), total, 'confirmed', 'en', 'whatsapp', cid);
  res.status(201).json(out(db.prepare('SELECT * FROM orders WHERE id=?').get(Number(r.lastInsertRowid))));
}));

router.put('/:id', wrap((req, res) => {
  const id = toId(req.params.id), status = (req.body || {}).status;
  if (!STATUSES.includes(status)) throw httpError(400, 'Bad status');
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o) throw httpError(404, 'Not found');
  tx(() => { db.prepare('UPDATE orders SET status=? WHERE id=?').run(status, id); syncInvoice(o, status); });
  res.json(out(db.prepare('SELECT * FROM orders WHERE id=?').get(id)));
}));

router.delete('/:id', requireAdmin, wrap((req, res) => {
  const id = toId(req.params.id);
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o) throw httpError(404, 'Not found');
  tx(() => { syncInvoice(o, 'cancelled'); db.prepare('DELETE FROM orders WHERE id=?').run(id); });
  res.json({ ok: true });
}));

module.exports = router;
