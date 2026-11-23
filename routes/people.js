'use strict';
// Customers and suppliers: one tiny contact card + the balance of their invoices.
const express = require('express');
const { db } = require('../lib/db');
const { CFG, listDocs, allocate } = require('../lib/docs');
const { httpError, str, wrap, toId, round2 } = require('../lib/util');

function partyRouter(kind, table) {
  const r = express.Router();
  const fk = CFG[kind].fk;

  const totalsByParty = () => {
    const m = new Map();
    for (const d of listDocs(kind)) {
      const k = d[fk];
      if (!k) continue;
      const t = m.get(k) || { invoiced: 0, paid: 0, due: 0, count: 0, last: null };
      t.invoiced += d.total; t.paid += d.paid; t.due += d.due; t.count += 1;
      if (!t.last || d.date > t.last) t.last = d.date;
      m.set(k, t);
    }
    return m;
  };
  const empty = { invoiced: 0, paid: 0, due: 0, count: 0, last: null };
  const clean = (b) => {
    const name = str(b.name, 100);
    if (!name) throw httpError(400, 'Name required');
    return { name, phone: str(b.phone, 30), address: str(b.address, 300), notes: str(b.notes, 500) };
  };

  r.get('/', (req, res) => {
    const m = totalsByParty();
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY name COLLATE NOCASE`).all().map((p) => {
      const t = m.get(p.id) || empty;
      return { ...p, invoiced: round2(t.invoiced), paid: round2(t.paid), due: round2(t.due), count: t.count, last: t.last };
    });
    res.json({ rows, totalDue: round2(rows.reduce((a, p) => a + p.due, 0)) });
  });

  r.get('/:id', wrap((req, res) => {
    const id = toId(req.params.id);
    const party = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
    if (!party) throw httpError(404, 'Not found');
    const t = totalsByParty().get(id) || empty;
    res.json({ party, docs: listDocs(kind, `d.${fk}=?`, [id]), totals: { invoiced: round2(t.invoiced), paid: round2(t.paid), due: round2(t.due), count: t.count } });
  }));

  r.post('/', wrap((req, res) => {
    const c = clean(req.body || {});
    const x = db.prepare(`INSERT INTO ${table}(name,phone,address,notes,created_at) VALUES(?,?,?,?,?)`).run(c.name, c.phone, c.address, c.notes, new Date().toISOString());
    res.status(201).json(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(Number(x.lastInsertRowid)));
  }));

  r.put('/:id', wrap((req, res) => {
    const id = toId(req.params.id);
    if (!db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(id)) throw httpError(404, 'Not found');
    const c = clean(req.body || {});
    db.prepare(`UPDATE ${table} SET name=?, phone=?, address=?, notes=? WHERE id=?`).run(c.name, c.phone, c.address, c.notes, id);
    res.json(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id));
  }));

  r.delete('/:id', wrap((req, res) => {
    const id = toId(req.params.id);
    if (db.prepare(`SELECT 1 FROM ${CFG[kind].docs} WHERE ${fk}=?`).get(id)) throw httpError(400, 'This one has invoices, so it cannot be deleted');
    db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
    res.json({ ok: true });
  }));

  // One payment spread over the oldest unpaid invoices.
  r.post('/:id/pay', wrap((req, res) => {
    const id = toId(req.params.id);
    if (!db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(id)) throw httpError(404, 'Not found');
    allocate(kind, id, req.body || {});
    res.json({ ok: true });
  }));
  return r;
}

module.exports = { customers: partyRouter('sale', 'customers'), suppliers: partyRouter('purchase', 'suppliers') };
