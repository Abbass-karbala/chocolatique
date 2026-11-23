'use strict';
// Dashboard, monthly summary, expenses, and the generic report engine.
const express = require('express');
const { db } = require('../lib/db');
const { getSettings } = require('../lib/settings');
const { loadContext, productCost, pendingIngredients } = require('../lib/cost');
const { monthly, prevMonth, EXPENSE_CATEGORIES } = require('../lib/calc');
const { httpError, today, isDate, isMonth, str, numOrNull, numReq, reqDate, toId, round2, wrap } = require('../lib/util');
const { listDocs } = require('../lib/docs');

const adminOnly = express.Router();   // mounted behind requireAdmin
const shared = express.Router();      // dashboard: both roles

/* -------------------------------------------------------------- dashboard */
shared.get('/dashboard', (req, res) => {
  const admin = req.user.role === 'admin';
  const t = today(), month = t.slice(0, 7);
  const sum = (sql, ...p) => round2(db.prepare(sql).get(...p).v || 0);
  const out = {
    role: req.user.role,
    newOrders: db.prepare("SELECT COUNT(*) AS c FROM orders WHERE status='new'").get().c,
    salesToday: sum("SELECT SUM(l.qty*l.price) AS v FROM invoice_lines l JOIN invoices d ON d.id=l.invoice_id WHERE d.date=?", t),
    salesMonth: sum("SELECT SUM(l.qty*l.price) AS v FROM invoice_lines l JOIN invoices d ON d.id=l.invoice_id WHERE substr(d.date,1,7)=?", month),
    recentInvoices: listDocs('sale', '1=1').slice(0, 6),
  };
  const sales = listDocs('sale');
  out.customersOwe = round2(sales.reduce((a, d) => a + Math.max(d.due, 0), 0));
  out.unpaidInvoices = sales.filter((d) => d.due > 0.005).length;
  if (admin) {
    const purchases = listDocs('purchase');
    out.weOwe = round2(purchases.reduce((a, d) => a + Math.max(d.due, 0), 0));
    out.unpaidPurchases = purchases.filter((d) => d.due > 0.005).length;
    out.pendingCost = pendingIngredients(loadContext()).length;
    out.expensesMonth = sum('SELECT SUM(amount) AS v FROM expenses WHERE substr(date,1,7)=?', month);
    out.purchasesMonth = sum("SELECT SUM(l.total) AS v FROM purchase_lines l JOIN purchases d ON d.id=l.purchase_id WHERE substr(d.date,1,7)=?", month);
    out.topProducts = db.prepare(`SELECT l.name, SUM(l.qty) AS qty, SUM(l.qty*l.price) AS revenue FROM invoice_lines l JOIN invoices d ON d.id=l.invoice_id
      WHERE substr(d.date,1,7)=? GROUP BY l.name ORDER BY revenue DESC LIMIT 5`).all(month);
  }
  res.json(out);
});

/* ---------------------------------------------------------------- expenses */
const cleanExpense = (b) => {
  if (!EXPENSE_CATEGORIES.includes(b.category)) throw httpError(400, 'Bad category');
  return { date: reqDate(b.date), description: str(b.description, 120), category: b.category, amount: numReq(b.amount), note: str(b.note, 300) };
};
adminOnly.get('/expenses', (req, res) => {
  const { from, to } = req.query;
  const w = [], p = [];
  if (isDate(from)) { w.push('date>=?'); p.push(from); }
  if (isDate(to)) { w.push('date<=?'); p.push(to); }
  const rows = db.prepare(`SELECT * FROM expenses ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY date DESC, id DESC LIMIT 1000`).all(...p);
  res.json({ rows, categories: EXPENSE_CATEGORIES, total: round2(rows.reduce((a, r) => a + r.amount, 0)) });
});
adminOnly.post('/expenses', wrap((req, res) => {
  const e = cleanExpense(req.body || {});
  const r = db.prepare('INSERT INTO expenses(date,description,category,amount,note) VALUES(:date,:description,:category,:amount,:note)').run(e);
  res.status(201).json(db.prepare('SELECT * FROM expenses WHERE id=?').get(Number(r.lastInsertRowid)));
}));
adminOnly.put('/expenses/:id', wrap((req, res) => {
  const id = toId(req.params.id);
  if (!db.prepare('SELECT 1 FROM expenses WHERE id=?').get(id)) throw httpError(404, 'Not found');
  db.prepare('UPDATE expenses SET date=:date,description=:description,category=:category,amount=:amount,note=:note WHERE id=:id').run({ ...cleanExpense(req.body || {}), id });
  res.json(db.prepare('SELECT * FROM expenses WHERE id=?').get(id));
}));
adminOnly.delete('/expenses/:id', wrap((req, res) => { db.prepare('DELETE FROM expenses WHERE id=?').run(toId(req.params.id)); res.json({ ok: true }); }));

/* ----------------------------------------------------------------- monthly */
const INPUT_FIELDS = ['cash_start', 'stock_start', 'stock_end', 'hours', 'pieces_made', 'pieces_wasted', 'pay_taken', 'equipment_life'];
const DEFAULT_INPUTS = { cash_start: 0, stock_start: 0, stock_end: 0, hours: 0, pieces_made: 0, pieces_wasted: 0, pay_taken: 0, equipment_life: 12 };

function monthlyArgs(month, inputs) {
  const settings = getSettings();
  const ctx = loadContext();
  const costById = {};
  for (const p of ctx.prods.values()) { const c = productCost(p.id, ctx, false); costById[p.id] = c && c.cost ? c.cost.total : null; }
  const sales = db.prepare('SELECT d.date, d.channel, l.product_id, l.qty AS pieces, l.price FROM invoice_lines l JOIN invoices d ON d.id=l.invoice_id').all();
  const pay = (kind) => db.prepare('SELECT date, amount FROM payments WHERE doc_type=?').all(kind);
  const materials = { Ingredients: 0, Packaging: 0 };
  for (const r of db.prepare(`SELECT g.kind, SUM(l.total) AS v FROM purchase_lines l JOIN purchases d ON d.id=l.purchase_id JOIN ingredients g ON g.id=l.ingredient_id
    WHERE substr(d.date,1,7)=? GROUP BY g.kind`).all(month)) materials[r.kind === 'packaging' ? 'Packaging' : 'Ingredients'] = r.v || 0;
  const owed = listDocs('sale').reduce((a, d) => a + Math.max(d.due, 0), 0);
  const payable = listDocs('purchase').reduce((a, d) => a + Math.max(d.due, 0), 0);
  return { month, inputs, settings, sales, receipts: pay('sale'), supplierPayments: pay('purchase'), materials, expenses: db.prepare('SELECT * FROM expenses').all(), owed, payable, costById };
}
function buildMonthly(month) {
  let row = db.prepare('SELECT * FROM monthly_inputs WHERE month=?').get(month);
  const saved = !!row;
  if (!row) {
    row = { ...DEFAULT_INPUTS };
    const pm = prevMonth(month), prev = db.prepare('SELECT * FROM monthly_inputs WHERE month=?').get(pm);
    if (prev) {
      const pr = monthly(monthlyArgs(pm, prev));
      row.stock_start = prev.stock_end; row.cash_start = pr.cash.end; row.equipment_life = prev.equipment_life;
    }
  }
  return { ...monthly(monthlyArgs(month, row)), saved };
}
adminOnly.get('/monthly', wrap((req, res) => res.json(buildMonthly(isMonth(req.query.month) ? req.query.month : today().slice(0, 7)))));
adminOnly.put('/monthly/:month', wrap((req, res) => {
  const month = req.params.month;
  if (!isMonth(month)) throw httpError(400, 'Bad month');
  const b = req.body || {};
  const v = Object.fromEntries(INPUT_FIELDS.map((k) => [k, numOrNull(b[k]) ?? 0]));
  db.prepare(`INSERT INTO monthly_inputs(month,${INPUT_FIELDS.join(',')}) VALUES(:month,${INPUT_FIELDS.map((k) => ':' + k).join(',')})
    ON CONFLICT(month) DO UPDATE SET ${INPUT_FIELDS.map((k) => `${k}=excluded.${k}`).join(',')}`).run({ month, ...v });
  res.json(buildMonthly(month));
}));

/* ----------------------------------------------------------- report engine */
// Column: {key,label,type:'text'|'money'|'num'|'date'|'pct', tr?:prefix for translated cells, sum?:bool}
const col = (key, label, type = 'text', extra = {}) => ({ key, label, type, ...extra });
const GROUPS = {
  sales: ['invoice', 'product', 'customer', 'channel', 'month', 'day'],
  purchases: ['invoice', 'supplier', 'ingredient', 'month', 'day'],
  expenses: ['category', 'month', 'day', 'list'],
};
const WALKIN = 'Walk-in';

function range(q) {
  const from = isDate(q.from) ? q.from : '0000-01-01';
  const to = isDate(q.to) ? q.to : '9999-12-31';
  return { from, to };
}
function finish(title, columns, rows, summary = []) {
  const totals = {};
  for (const c of columns) if (c.sum) totals[c.key] = round2(rows.reduce((a, r) => a + (Number(r[c.key]) || 0), 0));
  return { title, columns, rows, totals, summary };
}
const groupRows = (rows, keyFn, init, add) => {
  const m = new Map();
  for (const r of rows) { const k = keyFn(r); if (!m.has(k)) m.set(k, init(k)); add(m.get(k), r); }
  return [...m.values()];
};

function saleLines(from, to) {
  return db.prepare(`SELECT d.id AS invoice, d.date, d.channel, d.customer_id, COALESCE(c.name,?) AS customer, l.product_id, l.name AS product, l.qty, l.price, l.qty*l.price AS amount
    FROM invoice_lines l JOIN invoices d ON d.id=l.invoice_id LEFT JOIN customers c ON c.id=d.customer_id WHERE d.date BETWEEN ? AND ? ORDER BY d.date, d.id`).all(WALKIN, from, to);
}
function purchaseLines(from, to) {
  return db.prepare(`SELECT d.id AS invoice, d.date, d.supplier_id, COALESCE(s.name,'-') AS supplier, g.id AS ingredient_id, COALESCE(NULLIF(g.name_en,''),g.name_ar) AS ingredient, g.unit, g.kind, l.qty, l.total AS amount
    FROM purchase_lines l JOIN purchases d ON d.id=l.purchase_id LEFT JOIN suppliers s ON s.id=d.supplier_id JOIN ingredients g ON g.id=l.ingredient_id
    WHERE d.date BETWEEN ? AND ? ORDER BY d.date, d.id`).all(from, to);
}

const REPORTS = {
  sales(q) {
    const { from, to } = range(q);
    const group = GROUPS.sales.includes(q.group) ? q.group : 'product';
    const lines = saleLines(from, to);
    let columns, rows;
    if (group === 'invoice') {
      rows = listDocs('sale', 'd.date BETWEEN ? AND ?', [from, to]).map((d) => ({ date: d.date, invoice: d.id, customer: d.party_name || WALKIN, channel: d.channel, total: d.total, paid: d.paid, due: d.due }));
      columns = [col('date', 'date', 'date'), col('invoice', 'invoice_no', 'text', { link: 'sale' }), col('customer', 'customer'), col('channel', 'channel', 'text', { tr: 'ch_' }), col('total', 'total', 'money', { sum: true }), col('paid', 'paid', 'money', { sum: true }), col('due', 'due', 'money', { sum: true })];
    } else {
      const keys = { product: (r) => r.product, customer: (r) => r.customer, channel: (r) => r.channel, month: (r) => r.date.slice(0, 7), day: (r) => r.date };
      const inv = new Map();
      rows = groupRows(lines, keys[group], (k) => ({ name: k, qty: 0, invoices: 0, amount: 0, _s: new Set() }), (g, r) => { g.qty += r.qty; g.amount += r.amount; g._s.add(r.invoice); });
      rows = rows.map((g) => ({ name: g.name, qty: g.qty, invoices: g._s.size, amount: round2(g.amount), avg: g.qty ? round2(g.amount / g.qty) : 0 }));
      rows.sort(group === 'month' || group === 'day' ? (a, b) => a.name.localeCompare(b.name) : (a, b) => b.amount - a.amount);
      void inv;
      columns = [col('name', group, 'text', group === 'channel' ? { tr: 'ch_' } : {}), col('qty', 'qty', 'num', { sum: true }), col('invoices', 'invoices', 'num', { sum: true }), col('amount', 'sales', 'money', { sum: true }), col('avg', 'avg_price', 'money')];
    }
    return finish('r_sales', columns, rows);
  },

  purchases(q) {
    const { from, to } = range(q);
    const group = GROUPS.purchases.includes(q.group) ? q.group : 'supplier';
    let columns, rows;
    if (group === 'invoice') {
      rows = listDocs('purchase', 'd.date BETWEEN ? AND ?', [from, to]).map((d) => ({ date: d.date, invoice: d.id, supplier: d.party_name || '-', total: d.total, paid: d.paid, due: d.due }));
      columns = [col('date', 'date', 'date'), col('invoice', 'invoice_no', 'text', { link: 'purchase' }), col('supplier', 'supplier'), col('total', 'total', 'money', { sum: true }), col('paid', 'paid', 'money', { sum: true }), col('due', 'due', 'money', { sum: true })];
    } else {
      const lines = purchaseLines(from, to);
      const keys = { supplier: (r) => r.supplier, ingredient: (r) => r.ingredient, month: (r) => r.date.slice(0, 7), day: (r) => r.date };
      rows = groupRows(lines, keys[group], (k) => ({ name: k, qty: 0, amount: 0, _s: new Set() }), (g, r) => { g.qty += r.qty; g.amount += r.amount; g._s.add(r.invoice); })
        .map((g) => ({ name: g.name, invoices: g._s.size, qty: group === 'ingredient' ? g.qty : null, amount: round2(g.amount) }));
      rows.sort(group === 'month' || group === 'day' ? (a, b) => a.name.localeCompare(b.name) : (a, b) => b.amount - a.amount);
      columns = [col('name', group), col('invoices', 'invoices', 'num', { sum: true })];
      if (group === 'ingredient') columns.push(col('qty', 'qty', 'num'));
      columns.push(col('amount', 'purchases', 'money', { sum: true }));
    }
    return finish('r_purchases', columns, rows);
  },

  customers() {
    const rows = db.prepare(`SELECT c.id, c.name, c.phone FROM customers c ORDER BY c.name COLLATE NOCASE`).all().map((c) => {
      const docs = listDocs('sale', 'd.customer_id=?', [c.id]);
      return { id: c.id, name: c.name, phone: c.phone, invoices: docs.length, invoiced: round2(docs.reduce((a, d) => a + d.total, 0)), paid: round2(docs.reduce((a, d) => a + d.paid, 0)), due: round2(docs.reduce((a, d) => a + d.due, 0)), last: docs.length ? docs[0].date : '' };
    });
    rows.sort((a, b) => b.due - a.due || b.invoiced - a.invoiced);
    return finish('r_customers', [col('name', 'customer', 'text', { link: 'customer', idKey: 'id' }), col('phone', 'phone'), col('invoices', 'invoices', 'num', { sum: true }), col('invoiced', 'invoiced', 'money', { sum: true }), col('paid', 'paid', 'money', { sum: true }), col('due', 'balance', 'money', { sum: true }), col('last', 'last_invoice', 'date')], rows);
  },

  suppliers() {
    const rows = db.prepare('SELECT id, name, phone FROM suppliers ORDER BY name COLLATE NOCASE').all().map((c) => {
      const docs = listDocs('purchase', 'd.supplier_id=?', [c.id]);
      return { id: c.id, name: c.name, phone: c.phone, invoices: docs.length, invoiced: round2(docs.reduce((a, d) => a + d.total, 0)), paid: round2(docs.reduce((a, d) => a + d.paid, 0)), due: round2(docs.reduce((a, d) => a + d.due, 0)), last: docs.length ? docs[0].date : '' };
    });
    rows.sort((a, b) => b.due - a.due || b.invoiced - a.invoiced);
    return finish('r_suppliers', [col('name', 'supplier', 'text', { link: 'supplier', idKey: 'id' }), col('phone', 'phone'), col('invoices', 'purchases_n', 'num', { sum: true }), col('invoiced', 'invoiced', 'money', { sum: true }), col('paid', 'paid', 'money', { sum: true }), col('due', 'balance', 'money', { sum: true }), col('last', 'last_purchase', 'date')], rows);
  },

  goods(q) {
    const { from, to } = range(q);
    const rows = db.prepare('SELECT * FROM ingredients ORDER BY kind, COALESCE(NULLIF(name_en,\'\'),name_ar) COLLATE NOCASE').all().map((g) => {
      const p = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(l.qty),0) AS qty, COALESCE(SUM(l.total),0) AS spend, MIN(l.total/l.qty) AS lo, MAX(l.total/l.qty) AS hi
        FROM purchase_lines l JOIN purchases d ON d.id=l.purchase_id WHERE l.ingredient_id=? AND l.qty>0 AND d.date BETWEEN ? AND ?`).get(g.id, from, to);
      const first = db.prepare(`SELECT l.total/l.qty AS p FROM purchase_lines l JOIN purchases d ON d.id=l.purchase_id WHERE l.ingredient_id=? AND l.qty>0 AND d.date BETWEEN ? AND ? ORDER BY d.date, d.id LIMIT 1`).get(g.id, from, to);
      const last = db.prepare(`SELECT l.total/l.qty AS p FROM purchase_lines l JOIN purchases d ON d.id=l.purchase_id WHERE l.ingredient_id=? AND l.qty>0 AND d.date BETWEEN ? AND ? ORDER BY d.date DESC, d.id DESC LIMIT 1`).get(g.id, from, to);
      const change = first && last && first.p > 0 ? (last.p - first.p) / first.p : null;
      return { name: g.name_en || g.name_ar, unit: g.unit, kind: g.kind, cost: g.cost, last_price: g.last_price, purchases: p.n, qty: p.qty, spend: round2(p.spend), lo: p.lo, hi: p.hi, change };
    });
    return finish('r_goods', [col('name', 'ingredient'), col('unit', 'unit'), col('cost', 'cost_control_price', 'money4'), col('last_price', 'last_price', 'money4'), col('purchases', 'purchases_n', 'num', { sum: true }), col('qty', 'qty', 'num'), col('lo', 'lowest', 'money4'), col('hi', 'highest', 'money4'), col('change', 'change', 'pct'), col('spend', 'spent', 'money', { sum: true })], rows);
  },

  profit(q) {
    const { from, to } = range(q);
    const ctx = loadContext();
    const rows = groupRows(saleLines(from, to), (r) => r.product_id || `n:${r.product}`, (k) => ({ pid: typeof k === 'number' ? k : null, name: '', qty: 0, revenue: 0 }), (g, r) => { g.name = r.product; g.qty += r.qty; g.revenue += r.amount; })
      .map((g) => {
        const pc = g.pid ? productCost(g.pid, ctx, false) : null;
        const unit = pc && pc.cost ? pc.cost.total : null;
        const cost = unit === null ? null : round2(unit * g.qty);
        const profit = cost === null ? null : round2(g.revenue - cost);
        return { name: g.name, qty: g.qty, revenue: round2(g.revenue), unit_cost: unit, cost, profit, margin: profit !== null && g.revenue > 0 ? profit / g.revenue : null };
      }).sort((a, b) => (b.profit ?? -1e9) - (a.profit ?? -1e9));
    const res = finish('r_profit', [col('name', 'product'), col('qty', 'qty', 'num', { sum: true }), col('revenue', 'sales', 'money', { sum: true }), col('unit_cost', 'unit_cost', 'money'), col('cost', 'cost', 'money', { sum: true }), col('profit', 'profit', 'money', { sum: true }), col('margin', 'margin', 'pct')], rows);
    res.totals.margin = res.totals.revenue > 0 && res.totals.profit !== undefined ? res.totals.profit / res.totals.revenue : null;
    res.note = 'profit_note';
    return res;
  },

  netprofit(q) {
    const { from, to } = range(q);
    const sales = db.prepare('SELECT COALESCE(SUM(l.qty*l.price),0) AS v FROM invoice_lines l JOIN invoices d ON d.id=l.invoice_id WHERE d.date BETWEEN ? AND ?').get(from, to).v;
    const mats = {};
    for (const r of db.prepare(`SELECT g.kind, SUM(l.total) AS v FROM purchase_lines l JOIN purchases d ON d.id=l.purchase_id JOIN ingredients g ON g.id=l.ingredient_id WHERE d.date BETWEEN ? AND ? GROUP BY g.kind`).all(from, to)) mats[r.kind] = r.v;
    const exp = db.prepare('SELECT category, SUM(amount) AS v FROM expenses WHERE date BETWEEN ? AND ? GROUP BY category').all(from, to);
    const rows = [{ line: 'income_sales', amount: round2(sales), bold: true }];
    const gross = sales - (mats.ingredient || 0) - (mats.packaging || 0);
    rows.push({ line: 'Ingredients', amount: -round2(mats.ingredient || 0), tr: 'cat_' }, { line: 'Packaging', amount: -round2(mats.packaging || 0), tr: 'cat_' }, { line: 'gross_profit', amount: round2(gross), bold: true });
    let totalExp = 0;
    for (const e of exp) { rows.push({ line: e.category, amount: -round2(e.v), tr: 'cat_' }); totalExp += e.v; }
    rows.push({ line: 'net_profit', amount: round2(gross - totalExp), bold: true });
    const r = finish('r_netprofit', [col('line', 'line', 'text', { tr: 'row' }), col('amount', 'amount', 'money')], rows);
    r.summary = [{ key: 'net_profit', value: round2(gross - totalExp), type: 'money' }, { key: 'margin', value: sales > 0 ? (gross - totalExp) / sales : 0, type: 'pct' }];
    r.note = 'netprofit_note';
    return r;
  },

  expenses(q) {
    const { from, to } = range(q);
    const group = GROUPS.expenses.includes(q.group) ? q.group : 'category';
    const list = db.prepare('SELECT * FROM expenses WHERE date BETWEEN ? AND ? ORDER BY date, id').all(from, to);
    if (group === 'list') return finish('r_expenses', [col('date', 'date', 'date'), col('category', 'category', 'text', { tr: 'cat_' }), col('description', 'description'), col('amount', 'amount', 'money', { sum: true })], list);
    const keys = { category: (r) => r.category, month: (r) => r.date.slice(0, 7), day: (r) => r.date };
    const rows = groupRows(list, keys[group], (k) => ({ name: k, count: 0, amount: 0 }), (g, r) => { g.count++; g.amount += r.amount; }).map((g) => ({ ...g, amount: round2(g.amount) }));
    rows.sort(group === 'category' ? (a, b) => b.amount - a.amount : (a, b) => a.name.localeCompare(b.name));
    return finish('r_expenses', [col('name', group, 'text', group === 'category' ? { tr: 'cat_' } : {}), col('count', 'count', 'num', { sum: true }), col('amount', 'amount', 'money', { sum: true })], rows);
  },

  income(q) {
    const { from, to } = range(q);
    const rows = db.prepare(`SELECT p.date, p.amount, p.note, d.id AS invoice, COALESCE(c.name,?) AS customer FROM payments p JOIN invoices d ON d.id=p.doc_id AND p.doc_type='sale'
      LEFT JOIN customers c ON c.id=d.customer_id WHERE p.date BETWEEN ? AND ? ORDER BY p.date, p.id`).all(WALKIN, from, to);
    return finish('r_income', [col('date', 'date', 'date'), col('customer', 'customer'), col('invoice', 'invoice_no', 'text', { link: 'sale' }), col('note', 'note'), col('amount', 'received', 'money', { sum: true })], rows);
  },

  cashflow(q) {
    const { from, to } = range(q);
    const m = new Map();
    const bump = (date, k, v) => { const key = date.slice(0, 7); if (!m.has(key)) m.set(key, { month: key, inflow: 0, suppliers: 0, expenses: 0 }); m.get(key)[k] += v; };
    for (const p of db.prepare('SELECT date, amount, doc_type FROM payments WHERE date BETWEEN ? AND ?').all(from, to)) bump(p.date, p.doc_type === 'sale' ? 'inflow' : 'suppliers', p.amount);
    for (const e of db.prepare('SELECT date, amount FROM expenses WHERE date BETWEEN ? AND ?').all(from, to)) bump(e.date, 'expenses', e.amount);
    let run = 0;
    const rows = [...m.values()].sort((a, b) => a.month.localeCompare(b.month)).map((r) => { const net = r.inflow - r.suppliers - r.expenses; run += net; return { month: r.month, inflow: round2(r.inflow), suppliers: round2(r.suppliers), expenses: round2(r.expenses), net: round2(net), running: round2(run) }; });
    return finish('r_cashflow', [col('month', 'month'), col('inflow', 'cash_in', 'money', { sum: true }), col('suppliers', 'paid_suppliers', 'money', { sum: true }), col('expenses', 'expenses', 'money', { sum: true }), col('net', 'net', 'money', { sum: true }), col('running', 'running', 'money')], rows);
  },

  aging(q) {
    const kind = q.kind === 'purchase' ? 'purchase' : 'sale';
    const t = Date.parse(today());
    const buckets = new Map();
    for (const d of listDocs(kind, '1=1')) {
      if (d.due <= 0.005) continue;
      const key = d.party_name || (kind === 'sale' ? WALKIN : '-');
      if (!buckets.has(key)) buckets.set(key, { name: key, b0: 0, b30: 0, b60: 0, b90: 0, due: 0 });
      const age = Math.floor((t - Date.parse(d.date)) / 86400000), b = buckets.get(key);
      b[age <= 30 ? 'b0' : age <= 60 ? 'b30' : age <= 90 ? 'b60' : 'b90'] += d.due; b.due += d.due;
    }
    const rows = [...buckets.values()].map((b) => ({ name: b.name, b0: round2(b.b0), b30: round2(b.b30), b60: round2(b.b60), b90: round2(b.b90), due: round2(b.due) })).sort((a, b) => b.due - a.due);
    return finish(kind === 'sale' ? 'r_aging_sales' : 'r_aging_purchases', [col('name', kind === 'sale' ? 'customer' : 'supplier'), col('b0', 'age_0_30', 'money', { sum: true }), col('b30', 'age_31_60', 'money', { sum: true }), col('b60', 'age_61_90', 'money', { sum: true }), col('b90', 'age_90', 'money', { sum: true }), col('due', 'balance', 'money', { sum: true })], rows);
  },

  journal(q) {
    const { from, to } = range(q);
    const rows = [];
    for (const d of listDocs('sale', 'd.date BETWEEN ? AND ?', [from, to])) rows.push({ date: d.date, ord: 1, type: 'j_sale', ref: `#${d.id}`, party: d.party_name || WALKIN, debit: d.total, credit: 0 });
    for (const p of db.prepare(`SELECT p.date, p.amount, d.id, COALESCE(c.name,?) AS party FROM payments p JOIN invoices d ON d.id=p.doc_id AND p.doc_type='sale' LEFT JOIN customers c ON c.id=d.customer_id WHERE p.date BETWEEN ? AND ?`).all(WALKIN, from, to))
      rows.push({ date: p.date, ord: 2, type: 'j_receipt', ref: `#${p.id}`, party: p.party, debit: 0, credit: p.amount });
    for (const d of listDocs('purchase', 'd.date BETWEEN ? AND ?', [from, to])) rows.push({ date: d.date, ord: 3, type: 'j_purchase', ref: `#${d.id}`, party: d.party_name || '-', debit: 0, credit: d.total });
    for (const p of db.prepare(`SELECT p.date, p.amount, d.id, COALESCE(s.name,'-') AS party FROM payments p JOIN purchases d ON d.id=p.doc_id AND p.doc_type='purchase' LEFT JOIN suppliers s ON s.id=d.supplier_id WHERE p.date BETWEEN ? AND ?`).all(from, to))
      rows.push({ date: p.date, ord: 4, type: 'j_payment', ref: `#${p.id}`, party: p.party, debit: p.amount, credit: 0 });
    for (const e of db.prepare('SELECT * FROM expenses WHERE date BETWEEN ? AND ?').all(from, to)) rows.push({ date: e.date, ord: 5, type: 'j_expense', ref: e.category, party: e.description, debit: 0, credit: e.amount });
    rows.sort((a, b) => a.date.localeCompare(b.date) || a.ord - b.ord);
    // Money view: + money in, - money out. Invoices are shown but do not move cash until they are paid.
    const out = rows.map((r) => ({ date: r.date, type: r.type, ref: r.ref, party: r.party, amount: r.type === 'j_sale' || r.type === 'j_purchase' ? r.debit || r.credit : r.type === 'j_receipt' ? r.credit : r.type === 'j_payment' ? -r.debit : -r.credit, cash: r.type === 'j_receipt' || r.type === 'j_payment' || r.type === 'j_expense' }));
    return finish('r_journal', [col('date', 'date', 'date'), col('type', 'type', 'text', { tr: '' }), col('ref', 'ref'), col('party', 'party'), col('amount', 'amount', 'money')], out);
  },
};


adminOnly.get('/reports/:name', wrap((req, res) => {
  const fn = REPORTS[req.params.name];
  if (!fn) throw httpError(404, 'Unknown report');
  res.json(fn(req.query));
}));

// Statements: every invoice and payment for one customer / supplier, with a running balance.
function statement(kind, id, q) {
  const cfg = kind === 'sale' ? { party: 'customers', fk: 'customer_id' } : { party: 'suppliers', fk: 'supplier_id' };
  const party = db.prepare(`SELECT * FROM ${cfg.party} WHERE id=?`).get(id);
  if (!party) throw httpError(404, 'Not found');
  const { from, to } = range(q);
  const docs = listDocs(kind, `d.${cfg.fk}=?`, [id]);
  const ev = [];
  for (const d of docs) {
    ev.push({ date: d.date, ord: 0, ref: `#${d.id}`, kind: 'doc', docId: d.id, charge: d.total, pay: 0 });
    for (const p of db.prepare("SELECT * FROM payments WHERE doc_type=? AND doc_id=?").all(kind, d.id)) ev.push({ date: p.date, ord: 1, ref: `#${d.id}`, kind: 'payment', docId: d.id, charge: 0, pay: p.amount, note: p.note });
  }
  ev.sort((a, b) => a.date.localeCompare(b.date) || a.ord - b.ord);
  let bal = 0;
  const all = ev.map((e) => { bal += e.charge - e.pay; return { ...e, balance: round2(bal) }; });
  const opening = round2(all.filter((e) => e.date < from).reduce((a, e) => a + e.charge - e.pay, 0));
  const rows = all.filter((e) => e.date >= from && e.date <= to);
  return { party, from: from === '0000-01-01' ? '' : from, to: to === '9999-12-31' ? '' : to, opening, rows, closing: round2(bal), kind };
}
adminOnly.get('/statement/customer/:id', wrap((req, res) => res.json(statement('sale', toId(req.params.id), req.query))));
adminOnly.get('/statement/supplier/:id', wrap((req, res) => res.json(statement('purchase', toId(req.params.id), req.query))));

module.exports = { shared, adminOnly };
