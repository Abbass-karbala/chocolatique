'use strict';
// Recipe costing: ingredient prices -> cost per piece / per batch, including products used inside other products.
const { db } = require('./db');
const { getSettings } = require('./settings');
const { costProduct } = require('./calc');

function loadContext() {
  const settings = getSettings();
  const ing = new Map(db.prepare('SELECT * FROM ingredients').all().map((r) => [r.id, r]));
  const prods = new Map(db.prepare('SELECT * FROM products').all().map((r) => [r.id, r]));
  const recipes = new Map();
  for (const l of db.prepare('SELECT * FROM recipe_lines ORDER BY id').all()) {
    if (!recipes.has(l.product_id)) recipes.set(l.product_id, []);
    recipes.get(l.product_id).push(l);
  }
  return { settings, ing, prods, recipes, memo: { false: new Map(), true: new Map() } };
}

const isPending = (g) => g.last_price !== null && g.last_price !== undefined && Math.abs(g.last_price - g.cost) > 1e-7;
const unitCost = (g, useLast) => (useLast && isPending(g) ? g.last_price : g.cost);

// useLast=true prices every ingredient at its latest purchase price (the "after Update" view).
function productCost(pid, ctx, useLast = false, stack = []) {
  const memo = ctx.memo[useLast];
  if (memo.has(pid)) return memo.get(pid);
  const p = ctx.prods.get(pid);
  if (!p || stack.includes(pid)) return null;

  const lines = ctx.recipes.get(pid) || [];
  let food = 0, pack = 0, comp = 0;
  const parts = [];
  for (const l of lines) {
    if (l.ingredient_id) {
      const g = ctx.ing.get(l.ingredient_id);
      if (!g) continue;
      const uc = unitCost(g, useLast), lc = l.qty * uc;
      if (g.kind === 'packaging') pack += lc; else food += lc;
      parts.push({ type: 'ingredient', id: g.id, name_en: g.name_en, name_ar: g.name_ar, unit: g.unit, kind: g.kind, qty: l.qty, unit_cost: uc, line_cost: lc, pending: isPending(g) });
    } else if (l.component_id) {
      const c = productCost(l.component_id, ctx, useLast, [...stack, pid]);
      const cp = ctx.prods.get(l.component_id);
      const unit = c && c.cost ? c.cost.total : 0, lc = l.qty * unit;
      comp += lc;
      parts.push({ type: 'product', id: l.component_id, name_en: cp ? cp.name_en : '', name_ar: cp ? cp.name_ar : '', unit: 'pcs', kind: 'product', qty: l.qty, unit_cost: unit, line_cost: lc, missing: !c || !c.cost });
    }
  }
  const pieces = Number(p.pieces_per_batch) || 0;
  let foodPP = p.food_cost, packPP = p.packaging, compPP = 0, source = 'manual';
  if (lines.length && pieces > 0) { foodPP = food / pieces; packPP = pack / pieces; compPP = comp / pieces; source = 'recipe'; }
  const cost = costProduct({ ...p, food_cost: foodPP, packaging: packPP, component_cost: compPP }, ctx.settings);
  const res = { source, parts, batchMaterials: food + pack + comp, foodPerPiece: foodPP, packPerPiece: packPP, componentPerPiece: compPP, cost, batchCost: cost ? cost.total * pieces : null };
  memo.set(pid, res);
  return res;
}

const pendingIngredients = (ctx) => [...ctx.ing.values()].filter(isPending);

// Products whose cost changes if the pending prices are applied.
function pendingImpact(ctx) {
  const out = [];
  for (const p of ctx.prods.values()) {
    const a = productCost(p.id, ctx, false), b = productCost(p.id, ctx, true);
    if (!a || !b || !a.cost || !b.cost || Math.abs(a.cost.total - b.cost.total) < 1e-7) continue;
    out.push({ id: p.id, name_en: p.name_en, name_ar: p.name_ar, old_total: a.cost.total, new_total: b.cost.total, old_margin: a.cost.margin, new_margin: b.cost.margin, price: p.price, batchOld: a.batchCost, batchNew: b.batchCost });
  }
  return out;
}

// Would adding `componentId` to product `pid` create a loop (A contains B contains A)?
function wouldLoop(pid, componentId) {
  const seen = new Set();
  const stack = [componentId];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === pid) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const l of db.prepare('SELECT component_id FROM recipe_lines WHERE product_id=? AND component_id IS NOT NULL').all(cur)) stack.push(l.component_id);
  }
  return false;
}

module.exports = { loadContext, productCost, pendingIngredients, pendingImpact, isPending, wouldLoop };
