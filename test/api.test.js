'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'choc-'));
const app = require('../server.js');

let base, server;
test.before(() => new Promise((r) => { server = app.listen(0, () => { base = `http://localhost:${server.address().port}/api`; r(); }); }));
test.after(() => server.close());

const jar = {};
async function call(who, method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', cookie: jar[who] || '' }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) jar[who] = sc.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => null) };
}
const A = (m, u, b) => call('admin', m, u, b);

test('default admin/admin works and is flagged', async () => {
  assert.strictEqual((await call('x', 'POST', '/login', { username: 'admin', password: 'nope' })).status, 401);
  const r = await A('POST', '/login', { username: 'admin', password: 'admin' });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.data.user.must_change, true);
});

test('password change: cannot reuse "admin", must be valid', async () => {
  assert.strictEqual((await A('POST', '/me/password', { current: 'admin', password: 'admin' })).status, 400);
  assert.strictEqual((await A('POST', '/me/password', { current: 'admin', password: 'Cocoa2026!' })).status, 200);
  assert.strictEqual((await A('GET', '/me')).data.user.must_change, false);
});

test('purchase changes the price only after "Update cost control"', async () => {
  const before = (await A('GET', '/products')).data.rows.find((p) => p.id === 1).cost.total;
  const s = (await A('POST', '/suppliers', { name: 'Souk' })).data;
  const p = await A('POST', '/purchases', { supplier_id: s.id, date: '2026-01-10', lines: [{ ingredient_id: 3, qty: 10, total: 30 }], paid: 10 });
  assert.strictEqual(p.status, 201); assert.strictEqual(p.data.due, 20);
  assert.strictEqual((await A('GET', '/products')).data.rows.find((x) => x.id === 1).cost.total, before, 'unchanged before update');
  const pend = (await A('GET', '/cost/pending')).data;
  assert.strictEqual(pend.changes.length, 1); assert.strictEqual(pend.changes[0].new, 3); assert.ok(pend.products[0].new_total > pend.products[0].old_total);
  assert.strictEqual((await A('POST', '/cost/apply', {})).data.applied, 1);
  assert.ok((await A('GET', '/products')).data.rows.find((x) => x.id === 1).cost.total > before);
  assert.strictEqual((await A('GET', '/cost/pending')).data.changes.length, 0);
});

test('invoices, payments and customer balance', async () => {
  const c = (await A('POST', '/customers', { name: 'Maya', phone: '70111222' })).data;
  const inv = (await A('POST', '/sales', { customer_id: c.id, date: '2026-01-11', channel: 'Shop', lines: [{ product_id: 1, qty: 10, price: 2 }], paid: 5 })).data;
  assert.strictEqual(inv.total, 20); assert.strictEqual(inv.due, 15);
  assert.strictEqual((await A('POST', `/sales/${inv.id}/payments`, { amount: 100, date: '2026-01-12' })).status, 400, 'overpay rejected');
  assert.strictEqual((await A('POST', `/customers/${c.id}/pay`, { amount: 15, date: '2026-01-12' })).status, 200);
  const d = (await A('GET', `/customers/${c.id}`)).data;
  assert.strictEqual(d.totals.due, 0);
});

test('order delivered becomes a paid invoice, undone when reopened', async () => {
  const o = await call('pub', 'POST', '/orders', { name: 'Buyer', phone: '70123456', items: [{ id: 1, qty: 2 }] });
  assert.strictEqual(o.status, 201); assert.ok(o.data.whatsapp_url);
  assert.strictEqual((await A('GET', '/orders/pending')).data.count, 1);
  const done = (await A('PUT', `/orders/${o.data.id}`, { status: 'delivered' })).data;
  assert.ok(done.invoice_id);
  const inv = (await A('GET', `/sales/${done.invoice_id}`)).data;
  assert.strictEqual(inv.due, 0); assert.strictEqual(inv.channel, 'Website');
  await A('PUT', `/orders/${o.data.id}`, { status: 'new' });
  assert.strictEqual((await A('GET', `/sales/${done.invoice_id}`)).status, 404);
});

test('reports respond and totals add up', async () => {
  for (const n of ['sales', 'purchases', 'customers', 'suppliers', 'goods', 'profit', 'netprofit', 'expenses', 'income', 'cashflow', 'aging', 'journal']) {
    const r = await A('GET', `/reports/${n}`); assert.strictEqual(r.status, 200, n); assert.ok(Array.isArray(r.data.rows), n);
  }
  const s = (await A('GET', '/reports/sales?group=invoice')).data;
  assert.strictEqual(s.totals.total, s.rows.reduce((a, r) => a + r.total, 0));
  assert.strictEqual((await A('GET', '/monthly?month=2026-01')).status, 200);
});

test('staff can sell but cannot see purchases, costs, reports, settings or users', async () => {
  assert.strictEqual((await A('POST', '/users', { username: 'sara', password: 'sara1234', role: 'staff' })).status, 201);
  assert.strictEqual((await call('staff', 'POST', '/login', { username: 'sara', password: 'sara1234' })).status, 200);
  for (const u of ['/purchases', '/suppliers', '/ingredients', '/products', '/reports/sales', '/monthly', '/users', '/expenses']) assert.strictEqual((await call('staff', 'GET', u)).status, 403, u);
  for (const u of ['/sales', '/customers', '/orders', '/catalog', '/dashboard']) assert.strictEqual((await call('staff', 'GET', u)).status, 200, u);
  assert.deepStrictEqual(Object.keys((await call('staff', 'GET', '/settings')).data.settings).sort(), ['currency', 'store_name']);
  assert.strictEqual((await call('staff', 'GET', '/catalog')).data.products[0].cost, undefined, 'no cost in catalog');
});

test('anonymous requests are rejected; public store API works', async () => {
  assert.strictEqual((await call('anon', 'GET', '/sales')).status, 401);
  assert.strictEqual((await call('anon', 'GET', '/public/config')).status, 200);
});

test('cannot remove the last admin or delete yourself', async () => {
  const me = (await A('GET', '/me')).data.user;
  assert.strictEqual((await A('DELETE', `/users/${me.id}`)).status, 400);
  assert.strictEqual((await A('PUT', `/users/${me.id}`, { role: 'staff' })).status, 400);
});
