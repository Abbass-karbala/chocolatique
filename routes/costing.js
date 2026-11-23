'use strict';
// Cost control (admin only): ingredients, products, recipes, and the "Update cost control" step.
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, tx, DATA_DIR } = require('../lib/db');
const { loadContext, productCost, pendingIngredients, pendingImpact, isPending, wouldLoop } = require('../lib/cost');
const { overhead } = require('../lib/calc');
const { httpError, str, numOrNull, numReq, posNum, wrap, toId, today } = require('../lib/util');

const UNITS = ['kg', 'g', 'L', 'ml', 'pcs'];
const KINDS = ['ingredient', 'packaging'];
const router = express.Router();

/* ------------------------------------------------------------ ingredients */
const cleanIngredient = (b) => {
  const name_en = str(b.name_en, 80), name_ar = str(b.name_ar, 80);
  if (!name_en && !name_ar) throw httpError(400, 'Name required');
  if (!UNITS.includes(b.unit)) throw httpError(400, 'Bad unit');
  if (!KINDS.includes(b.kind)) throw httpError(400, 'Bad type');
  return { name_en, name_ar, unit: b.unit, kind: b.kind, cost: numOrNull(b.cost) ?? 0 };
};
const ingredientOut = (g) => ({
  ...g, pending: isPending(g),
  used_in: db.prepare('SELECT COUNT(DISTINCT product_id) AS c FROM recipe_lines WHERE ingredient_id=?').get(g.id).c,
  purchases: db.prepare('SELECT COUNT(*) AS c FROM purchase_lines WHERE ingredient_id=?').get(g.id).c,
});

router.get('/ingredients', (req, res) => {
  res.json({ rows: db.prepare('SELECT * FROM ingredients ORDER BY kind, COALESCE(NULLIF(name_en,\'\'),name_ar) COLLATE NOCASE').all().map(ingredientOut), units: UNITS });
});
router.post('/ingredients', wrap((req, res) => {
  const c = cleanIngredient(req.body || {});
  const r = db.prepare('INSERT INTO ingredients(name_en,name_ar,unit,kind,cost) VALUES(?,?,?,?,?)').run(c.name_en, c.name_ar, c.unit, c.kind, c.cost);
  res.status(201).json(ingredientOut(db.prepare('SELECT * FROM ingredients WHERE id=?').get(Number(r.lastInsertRowid))));
}));
router.put('/ingredients/:id', wrap((req, res) => {
  const id = toId(req.params.id);
  const old = db.prepare('SELECT * FROM ingredients WHERE id=?').get(id);
  if (!old) throw httpError(404, 'Not found');
  const c = cleanIngredient(req.body || {});
  tx(() => {
    db.prepare('UPDATE ingredients SET name_en=?,name_ar=?,unit=?,kind=?,cost=? WHERE id=?').run(c.name_en, c.name_ar, c.unit, c.kind, c.cost, id);
    if (Math.abs(c.cost - old.cost) > 1e-9) db.prepare('INSERT INTO price_history(ingredient_id,date,old_cost,new_cost) VALUES(?,?,?,?)').run(id, today(), old.cost, c.cost);
  });
  res.json(ingredientOut(db.prepare('SELECT * FROM ingredients WHERE id=?').get(id)));
}));
router.delete('/ingredients/:id', wrap((req, res) => {
  const id = toId(req.params.id);
  const g = ingredientOut(db.prepare('SELECT * FROM ingredients WHERE id=?').get(id) || (() => { throw httpError(404, 'Not found'); })());
  if (g.used_in || g.purchases) throw httpError(400, 'It is used in a recipe or a purchase, so it cannot be deleted');
  db.prepare('DELETE FROM price_history WHERE ingredient_id=?').run(id);
  db.prepare('DELETE FROM ingredients WHERE id=?').run(id);
  res.json({ ok: true });
}));
router.get('/ingredients/:id/history', wrap((req, res) => {
  const id = toId(req.params.id);
  res.json({
    changes: db.prepare('SELECT * FROM price_history WHERE ingredient_id=? ORDER BY id DESC LIMIT 50').all(id),
    purchases: db.prepare(`SELECT d.id, d.date, s.name AS supplier, l.qty, l.total, l.total/l.qty AS unit_price FROM purchase_lines l
      JOIN purchases d ON d.id=l.purchase_id LEFT JOIN suppliers s ON s.id=d.supplier_id WHERE l.ingredient_id=? AND l.qty>0 ORDER BY d.date DESC, d.id DESC LIMIT 30`).all(id),
  });
}));

/* --------------------------------------------------------- price updates */
router.get('/cost/pending', (req, res) => {
  const ctx = loadContext();
  res.json({
    changes: pendingIngredients(ctx).map((g) => ({ id: g.id, name_en: g.name_en, name_ar: g.name_ar, unit: g.unit, old: g.cost, new: g.last_price, date: g.last_price_at })),
    products: pendingImpact(ctx),
  });
});
router.post('/cost/apply', wrap((req, res) => {
  const ctx = loadContext();
  const list = pendingIngredients(ctx);
  tx(() => {
    for (const g of list) {
      db.prepare('INSERT INTO price_history(ingredient_id,date,old_cost,new_cost) VALUES(?,?,?,?)').run(g.id, today(), g.cost, g.last_price);
      db.prepare('UPDATE ingredients SET cost=? WHERE id=?').run(g.last_price, g.id);
    }
  });
  res.json({ applied: list.length });
}));

/* --------------------------------------------------------------- products */
const cleanProduct = (b) => ({
  name_en: str(b.name_en, 100), name_ar: str(b.name_ar, 100), desc_en: str(b.desc_en, 600), desc_ar: str(b.desc_ar, 600),
  category: str(b.category, 40), category_ar: str(b.category_ar, 40),
  food_cost: numOrNull(b.food_cost), packaging: numOrNull(b.packaging), pieces_per_batch: numOrNull(b.pieces_per_batch),
  hours_per_batch: numOrNull(b.hours_per_batch), price: numOrNull(b.price), distribution: numOrNull(b.distribution), published: b.published ? 1 : 0,
});

function shape(p, ctx, impact) {
  const pc = productCost(p.id, ctx, false);
  return {
    ...p, published: !!p.published, source: pc.source, cost: pc.cost, batchCost: pc.batchCost, batchMaterials: pc.batchMaterials,
    pending: impact.get(p.id) || null, recipe_count: (ctx.recipes.get(p.id) || []).length,
  };
}

router.get('/products', (req, res) => {
  const ctx = loadContext();
  const impact = new Map(pendingImpact(ctx).map((x) => [x.id, x]));
  const rows = [...ctx.prods.values()].sort((a, b) => a.sort - b.sort || a.id - b.id).map((p) => shape(p, ctx, impact));
  res.json({ rows, overhead: overhead(ctx.settings), settings: ctx.settings, pendingCount: pendingIngredients(ctx).length });
});

router.get('/products/:id', wrap((req, res) => {
  const id = toId(req.params.id);
  const ctx = loadContext();
  const p = ctx.prods.get(id);
  if (!p) throw httpError(404, 'Not found');
  const impact = new Map(pendingImpact(ctx).map((x) => [x.id, x]));
  const pc = productCost(id, ctx, false);
  res.json({ product: shape(p, ctx, impact), parts: pc.parts, componentPerPiece: pc.componentPerPiece, foodPerPiece: pc.foodPerPiece, packPerPiece: pc.packPerPiece, settings: ctx.settings, overhead: overhead(ctx.settings) });
}));

router.post('/products', wrap((req, res) => {
  const p = cleanProduct(req.body || {});
  if (!p.name_en && !p.name_ar) throw httpError(400, 'Product name required');
  const sort = db.prepare('SELECT COALESCE(MAX(sort),0)+1 AS n FROM products').get().n;
  const r = db.prepare(`INSERT INTO products(name_en,name_ar,desc_en,desc_ar,category,category_ar,food_cost,packaging,pieces_per_batch,hours_per_batch,price,distribution,published,sort)
    VALUES(:name_en,:name_ar,:desc_en,:desc_ar,:category,:category_ar,:food_cost,:packaging,:pieces_per_batch,:hours_per_batch,:price,:distribution,:published,:sort)`).run({ ...p, sort });
  res.status(201).json({ id: Number(r.lastInsertRowid) });
}));

router.put('/products/:id', wrap((req, res) => {
  const id = toId(req.params.id);
  if (!db.prepare('SELECT 1 FROM products WHERE id=?').get(id)) throw httpError(404, 'Not found');
  const p = cleanProduct(req.body || {});
  if (!p.name_en && !p.name_ar) throw httpError(400, 'Product name required');
  db.prepare(`UPDATE products SET name_en=:name_en,name_ar=:name_ar,desc_en=:desc_en,desc_ar=:desc_ar,category=:category,category_ar=:category_ar,food_cost=:food_cost,packaging=:packaging,
    pieces_per_batch=:pieces_per_batch,hours_per_batch=:hours_per_batch,price=:price,distribution=:distribution,published=:published WHERE id=:id`).run({ ...p, id });
  res.json({ ok: true });
}));

router.delete('/products/:id', wrap((req, res) => {
  const id = toId(req.params.id);
  const p = db.prepare('SELECT image FROM products WHERE id=?').get(id);
  if (!p) throw httpError(404, 'Not found');
  const user = db.prepare('SELECT p.name_en, p.name_ar FROM recipe_lines l JOIN products p ON p.id=l.product_id WHERE l.component_id=? LIMIT 1').get(id);
  if (user) throw httpError(400, `It is used inside "${user.name_en || user.name_ar}", remove it from that recipe first`);
  tx(() => { db.prepare('DELETE FROM recipe_lines WHERE product_id=?').run(id); db.prepare('DELETE FROM products WHERE id=?').run(id); });
  removeUpload(p.image);
  res.json({ ok: true });
}));

// Replace a product's whole recipe. Quantities are for ONE BATCH, in the ingredient's own unit.
router.put('/products/:id/recipe', wrap((req, res) => {
  const id = toId(req.params.id);
  if (!db.prepare('SELECT 1 FROM products WHERE id=?').get(id)) throw httpError(404, 'Not found');
  const lines = (req.body || {}).lines;
  if (!Array.isArray(lines) || lines.length > 100) throw httpError(400, 'Bad recipe');
  const seen = new Set();
  const clean = lines.map((l) => {
    const qty = posNum(l.qty);
    if (l.ingredient_id) {
      const gid = toId(l.ingredient_id);
      if (!db.prepare('SELECT 1 FROM ingredients WHERE id=?').get(gid)) throw httpError(400, 'Unknown ingredient');
      if (seen.has(`i${gid}`)) throw httpError(400, 'Each ingredient can be listed once');
      seen.add(`i${gid}`);
      return { ingredient_id: gid, component_id: null, qty };
    }
    const cid = toId(l.component_id);
    if (!db.prepare('SELECT 1 FROM products WHERE id=?').get(cid)) throw httpError(400, 'Unknown product');
    if (cid === id || wouldLoop(id, cid)) throw httpError(400, 'A product cannot contain itself');
    if (seen.has(`p${cid}`)) throw httpError(400, 'Each product can be listed once');
    seen.add(`p${cid}`);
    return { ingredient_id: null, component_id: cid, qty };
  });
  tx(() => {
    db.prepare('DELETE FROM recipe_lines WHERE product_id=?').run(id);
    for (const l of clean) db.prepare('INSERT INTO recipe_lines(product_id,ingredient_id,component_id,qty) VALUES(?,?,?,?)').run(id, l.ingredient_id, l.component_id, l.qty);
  });
  res.json({ ok: true });
}));

function removeUpload(url) {
  if (!url || !url.startsWith('/uploads/')) return;
  fs.rm(path.join(DATA_DIR, 'uploads', path.basename(url)), { force: true }, () => {});
}
router.post('/products/:id/image', wrap((req, res) => {
  const id = toId(req.params.id);
  const p = db.prepare('SELECT image FROM products WHERE id=?').get(id);
  if (!p) throw httpError(404, 'Not found');
  const data = (req.body || {}).data;
  if (data === null || data === '') { db.prepare("UPDATE products SET image='' WHERE id=?").run(id); removeUpload(p.image); return res.json({ image: '' }); }
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(data || ''));
  if (!m) throw httpError(400, 'Image must be PNG, JPEG or WebP');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 2 * 1024 * 1024) throw httpError(400, 'Image is too large (max 2 MB)');
  const name = `${crypto.randomBytes(12).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  fs.writeFileSync(path.join(DATA_DIR, 'uploads', name), buf);
  db.prepare('UPDATE products SET image=? WHERE id=?').run(`/uploads/${name}`, id);
  removeUpload(p.image);
  res.json({ image: `/uploads/${name}` });
}));

module.exports = router;
