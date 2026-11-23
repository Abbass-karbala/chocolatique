'use strict';
// Checks the app maths against the values cached in the original Excel template.
const test = require('node:test');
const assert = require('node:assert');
const { overhead, costProduct, monthly } = require('../lib/calc');

const settings = { labor_rate: 2, waste_pct: 0.05, target_margin: 0.4, gas: 20, electricity: 50, other_bills: 10, hours_per_month: 100 };
const sable = { id: 1, food_cost: 0.29, packaging: 0.06, pieces_per_batch: 100, hours_per_batch: 7, price: 1, distribution: 0.1 };
const cookies = { id: 2, food_cost: 0.66, packaging: 0.06, pieces_per_batch: 10, hours_per_batch: 0.2, price: 2, distribution: 0.14 };
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('overhead matches Settings!B12 / B16', () => {
  const o = overhead(settings);
  assert.strictEqual(o.total, 80);
  close(o.perHour, 0.8);
});

test('Chocolate Sable row matches Costing!H6:R6', () => {
  const c = costProduct(sable, settings);
  close(c.waste, 0.0145); close(c.labor, 0.14); close(c.overhead, 0.056);
  close(c.total, 0.6605); close(c.profit, 0.3395); close(c.margin, 0.3395);
  close(c.profitBatch, 33.95); close(c.profitHour, 4.85); close(c.earningsHour, 6.85);
  close(c.suggested, 1.1008333333333333); assert.strictEqual(c.status, 'low');
});

test('waste is always computed from the settings %', () => {
  const c = costProduct(cookies, settings);
  close(c.waste, 0.033);
  assert.strictEqual(c.status, 'good');
});

test('components (products inside a box) are added without waste', () => {
  const box = { food_cost: 0, packaging: 0.5, component_cost: 6, pieces_per_batch: 1, hours_per_batch: 0.25, price: 12, distribution: 0 };
  const c = costProduct(box, settings);
  close(c.waste, 0);
  close(c.total, 0.5 + 6 + 0.25 * 2 + 0.25 * 0.8);
});

test('no price: cost is known, profit is not. Missing food cost or pieces: null', () => {
  const c = costProduct({ ...sable, price: null }, settings);
  close(c.total, 0.6605); assert.strictEqual(c.profit, null); assert.strictEqual(c.status, 'noprice');
  assert.strictEqual(costProduct({ ...sable, pieces_per_batch: 0 }, settings), null);
  assert.strictEqual(costProduct({ ...sable, food_cost: null }, settings), null);
});

const month = {
  month: '2026-11', settings, costById: { 1: 0.6605 },
  inputs: { cash_start: 0, stock_start: 0, stock_end: 151, hours: 27, pieces_made: 400, pieces_wasted: 20, pay_taken: 0, equipment_life: 12 },
  sales: [{ date: '2026-11-03', product_id: 1, channel: 'Supermarket', pieces: 380, price: 1 }],
  receipts: [{ date: '2026-11-20', amount: 380 }],
  materials: { Ingredients: 290, Packaging: 0 },
  supplierPayments: [{ date: '2026-11-04', amount: 290 }],
  expenses: [
    { date: '2026-11-06', category: 'Equipment', amount: 13 }, { date: '2026-11-08', category: 'New product testing', amount: 43 },
    { date: '2026-11-10', category: 'Gas', amount: 20 }, { date: '2026-11-12', category: 'New product testing', amount: 20 },
  ],
  owed: 0, payable: 0,
};

test('Monthly example month matches the workbook', () => {
  const m = monthly(month);
  close(m.sales.total, 380); close(m.totalSpent, 386); close(m.profit.materialsUsed, 139);
  close(m.profit.equipmentShare, 13 / 12); close(m.profit.beforePay, 219.91666666666666);
  close(m.profit.real, 165.91666666666666); close(m.profit.realMargin, 0.43662280701754386);
  close(m.profit.afterInvestment, 102.91666666666666); close(m.cash.end, -6);
  close(m.health.realCostPerPiece, 0.5633771929824561); close(m.health.expectedCost, 0.6605);
  close(m.health.diffVsExpected, -0.09712280701754383); close(m.health.investmentPct, 0.2);
  close(m.health.profitPerHour, 6.145061728395062); close(m.health.earningsPerHour, 8.145061728395062);
  assert.deepStrictEqual(m.insights, ['cash_negative', 'profit', 'invest_ok', 'cost_close', 'waste_ok']);
});

test('supplier credit: unpaid purchases do not reduce cash', () => {
  const m = monthly({ ...month, supplierPayments: [{ date: '2026-11-04', amount: 90 }], payable: 200 });
  close(m.cash.spent, 90 + 96); close(m.cash.end, 380 - 186); assert.ok(m.insights.includes('payable'));
});

test('sales outside the month are ignored; owed is passed through', () => {
  const m = monthly({
    ...month, month: '2026-12', inputs: {}, costById: {}, materials: {}, supplierPayments: [], expenses: [], owed: 26,
    sales: [{ date: '2026-11-30', channel: 'Shop', pieces: 10, price: 2 }, { date: '2026-12-01', channel: 'WhatsApp', pieces: 5, price: 2 }],
    receipts: [{ date: '2026-12-02', amount: 4 }],
  });
  close(m.sales.total, 10); close(m.sales.byChannel.WhatsApp, 10); close(m.sales.cashReceived, 4); close(m.sales.owed, 26);
  assert.ok(m.insights.includes('owed'));
});
