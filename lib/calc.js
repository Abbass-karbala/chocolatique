'use strict';
// Costing + monthly maths, ported from the Excel template and extended for recipes.
// No I/O here, so it is easy to test.

const n = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const z = (v) => n(v) ?? 0;

function overhead(s) {
  const total = z(s.gas) + z(s.electricity) + z(s.other_bills);
  const perHour = z(s.hours_per_month) > 0 ? total / s.hours_per_month : 0;
  return { total, perHour };
}

// One product. food_cost / packaging are per piece; component_cost (other products inside this one,
// e.g. bonbons in a gift box) is per piece too and is not subject to the waste allowance.
// Returns null until food cost and pieces per batch are known. Profit fields are null while there is no price.
function costProduct(p, s) {
  const food = n(p.food_cost);
  const pieces = n(p.pieces_per_batch);
  if (food === null || pieces === null || pieces === 0) return null;
  const price = n(p.price);

  const hrs = z(p.hours_per_batch);
  const waste = food * s.waste_pct;
  const labor = (hrs * s.labor_rate) / pieces;
  const over = (hrs * overhead(s).perHour) / pieces;
  const total = food + waste + z(p.packaging) + z(p.component_cost) + labor + over + z(p.distribution);
  const suggested = s.target_margin < 1 ? total / (1 - s.target_margin) : 0;
  const base = { waste, labor, overhead: over, total, suggested, profit: null, margin: null, profitBatch: null, profitHour: null, earningsHour: null, status: 'noprice' };
  if (price === null || price <= 0) return base;

  const profit = price - total;
  const margin = profit / price;
  const profitBatch = profit * pieces;
  const profitHour = hrs > 0 ? profitBatch / hrs : 0;
  return { ...base, profit, margin, profitBatch, profitHour, earningsHour: s.labor_rate + profitHour, status: margin >= s.target_margin ? 'good' : margin >= 0 ? 'low' : 'loss' };
}

const nextMonth = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
};
const prevMonth = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
};
const inMonth = (d, m) => !!d && d >= `${m}-01` && d < `${nextMonth(m)}-01`;

const CHANNELS = ['Supermarket', 'Shop', 'Website', 'WhatsApp'];
// Ingredients and Packaging come from supplier purchases; the rest are logged as expenses.
const EXPENSE_CATEGORIES = ['Gas', 'Electricity', 'Other bills', 'Delivery', 'Equipment', 'New product testing'];
const MONTHLY_CATEGORIES = ['Ingredients', 'Packaging', ...EXPENSE_CATEGORIES];

/* Monthly sheet.
   sales: invoice lines {date, product_id, channel, pieces, price}   receipts / supplierPayments: [{date, amount}]
   materials: purchases in the month {Ingredients, Packaging}          expenses: [{date, category, amount}]
   owed / payable: what customers owe you / you owe suppliers (all time)   costById: product id -> total cost per piece */
function monthly({ month, inputs, settings: s, sales, receipts, supplierPayments, materials, expenses, owed, payable, costById }) {
  const i = {
    cash_start: z(inputs.cash_start), stock_start: z(inputs.stock_start), stock_end: z(inputs.stock_end),
    hours: z(inputs.hours), pieces_made: z(inputs.pieces_made), pieces_wasted: z(inputs.pieces_wasted),
    pay_taken: z(inputs.pay_taken), equipment_life: z(inputs.equipment_life),
  };
  const value = (r) => z(r.pieces) * z(r.price);

  // 1. Sales
  const mSales = sales.filter((r) => inMonth(r.date, month));
  const byChannel = {};
  for (const c of CHANNELS) byChannel[c] = mSales.filter((r) => r.channel === c).reduce((a, r) => a + value(r), 0);
  const totalSales = CHANNELS.reduce((a, c) => a + byChannel[c], 0);
  const piecesSold = mSales.reduce((a, r) => a + z(r.pieces), 0);
  const cashReceived = receipts.filter((r) => inMonth(r.date, month)).reduce((a, r) => a + z(r.amount), 0);

  // 2. Money spent (purchases + expenses)
  const spent = {};
  for (const c of MONTHLY_CATEGORIES) {
    spent[c] = c === 'Ingredients' || c === 'Packaging'
      ? z(materials[c])
      : expenses.filter((e) => e.category === c && inMonth(e.date, month)).reduce((a, e) => a + z(e.amount), 0);
  }
  const totalSpent = MONTHLY_CATEGORIES.reduce((a, c) => a + spent[c], 0);
  const cashSpent = supplierPayments.filter((r) => inMonth(r.date, month)).reduce((a, r) => a + z(r.amount), 0)
    + EXPENSE_CATEGORIES.reduce((a, c) => a + spent[c], 0);

  // 3. Profit
  const materialsUsed = i.stock_start + spent['Ingredients'] + spent['Packaging'] - i.stock_end;
  const bills = spent['Gas'] + spent['Electricity'] + spent['Other bills'];
  const delivery = spent['Delivery'];
  const equipmentShare = i.equipment_life > 0 ? spent['Equipment'] / i.equipment_life : 0;
  const profitBeforePay = totalSales - materialsUsed - bills - delivery - equipmentShare;
  const fairLabor = i.hours * s.labor_rate;
  const realProfit = profitBeforePay - fairLabor;
  const realMargin = totalSales > 0 ? realProfit / totalSales : 0;
  const testing = spent['New product testing'];

  // 4. Cash
  const cashEnd = i.cash_start + cashReceived - cashSpent - i.pay_taken;

  // 5. Health checks
  const avgPrice = piecesSold > 0 ? totalSales / piecesSold : 0;
  const realCostPerPiece = piecesSold > 0 ? (materialsUsed + bills + delivery + equipmentShare + fairLabor) / piecesSold : 0;
  let ep = 0, es = 0;
  for (const r of mSales) {
    const c = costById[r.product_id];
    if (c !== undefined && c !== null) { ep += z(r.pieces); es += z(r.pieces) * c; }
  }
  const expectedCost = ep > 0 ? es / ep : null;
  const diffVsExpected = expectedCost === null ? null : realCostPerPiece - expectedCost;
  const realWaste = i.pieces_made > 0 ? i.pieces_wasted / i.pieces_made : 0;
  const investmentPct = totalSales > 0 ? (spent['Equipment'] + testing) / totalSales : 0;
  const profitPerHour = i.hours > 0 ? realProfit / i.hours : 0;
  const earningsPerHour = i.hours > 0 ? s.labor_rate + profitPerHour : 0;

  const insights = [cashEnd < 0 ? 'cash_negative' : 'cash_positive', realProfit < 0 ? 'loss' : 'profit', investmentPct > 0.2 ? 'invest_high' : 'invest_ok'];
  if (diffVsExpected !== null) insights.push(diffVsExpected > 0.03 ? 'cost_above' : 'cost_close');
  insights.push(realWaste > s.waste_pct ? 'waste_high' : 'waste_ok');
  if (owed > 0) insights.push('owed');
  if (payable > 0) insights.push('payable');

  return {
    month, inputs: i,
    sales: { byChannel, total: totalSales, piecesSold, cashReceived, owed, payable },
    spent, totalSpent,
    profit: { materialsUsed, bills, delivery, equipmentShare, beforePay: profitBeforePay, fairLabor, real: realProfit, realMargin, testing, afterInvestment: realProfit - testing },
    cash: { start: i.cash_start, received: cashReceived, spent: cashSpent, pay: i.pay_taken, end: cashEnd },
    health: { avgPrice, realCostPerPiece, expectedCost, diffVsExpected, realWaste, plannedWaste: s.waste_pct, investmentPct, profitPerHour, earningsPerHour },
    insights,
  };
}

module.exports = { overhead, costProduct, monthly, nextMonth, prevMonth, inMonth, CHANNELS, EXPENSE_CATEGORIES, MONTHLY_CATEGORIES };
