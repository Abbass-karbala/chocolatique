'use strict';
// Sales invoices and supplier purchases share one shape: a document with lines and payments.
const { db, tx } = require('./db');
const { httpError, str, numOrNull, numReq, posNum, reqDate, optId, toId, round2, today } = require('./util');
const { CHANNELS } = require('./calc');

const CFG = {
  sale: {
    docs: 'invoices', lines: 'invoice_lines', lineFk: 'invoice_id', fk: 'customer_id', party: 'customers',
    totalSql: 'COALESCE((SELECT SUM(l.qty*l.price) FROM invoice_lines l WHERE l.invoice_id=d.id),0)',
  },
  purchase: {
    docs: 'purchases', lines: 'purchase_lines', lineFk: 'purchase_id', fk: 'supplier_id', party: 'suppliers',
    totalSql: 'COALESCE((SELECT SUM(l.total) FROM purchase_lines l WHERE l.purchase_id=d.id),0)',
  },
};
const paidSql = (kind) => `COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.doc_type='${kind}' AND p.doc_id=d.id),0)`;

function listDocs(kind, where = '1=1', params = []) {
  const c = CFG[kind];
  return db.prepare(`SELECT d.*, pt.name AS party_name, ${c.totalSql} AS total, ${paidSql(kind)} AS paid
    FROM ${c.docs} d LEFT JOIN ${c.party} pt ON pt.id=d.${c.fk} WHERE ${where} ORDER BY d.date DESC, d.id DESC`)
    .all(...params).map((r) => ({ ...r, total: round2(r.total), paid: round2(r.paid), due: round2(r.total - r.paid) }));
}

function getDoc(kind, id) {
  const c = CFG[kind];
  const doc = listDocs(kind, 'd.id=?', [id])[0];
  if (!doc) throw httpError(404, 'Not found');
  doc.lines = kind === 'sale'
    ? db.prepare('SELECT * FROM invoice_lines WHERE invoice_id=? ORDER BY id').all(id)
    : db.prepare(`SELECT l.*, g.name_en, g.name_ar, g.unit FROM purchase_lines l JOIN ingredients g ON g.id=l.ingredient_id WHERE l.purchase_id=? ORDER BY l.id`).all(id);
  doc.payments = db.prepare('SELECT * FROM payments WHERE doc_type=? AND doc_id=? ORDER BY date, id').all(kind, id);
  doc.party = doc[c.fk] ? db.prepare(`SELECT * FROM ${c.party} WHERE id=?`).get(doc[c.fk]) : null;
  return doc;
}

// The latest purchase price of an ingredient (by purchase date) is what cost control compares against.
function refreshLastPrice(ingredientId) {
  const r = db.prepare(`SELECT l.total/l.qty AS p, d.date FROM purchase_lines l JOIN purchases d ON d.id=l.purchase_id
    WHERE l.ingredient_id=? AND l.qty>0 ORDER BY d.date DESC, d.id DESC, l.id DESC LIMIT 1`).get(ingredientId);
  db.prepare('UPDATE ingredients SET last_price=?, last_price_at=? WHERE id=?').run(r ? r.p : null, r ? r.date : null, ingredientId);
}

function cleanLines(kind, lines) {
  if (!Array.isArray(lines) || !lines.length || lines.length > 100) throw httpError(400, 'Add at least one line');
  return lines.map((l) => {
    if (kind === 'sale') {
      const pid = optId(l.product_id);
      let name = str(l.name, 100);
      if (pid) {
        const p = db.prepare('SELECT name_en,name_ar FROM products WHERE id=?').get(pid);
        if (!p) throw httpError(400, 'Unknown product');
        name = name || p.name_en || p.name_ar;
      }
      if (!name) throw httpError(400, 'Product required');
      return { product_id: pid, name, qty: posNum(l.qty), price: numReq(l.price) };
    }
    const iid = toId(l.ingredient_id);
    if (!db.prepare('SELECT 1 FROM ingredients WHERE id=?').get(iid)) throw httpError(400, 'Unknown ingredient');
    return { ingredient_id: iid, qty: posNum(l.qty), total: numReq(l.total) };
  });
}

function saveDoc(kind, docId, b) {
  const c = CFG[kind];
  const date = reqDate(b.date);
  const partyId = optId(b[c.fk]);
  if (kind === 'purchase' && !partyId) throw httpError(400, 'Supplier required');
  if (partyId && !db.prepare(`SELECT 1 FROM ${c.party} WHERE id=?`).get(partyId)) throw httpError(400, 'Unknown customer/supplier');
  const lines = cleanLines(kind, b.lines);
  const note = str(b.note, 300);
  let channel = 'Shop';
  if (kind === 'sale') { channel = CHANNELS.includes(b.channel) ? b.channel : (() => { throw httpError(400, 'Bad channel'); })(); }
  const initialPaid = docId ? 0 : (numOrNull(b.paid) ?? 0);

  return tx(() => {
    let id = docId;
    const touched = new Set();
    if (id) {
      if (kind === 'purchase') db.prepare('SELECT ingredient_id FROM purchase_lines WHERE purchase_id=?').all(id).forEach((r) => touched.add(r.ingredient_id));
      if (kind === 'sale') db.prepare('UPDATE invoices SET customer_id=?, date=?, channel=?, note=? WHERE id=?').run(partyId, date, channel, note, id);
      else db.prepare('UPDATE purchases SET supplier_id=?, date=?, note=? WHERE id=?').run(partyId, date, note, id);
      db.prepare(`DELETE FROM ${c.lines} WHERE ${c.lineFk}=?`).run(id);
    } else if (kind === 'sale') {
      id = Number(db.prepare('INSERT INTO invoices(customer_id,date,channel,note) VALUES(?,?,?,?)').run(partyId, date, channel, note).lastInsertRowid);
    } else {
      id = Number(db.prepare('INSERT INTO purchases(supplier_id,date,note) VALUES(?,?,?)').run(partyId, date, note).lastInsertRowid);
    }
    for (const l of lines) {
      if (kind === 'sale') db.prepare('INSERT INTO invoice_lines(invoice_id,product_id,name,qty,price) VALUES(?,?,?,?,?)').run(id, l.product_id, l.name, l.qty, l.price);
      else { db.prepare('INSERT INTO purchase_lines(purchase_id,ingredient_id,qty,total) VALUES(?,?,?,?)').run(id, l.ingredient_id, l.qty, l.total); touched.add(l.ingredient_id); }
    }
    const row = listDocs(kind, 'd.id=?', [id])[0];
    if (row.due < -0.005) throw httpError(400, 'Total is less than what was already paid');
    if (initialPaid > 0) addPayment(kind, id, { date, amount: initialPaid });
    if (kind === 'purchase') touched.forEach(refreshLastPrice);
    return id;
  });
}

function addPayment(kind, docId, b) {
  const doc = listDocs(kind, 'd.id=?', [docId])[0];
  if (!doc) throw httpError(404, 'Not found');
  const amount = posNum(b.amount);
  if (amount > doc.due + 0.005) throw httpError(400, 'More than the amount due');
  db.prepare('INSERT INTO payments(doc_type,doc_id,date,amount,note) VALUES(?,?,?,?,?)').run(kind, docId, reqDate(b.date || today()), amount, str(b.note, 200));
}

function deleteDoc(kind, id) {
  const c = CFG[kind];
  tx(() => {
    const touched = kind === 'purchase' ? db.prepare('SELECT ingredient_id FROM purchase_lines WHERE purchase_id=?').all(id).map((r) => r.ingredient_id) : [];
    db.prepare(`DELETE FROM ${c.lines} WHERE ${c.lineFk}=?`).run(id);
    db.prepare('DELETE FROM payments WHERE doc_type=? AND doc_id=?').run(kind, id);
    db.prepare(`DELETE FROM ${c.docs} WHERE id=?`).run(id);
    touched.forEach(refreshLastPrice);
  });
}

// Pay several open documents of one customer/supplier at once, oldest first.
function allocate(kind, partyId, b) {
  const c = CFG[kind];
  let left = posNum(b.amount);
  const date = reqDate(b.date || today());
  const open = listDocs(kind, `d.${c.fk}=?`, [partyId]).filter((d) => d.due > 0.005).sort((a, z) => (a.date < z.date ? -1 : a.date > z.date ? 1 : a.id - z.id));
  const totalDue = open.reduce((a, d) => a + d.due, 0);
  if (left > totalDue + 0.005) throw httpError(400, 'More than the amount due');
  tx(() => {
    for (const d of open) {
      if (left <= 0.004) break;
      const pay = Math.min(left, d.due);
      db.prepare('INSERT INTO payments(doc_type,doc_id,date,amount,note) VALUES(?,?,?,?,?)').run(kind, d.id, date, round2(pay), str(b.note, 200));
      left -= pay;
    }
  });
}

module.exports = { CFG, listDocs, getDoc, saveDoc, addPayment, deleteDoc, allocate, refreshLastPrice };
