/* Cost control: products + recipes, ingredients, and the "Update cost control" step. Admin only. */
(() => {
  'use strict';
  const App = window.App;
  const { h, T, fm, fp, fn, pname, api, get, fail, btn, link, head, tabs, table, tile, pill, toast } = App;
  const STATUS = { good: ['good', 'st_good'], low: ['low', 'st_low'], loss: ['loss', 'st_loss'], noprice: ['cancelled', 'st_noprice'] };
  const statusPill = (c) => (c ? pill(...[STATUS[c.status][0], T(STATUS[c.status][1])]) : pill('cancelled', T('st_nocost')));
  const FACTOR = { g: 0.001, ml: 0.001 };
  const unitLabel = (u) => u;

  const costTabs = (on) => tabs([[T('products'), '#/cost', 'products'], [T('ingredients'), '#/cost/ingredients', 'ingredients']], on);

  /* ------------------------------------------------------------ price update */
  App.updateCost = async () => {
    const d = await get('/api/cost/pending');
    App.pendingCost = d.changes.length; App.badges();
    App.modal(T('update_cost'), (body, close) => {
      if (!d.changes.length) { body.append(App.empty(T('cost_up_to_date')), h('div', { class: 'dlg-actions' }, btn(T('close'), close, 'ghost'))); return; }
      body.append(
        h('p', { class: 'muted' }, T('update_cost_help')),
        h('h3', { class: 'sub' }, T('ingredient_prices')),
        table([{ label: T('ingredient'), render: (r) => `${pname(r)} (${r.unit})` }, { label: T('before'), num: true, render: (r) => fm(r.old, 4) }, { label: T('after'), num: true, render: (r) => h('strong', {}, fm(r.new, 4)) },
          { label: T('change'), num: true, render: (r) => h('span', { class: r.new > r.old ? 'neg' : 'pos' }, `${r.new > r.old ? '+' : ''}${fp(r.old ? (r.new - r.old) / r.old : null)}`) }], d.changes),
        d.products.length ? [h('h3', { class: 'sub' }, T('product_impact')),
          table([{ label: T('product'), render: pname }, { label: T('cost_piece'), num: true, render: (r) => `${fm(r.old_total)} → ${fm(r.new_total)}` }, { label: T('cost_batch'), num: true, render: (r) => (r.batchOld != null ? `${fm(r.batchOld)} → ${fm(r.batchNew)}` : '—') },
            { label: T('margin'), num: true, render: (r) => (r.old_margin != null ? `${fp(r.old_margin)} → ${fp(r.new_margin)}` : '—') }], d.products)] : null,
        h('div', { class: 'dlg-actions' }, btn(T('cancel'), close, 'ghost'), btn(T('apply_update'), async () => {
          try { const r = await api('POST', '/api/cost/apply', {}); toast(`${T('updated')}: ${r.applied}`); App.pendingCost = 0; App.badges(); close(); App.refresh(); } catch (e) { fail(e); }
        }, 'gold')));
    }, { wide: true });
  };

  /* ------------------------------------------------------------- ingredients */
  const ingFields = () => [
    { key: 'name_en', label: T('name_en') }, { key: 'name_ar', label: T('name_ar') },
    { key: 'unit', label: T('unit'), type: 'select', options: ['kg', 'g', 'L', 'ml', 'pcs'].map((u) => [u, u]) },
    { key: 'kind', label: T('type'), type: 'select', options: [['ingredient', T('k_ingredient')], ['packaging', T('k_packaging')]] },
    { key: 'cost', label: T('cost_per_unit'), type: 'number', help: T('cost_per_unit_help') }];
  App.ingredientForm = (onDone, row) => App.formModal({
    title: row ? T('edit') : T('new_ingredient'), fields: ingFields(), values: row || { unit: 'kg', kind: 'ingredient', cost: '' },
    onSubmit: async (v) => { const b = { ...v, cost: v.cost === '' ? 0 : Number(v.cost) }; const r = row ? await api('PUT', `/api/ingredients/${row.id}`, b) : await api('POST', '/api/ingredients', b); toast(T('saved')); if (onDone) await onDone(r); },
  });

  async function history(g) {
    const d = await get(`/api/ingredients/${g.id}/history`);
    App.modal(`${pname(g)} — ${T('price_history')}`, (body, close) => body.append(
      h('h3', { class: 'sub' }, T('purchases')), table([{ label: T('date'), key: 'date' }, { label: T('supplier'), key: 'supplier' }, { label: T('qty'), num: true, render: (r) => fn(r.qty) }, { label: T('unit_price'), num: true, render: (r) => fm(r.unit_price, 4) }], d.purchases),
      h('h3', { class: 'sub' }, T('cost_changes')), table([{ label: T('date'), key: 'date' }, { label: T('before'), num: true, render: (r) => fm(r.old_cost, 4) }, { label: T('after'), num: true, render: (r) => fm(r.new_cost, 4) }], d.changes),
      h('div', { class: 'dlg-actions' }, btn(T('close'), close, 'ghost'))), { wide: true });
  }

  App.route('/cost/ingredients', async () => {
    const d = await get('/api/ingredients');
    return [
      head(T('nav_cost'), btn('+ ' + T('new_ingredient'), () => App.ingredientForm(() => App.refresh()), 'gold')), costTabs('ingredients'),
      h('p', { class: 'muted' }, T('ingredients_help')),
      table([
        { label: T('name'), render: (g) => h('strong', {}, pname(g)) }, { label: T('type'), render: (g) => T(`k_${g.kind}`) }, { label: T('unit'), key: 'unit' },
        { label: T('cost_control_price'), num: true, render: (g) => fm(g.cost, 4) },
        { label: T('last_price'), num: true, render: (g) => (g.last_price == null ? '—' : h('span', {}, fm(g.last_price, 4), ' ', g.pending ? pill('low', T('pending')) : '')) },
        { label: T('used_in'), num: true, render: (g) => g.used_in },
        { label: '', render: (g) => h('div', { class: 'row-actions' }, btn(T('history'), () => history(g), 'small ghost'), btn(T('edit'), () => App.ingredientForm(() => App.refresh(), g), 'small ghost'),
          btn('×', async () => { if (!App.confirm()) return; try { await api('DELETE', `/api/ingredients/${g.id}`); App.refresh(); } catch (e) { fail(e); } }, 'small danger')) },
      ], d.rows),
    ];
  }, { admin: true });

  /* ---------------------------------------------------------------- products */
  const prodFields = () => [
    { key: 'name_en', label: T('name_en') }, { key: 'name_ar', label: T('name_ar') },
    { key: 'category', label: T('category_en'), help: T('category_help') }, { key: 'category_ar', label: T('category_ar') },
    { key: 'desc_en', label: T('desc_en'), type: 'textarea', full: true }, { key: 'desc_ar', label: T('desc_ar'), type: 'textarea', full: true },
    { key: 'pieces_per_batch', label: T('pieces_batch'), type: 'number', help: T('pieces_batch_help') }, { key: 'hours_per_batch', label: T('hours_batch'), type: 'number' },
    { key: 'price', label: T('sell_price'), type: 'number', help: T('sell_price_help') }, { key: 'distribution', label: T('distribution'), type: 'number', help: T('distribution_help') },
    { key: 'food_cost', label: T('manual_food'), type: 'number', help: T('manual_help') }, { key: 'packaging', label: T('manual_pack'), type: 'number' },
    { key: 'published', label: T('published_store'), type: 'check' }];
  const prodBody = (v) => ({ ...v, ...Object.fromEntries(['pieces_per_batch', 'hours_per_batch', 'price', 'distribution', 'food_cost', 'packaging'].map((k) => [k, v[k] === '' || v[k] === null || v[k] === undefined ? null : Number(v[k])])), published: !!v.published });

  function resize(file, max = 900) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => reject(new Error(T('bad_image')));
      img.src = url;
    });
  }
  const imagePicker = (p, after) => {
    const input = h('input', { type: 'file', accept: 'image/*', class: 'hidden', onchange: async () => {
      if (!input.files[0]) return;
      try { await api('POST', `/api/products/${p.id}/image`, { data: await resize(input.files[0]) }); toast(T('saved')); after(); } catch (e) { fail(e); }
    } });
    return h('div', { class: 'imgpick' }, p.image ? h('img', { class: 'thumb big', src: p.image, alt: '' }) : h('div', { class: 'thumb big ph' }, '🍫'), input,
      btn(p.image ? T('change_photo') : T('add_photo'), () => input.click(), 'ghost small'),
      p.image ? btn(T('remove_photo'), async () => { try { await api('POST', `/api/products/${p.id}/image`, { data: null }); after(); } catch (e) { fail(e); } }, 'danger small') : null);
  };

  App.route('/cost', async () => {
    const d = await get('/api/products');
    App.pendingCost = d.pendingCount; App.badges();
    const add = () => App.formModal({ title: T('new_product'), fields: prodFields(), values: { published: false }, onSubmit: async (v) => { const r = await api('POST', '/api/products', prodBody(v)); App.go(`/cost/products/${r.id}`); } });
    return [
      head(T('nav_cost'), d.pendingCount ? btn(`${T('update_cost')} (${d.pendingCount})`, () => App.updateCost(), 'gold') : null, btn('+ ' + T('new_product'), add, d.pendingCount ? 'ghost' : 'gold')), costTabs('products'),
      d.pendingCount ? h('div', { class: 'note' }, `${d.pendingCount} ${T('prices_changed')} ${T('prices_changed_help')}`) : null,
      table([
        { label: T('product'), render: (p) => h('div', { class: 'nm' }, p.image ? h('img', { class: 'thumb', src: p.image, alt: '' }) : h('div', { class: 'thumb ph' }, '🍫'), h('div', {}, pname(p), h('small', {}, p.source === 'recipe' ? T('from_recipe') : T('manual_cost')))) },
        { label: T('cost_piece'), num: true, render: (p) => (p.cost ? fm(p.cost.total) : '—') },
        { label: T('cost_batch'), num: true, render: (p) => (p.batchCost != null ? fm(p.batchCost) : '—') },
        { label: T('sell_price'), num: true, render: (p) => fm(p.price) },
        { label: T('margin'), num: true, render: (p) => (p.cost && p.cost.margin != null ? fp(p.cost.margin) : '—') },
        { label: T('status'), render: (p) => h('span', {}, statusPill(p.cost), p.pending ? [' ', pill('low', T('pending'))] : '', p.published ? [' ', pill('good', T('in_store'))] : '') },
      ], d.rows, { onRow: (p) => App.go(`/cost/products/${p.id}`) }),
    ];
  }, { admin: true });

  /* ----------------------------------------------------------- product detail */
  App.printRecipe = (id) => App.formModal({
    title: T('print_recipe'), submitLabel: T('print'),
    fields: [{ key: 'batches', label: T('batches'), type: 'number', help: T('batches_help') },
      { key: 'mode', label: T('print_what'), type: 'select', full: true, options: [['qty', T('pm_qty')], ['prices', T('pm_prices')], ['summary', T('pm_summary')]] }],
    values: { batches: 1, mode: 'qty' },
    onSubmit: async (v) => { const n = Number(v.batches); if (!(n > 0)) throw new Error(T('bad_number')); window.open(`/admin/print.html?type=recipe&id=${id}&batches=${n}&mode=${v.mode}`, '_blank'); },
  });

  App.route('/cost/products/:id', async ({ id }) => {
    const [d, ingData, prodData] = await Promise.all([get(`/api/products/${id}`), get('/api/ingredients'), get('/api/products')]);
    const p = d.product, c = p.cost, ings = ingData.rows;
    const edit = () => App.formModal({ title: T('edit'), fields: prodFields(), values: p, onSubmit: async (v) => { await api('PUT', `/api/products/${id}`, prodBody(v)); toast(T('saved')); App.refresh(); } });
    const lineTotal = d.parts.reduce((a, x) => a + x.line_cost, 0);

    /* -- recipe editor state */
    const initLine = (x) => {
      const g = x.type === 'ingredient' ? ings.find((i) => i.id === x.id) : null;
      const u = g ? g.unit : 'pcs';
      const small = (u === 'kg' || u === 'L') && x.qty < 1;
      return { key: `${x.type === 'ingredient' ? 'i' : 'p'}${x.id}`, val: small ? +(x.qty * 1000).toFixed(6) : x.qty, eu: small ? (u === 'kg' ? 'g' : 'ml') : u };
    };
    let lines = d.parts.map(initLine);
    const editor = h('div', { class: 'card hidden' });
    const view = h('div', { class: 'card' });

    const baseUnit = (key) => { if (key[0] === 'p') return 'pcs'; const g = ings.find((i) => i.id === Number(key.slice(1))); return g ? g.unit : 'pcs'; };
    const entryUnits = (key) => { const u = baseUnit(key); return u === 'kg' ? ['kg', 'g'] : u === 'L' ? ['L', 'ml'] : [u]; };
    const drawEditor = () => {
      const used = new Set(lines.map((l) => l.key));
      const rows = lines.map((l, i) => {
        const opts = [h('optgroup', { label: T('ingredients') }, ings.map((g) => h('option', { value: `i${g.id}`, selected: l.key === `i${g.id}` }, `${pname(g)} (${g.unit})`))),
          h('optgroup', { label: T('products') }, prodData.rows.filter((x) => x.id !== p.id).map((x) => h('option', { value: `p${x.id}`, selected: l.key === `p${x.id}` }, pname(x))))];
        const sel = h('select', { onchange: () => { l.key = sel.value; l.eu = entryUnits(l.key)[0]; drawEditor(); } }, opts);
        const eu = entryUnits(l.key);
        return h('div', { class: 'lrow' }, sel,
          h('input', { type: 'number', min: '0', step: 'any', class: 'q', value: l.val, 'aria-label': T('qty'), oninput: (e) => { l.val = e.target.value; } }),
          eu.length > 1 ? h('select', { class: 'u', onchange: (e) => { l.eu = e.target.value; } }, eu.map((u) => h('option', { value: u, selected: u === l.eu }, u))) : h('span', { class: 'muted u' }, unitLabel(eu[0])),
          h('button', { type: 'button', class: 'x', 'aria-label': T('delete'), onclick: () => { lines.splice(i, 1); drawEditor(); } }, '×'));
      });
      const err = h('p', { class: 'err' });
      const addSel = h('select', { onchange: () => { if (!addSel.value) return; lines.push({ key: addSel.value, val: '', eu: entryUnits(addSel.value)[0] }); drawEditor(); } },
        h('option', { value: '' }, '+ ' + T('add_line')),
        h('optgroup', { label: T('ingredients') }, ings.filter((g) => !used.has(`i${g.id}`)).map((g) => h('option', { value: `i${g.id}` }, `${pname(g)} (${g.unit})`))),
        h('optgroup', { label: T('products') }, prodData.rows.filter((x) => x.id !== p.id && !used.has(`p${x.id}`)).map((x) => h('option', { value: `p${x.id}` }, pname(x)))));
      const batch = h('input', { type: 'number', min: '1', step: 'any', value: p.pieces_per_batch ?? '', class: 'q' });
      const hours = h('input', { type: 'number', min: '0', step: 'any', value: p.hours_per_batch ?? '', class: 'q' });
      editor.replaceChildren(h('h2', {}, T('edit_recipe')), h('p', { class: 'muted' }, T('recipe_help')),
        h('div', { class: 'formgrid' }, h('label', { class: 'field' }, T('pieces_batch'), batch, h('span', { class: 'help' }, T('pieces_batch_help'))), h('label', { class: 'field' }, T('hours_batch'), hours)),
        h('div', { class: 'lines' }, rows), addSel, err,
        h('div', { class: 'dlg-actions' }, btn(T('cancel'), () => { lines = d.parts.map(initLine); editor.classList.add('hidden'); view.classList.remove('hidden'); }, 'ghost'),
          btn(T('save'), async () => {
            try {
              const out = lines.filter((l) => l.key).map((l) => {
                const q = Number(l.val) * (FACTOR[l.eu] || 1);
                return l.key[0] === 'i' ? { ingredient_id: Number(l.key.slice(1)), qty: q } : { component_id: Number(l.key.slice(1)), qty: q };
              });
              await api('PUT', `/api/products/${id}/recipe`, { lines: out });
              await api('PUT', `/api/products/${id}`, prodBody({ ...p, pieces_per_batch: batch.value, hours_per_batch: hours.value }));
              toast(T('saved')); App.refresh();
            } catch (e) { err.textContent = e.message; }
          }, 'gold')));
    };

    const startEdit = () => { drawEditor(); view.classList.add('hidden'); editor.classList.remove('hidden'); };
    const pcs = Number(p.pieces_per_batch) || 0;
    view.append(...[h('div', { class: 'bar' }, h('h2', {}, T('recipe_batch')), btn(T('edit_recipe'), startEdit, 'ghost small')),
      d.parts.length ? [h('p', { class: 'muted' }, `${T('makes')} ${fn(pcs)} ${T('pieces').toLowerCase()} · ${fn(p.hours_per_batch)} ${T('hours')}`),
        table([
          { label: T('ingredient'), render: (x) => h('span', {}, x.type === 'product' ? '📦 ' : '', pname(x), x.pending ? [' ', pill('low', T('pending'))] : '') },
          { label: T('qty'), num: true, render: (x) => `${fn(x.qty, 4)} ${x.unit}` }, { label: T('unit_price'), num: true, render: (x) => fm(x.unit_cost, 4) }, { label: T('line_cost'), num: true, render: (x) => fm(x.line_cost) },
        ], d.parts, { foot: [T('materials_batch'), '', '', fm(lineTotal)] })] : [h('p', { class: 'muted' }, T('no_recipe')), btn(T('edit_recipe'), startEdit, 'gold')]].flat(Infinity));

    const kv = (k, v, cls) => [h('div', { class: 'k' }, k), h('div', { class: `v ${cls || ''}` }, v)];
    const breakdown = c ? h('div', { class: 'card' }, h('h2', {}, T('cost_piece_title')), h('div', { class: 'kv' },
      kv(T('food_cost'), fm(d.foodPerPiece)), d.componentPerPiece ? kv(T('components_cost'), fm(d.componentPerPiece)) : null, kv(`${T('waste')} (${fp(d.settings.waste_pct)})`, fm(c.waste)), kv(T('packaging'), fm(d.packPerPiece)),
      kv(T('labor'), fm(c.labor)), kv(T('overhead'), fm(c.overhead)), kv(T('distribution'), fm(p.distribution || 0)),
      h('div', { class: 'strong' }, h('span', {}, T('cost_piece')), h('span', {}, fm(c.total))),
      kv(T('sell_price'), fm(p.price)), c.profit != null ? [kv(T('profit_piece'), fm(c.profit), c.profit < 0 ? 'neg' : 'pos'), kv(T('margin'), fp(c.margin)), kv(T('profit_batch'), fm(c.profitBatch)), kv(T('earn_hour'), fm(c.earningsHour))] : null,
      kv(`${T('suggested')} (${fp(d.settings.target_margin)})`, fm(c.suggested)))) : h('div', { class: 'card' }, h('h2', {}, T('cost_piece_title')), h('p', { class: 'muted' }, T('need_recipe')));

    return [
      head(pname(p), statusPill(c), btn(T('print_recipe'), () => App.printRecipe(id), 'ghost'), btn(T('edit'), edit, 'ghost'),
        btn(T('delete'), async () => { if (!App.confirm()) return; try { await api('DELETE', `/api/products/${id}`); App.go('/cost'); } catch (e) { fail(e); } }, 'danger')),
      h('div', { class: 'tiles' }, tile(T('cost_piece'), c ? fm(c.total) : '—'), tile(T('cost_batch'), p.batchCost != null ? fm(p.batchCost) : '—'), tile(T('sell_price'), fm(p.price)), tile(T('margin'), c && c.margin != null ? fp(c.margin) : '—')),
      p.pending ? h('div', { class: 'note' }, `${T('after_update')}: ${fm(p.pending.old_total)} → ${fm(p.pending.new_total)} ${T('per_piece')}. `, btn(T('update_cost'), () => App.updateCost(), 'small gold')) : null,
      h('div', { class: 'grid2' }, h('div', {}, view, editor), h('div', {}, breakdown, h('div', { class: 'card' }, h('h2', {}, T('store_photo')), imagePicker(p, () => App.refresh()), h('p', { class: 'muted' }, p.published && p.price > 0 ? T('visible_in_store') : T('not_in_store'))))),
    ];
  }, { admin: true });
})();
