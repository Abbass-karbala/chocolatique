'use strict';
const express = require('express');
const { db } = require('../lib/db');
const { listDocs, getDoc, saveDoc, addPayment, deleteDoc } = require('../lib/docs');
const { requireAdmin } = require('../lib/auth');
const { httpError, wrap, toId, isMonth, isDate, optId } = require('../lib/util');

function docRouter(kind) {
  const r = express.Router();
  const fk = kind === 'sale' ? 'customer_id' : 'supplier_id';

  r.get('/', wrap((req, res) => {
    const where = ['1=1'], params = [];
    const q = req.query;
    if (isMonth(q.month)) { where.push("substr(d.date,1,7)=?"); params.push(q.month); }
    if (isDate(q.from)) { where.push('d.date>=?'); params.push(q.from); }
    if (isDate(q.to)) { where.push('d.date<=?'); params.push(q.to); }
    const party = optId(q.party_id);
    if (party) { where.push(`d.${fk}=?`); params.push(party); }
    let rows = listDocs(kind, where.join(' AND '), params);
    if (q.status === 'unpaid') rows = rows.filter((d) => d.due > 0.005);
    res.json({ rows: rows.slice(0, 1000) });
  }));
  r.get('/:id', wrap((req, res) => res.json(getDoc(kind, toId(req.params.id)))));
  r.post('/', wrap((req, res) => res.status(201).json(getDoc(kind, saveDoc(kind, null, req.body || {})))));
  r.put('/:id', wrap((req, res) => { const id = toId(req.params.id); getDoc(kind, id); saveDoc(kind, id, req.body || {}); res.json(getDoc(kind, id)); }));
  r.delete('/:id', wrap((req, res) => { const id = toId(req.params.id); getDoc(kind, id); deleteDoc(kind, id); res.json({ ok: true }); }));
  r.post('/:id/payments', wrap((req, res) => { const id = toId(req.params.id); addPayment(kind, id, req.body || {}); res.json(getDoc(kind, id)); }));
  return r;
}

const sales = docRouter('sale');
const purchases = express.Router();
purchases.use(requireAdmin); // staff must not see supplier prices
purchases.use(docRouter('purchase'));

// Remove one payment (purchase payments are admin-only).
const payments = express.Router();
payments.delete('/:id', wrap((req, res) => {
  const p = db.prepare('SELECT * FROM payments WHERE id=?').get(toId(req.params.id));
  if (!p) throw httpError(404, 'Not found');
  if (p.doc_type === 'purchase' && req.user.role !== 'admin') throw httpError(403, 'Admins only');
  db.prepare('DELETE FROM payments WHERE id=?').run(p.id);
  res.json({ ok: true });
}));

module.exports = { sales, purchases, payments };
