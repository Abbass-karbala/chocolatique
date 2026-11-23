'use strict';
const express = require('express');
const path = require('path');
const { db, DATA_DIR } = require('./lib/db');
const { getSettings, putSettings, SETTING_DEFS } = require('./lib/settings');
const { initUsers, requireAuth, requireAdmin, authRouter, meRouter, usersRouter } = require('./lib/auth');
const { seed, downloadSeedImages } = require('./lib/seed');
const { CHANNELS } = require('./lib/calc');
const { httpError, str, wrap, limiter } = require('./lib/util');
const people = require('./routes/people');
const docs = require('./routes/docs');
const orders = require('./routes/orders');
const costing = require('./routes/costing');
const reports = require('./routes/reports');

const PORT = Number(process.env.PORT) || 3000;

initUsers();
seed();

const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'",
  });
  next();
});
app.use(express.json({ limit: '3mb' }));
app.use('/api', (req, res, next) => { // CSRF belt-and-braces on top of SameSite cookies
  if (req.method !== 'GET' && req.headers.origin) {
    try { if (new URL(req.headers.origin).host !== req.headers.host) return res.status(403).json({ error: 'Bad origin' }); }
    catch { return res.status(403).json({ error: 'Bad origin' }); }
  }
  res.set('Cache-Control', 'no-store');
  next();
});

/* ---- public API (the store) */
app.get('/api/public/config', (req, res) => {
  const s = getSettings();
  res.json({
    store_name: s.store_name, tagline_en: s.tagline_en, tagline_ar: s.tagline_ar, currency: s.currency,
    delivery_note_en: s.delivery_note_en, delivery_note_ar: s.delivery_note_ar,
    whatsapp: s.whatsapp_number, instagram: s.instagram, email: s.email,
  });
});
app.get('/api/public/products', (req, res) => {
  res.json({ products: db.prepare(`SELECT id,name_en,name_ar,desc_en,desc_ar,category,category_ar,image,price FROM products
    WHERE published=1 AND price IS NOT NULL AND price > 0 ORDER BY sort, id`).all() });
});
app.post('/api/orders', limiter(10, 60 * 60 * 1000), wrap((req, res) => {
  const b = req.body || {};
  const name = str(b.name, 80), phone = str(b.phone, 30), address = str(b.address, 300), notes = str(b.notes, 500);
  const lang = b.lang === 'ar' ? 'ar' : 'en';
  if (!name || phone.replace(/\D/g, '').length < 6) throw httpError(400, 'Name and phone are required');
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 30) throw httpError(400, 'Cart is empty');
  const lines = [], seen = new Set();
  for (const it of b.items) {
    const pid = Number(it.id), qty = Number(it.qty);
    if (!Number.isInteger(pid) || !Number.isInteger(qty) || qty < 1 || qty > 500 || seen.has(pid)) throw httpError(400, 'Bad cart');
    seen.add(pid);
    const p = db.prepare('SELECT id,name_en,name_ar,price FROM products WHERE id=? AND published=1 AND price>0').get(pid);
    if (!p) throw httpError(400, 'A product in your cart is no longer available');
    lines.push({ id: p.id, name_en: p.name_en, name_ar: p.name_ar, qty, price: p.price }); // price always comes from the DB
  }
  const total = lines.reduce((a, l) => a + l.qty * l.price, 0);
  const r = db.prepare("INSERT INTO orders(created_at,customer_name,phone,address,notes,items,total,status,lang,source) VALUES(?,?,?,?,?,?,?,'new',?,'website')")
    .run(new Date().toISOString(), name, phone, address, notes, JSON.stringify(lines), total, lang);
  const orderId = Number(r.lastInsertRowid);
  const s = getSettings();
  let whatsapp_url = null;
  if (s.whatsapp_number) {
    const L = lang === 'ar'
      ? { hi: `مرحباً ${s.store_name}، أريد تأكيد الطلب رقم`, name: 'الاسم', phone: 'الهاتف', addr: 'العنوان', notes: 'ملاحظات', total: 'المجموع' }
      : { hi: `Hi ${s.store_name}, I'd like to confirm order`, name: 'Name', phone: 'Phone', addr: 'Address', notes: 'Notes', total: 'Total' };
    const rows = lines.map((l) => `• ${l.qty} × ${(lang === 'ar' ? l.name_ar || l.name_en : l.name_en || l.name_ar)} — ${s.currency}${(l.qty * l.price).toFixed(2)}`);
    const text = [`${L.hi} #${orderId}`, '', ...rows, '', `${L.total}: ${s.currency}${total.toFixed(2)}`, `${L.name}: ${name}`, `${L.phone}: ${phone}`,
      address ? `${L.addr}: ${address}` : null, notes ? `${L.notes}: ${notes}` : null].filter((x) => x !== null).join('\n');
    whatsapp_url = `https://wa.me/${s.whatsapp_number}?text=${encodeURIComponent(text)}`;
  }
  res.status(201).json({ id: orderId, total, whatsapp_url });
}));

/* ---- sign in */
app.use('/api', authRouter);

/* ---- signed-in API */
const api = express.Router();
api.use(requireAuth);
api.use(meRouter);
api.use('/users', usersRouter);
api.use('/customers', people.customers);
api.use('/sales', docs.sales);
api.use('/orders', orders);
api.use('/payments', docs.payments);
api.use(reports.shared);
// Staff-safe list for invoice and order forms.
api.get('/catalog', (req, res) => {
  res.json({
    products: db.prepare('SELECT id,name_en,name_ar,price,published FROM products ORDER BY sort,id').all(),
    channels: CHANNELS, currency: getSettings().currency,
  });
});
api.get('/settings', (req, res) => {
  const s = getSettings();
  if (req.user.role === 'admin') return res.json({ settings: s, defs: SETTING_DEFS });
  res.json({ settings: { currency: s.currency, store_name: s.store_name } });
});

// Everything below is admin only.
api.use(requireAdmin);
api.put('/settings', wrap((req, res) => { putSettings(req.body || {}); res.json({ settings: getSettings() }); }));
api.use('/suppliers', people.suppliers);
api.use('/purchases', docs.purchases);
api.use(costing);
api.use(reports.adminOnly);
app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

/* ---- static files */
app.use('/uploads', express.static(path.join(DATA_DIR, 'uploads'), { maxAge: '7d', index: false }));
app.use('/shared', express.static(path.join(__dirname, 'shared'), { maxAge: 0 }));
app.use('/admin', express.static(path.join(__dirname, 'admin'), { maxAge: 0 }));
app.use('/', express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Server error' : err.message });
});

module.exports = app;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Chocolatique running:  store http://localhost:${PORT}/   admin http://localhost:${PORT}/admin/`));
  downloadSeedImages();
}
