/* Home, Orders, Sales / Purchases (invoices + customers / suppliers), Expenses. */
(() => {
  'use strict';
  const { h, T, fm, fn, pname, today, api, get, fail, btn, link, head, tabs, table, tile, pill, payPill, toast, empty } = Object.assign({}, window.App, { api: window.App.api, get: window.App.get, btn: window.App.btn, link: window.App.link, empty: window.App.empty });
  const App = window.App;
  const ST = ['new', 'confirmed', 'delivered', 'cancelled'];
  const stPill = (s) => pill(s, T(`status_${s}`));
  const dt = (iso) => String(iso || '').slice(0, 10);

  /* -------------------------------------------------------------------- Home */
  App.route('/', async () => {
    const d = await get('/api/dashboard');
    const admin = d.role === 'admin';
    const tiles = [
      tile(T('new_orders'), d.newOrders, { href: '#/orders', cls: d.newOrders ? 'hot' : '' }),
      tile(T('sales_today'), fm(d.salesToday)), tile(T('sales_month'), fm(d.salesMonth)),
      tile(T('customers_owe'), fm(d.customersOwe), { href: '#/sales?status=unpaid', sub: `${d.unpaidInvoices} ${T('unpaid_invoices')}` }),
    ];
    if (admin) tiles.push(tile(T('we_owe'), fm(d.weOwe), { href: '#/purchases?status=unpaid', sub: `${d.unpaidPurchases} ${T('unpaid_invoices')}` }), tile(T('purchases_month'), fm(d.purchasesMonth)), tile(T('expenses_month'), fm(d.expensesMonth)));
    return [
      head(`${T('hello')}${App.user.name ? `, ${App.user.name}` : ''}`,
        link('+ ' + T('new_invoice'), '#/sales/new', 'gold'), btn('+ ' + T('new_order'), () => App.orderForm(), 'ghost'), admin ? link('+ ' + T('new_purchase'), '#/purchases/new', 'ghost') : null),
      admin && d.pendingCost ? h('div', { class: 'note' }, h('strong', {}, `${d.pendingCost} ${T('prices_changed')}`), ' ', T('prices_changed_help'), ' ', btn(T('update_cost'), () => App.updateCost(), 'gold small')) : null,
      h('div', { class: 'tiles' }, tiles),
      h('div', { class: 'grid2' },
        h('div', { class: 'card' }, h('h2', {}, T('recent_invoices')), table([
          { label: '#', render: (r) => `#${r.id}` }, { label: T('customer'), render: (r) => r.party_name || T('walk_in') }, { label: T('total'), num: true, render: (r) => fm(r.total) }, { label: T('status'), render: payPill },
        ], d.recentInvoices, { onRow: (r) => App.go(`/sales/${r.id}`) })),
        admin ? h('div', { class: 'card' }, h('h2', {}, T('top_products')), table([
          { label: T('product'), key: 'name' }, { label: T('qty'), num: true, render: (r) => fn(r.qty) }, { label: T('sales'), num: true, render: (r) => fm(r.revenue) },
        ], d.topProducts, { empty: T('none_yet') })) : null)];
  });

  /* ------------------------------------------------------------------ Orders */
  App.orderForm = async () => {
    const cat = await App.catalog();
    const custs = (await get('/api/customers')).rows;
    const items = [{ product_id: '', qty: 1, price: '' }];
    App.modal(T('new_order'), (body, close) => {
      const err = h('p', { class: 'err' });
      const who = h('select', {}, h('option', { value: '' }, '— ' + T('new_customer') + ' —'), custs.map((c) => h('option', { value: c.id }, c.name)));
      const nameI = h('input', { placeholder: T('name') }), phoneI = h('input', { type: 'tel', placeholder: T('phone') });
      const addrI = h('input', { placeholder: T('address') }), notesI = h('input', { placeholder: T('notes') });
      const linesBox = h('div', { class: 'lines' });
      const totalEl = h('strong', {});
      const draw = () => {
        linesBox.replaceChildren(...items.map((it, i) => {
          const sel = h('select', { onchange: () => { it.product_id = sel.value; const p = cat.products.find((x) => String(x.id) === sel.value); it.price = p && p.price != null ? p.price : ''; draw(); } },
            h('option', { value: '' }, '— ' + T('product') + ' —'), cat.products.map((p) => h('option', { value: p.id, selected: String(p.id) === String(it.product_id) }, pname(p))));
          return h('div', { class: 'lrow' }, sel,
            h('input', { type: 'number', min: '1', step: '1', value: it.qty, class: 'q', oninput: (e) => { it.qty = e.target.value; sum(); } }),
            h('input', { type: 'number', min: '0', step: 'any', value: it.price, class: 'q', placeholder: T('price'), oninput: (e) => { it.price = e.target.value; sum(); } }),
            items.length > 1 ? h('button', { type: 'button', class: 'x', onclick: () => { items.splice(i, 1); draw(); } }, '×') : null);
        }));
        sum();
      };
      const sum = () => { totalEl.textContent = fm(items.reduce((a, i) => a + (Number(i.qty) || 0) * (Number(i.price) || 0), 0)); };
      draw();
      body.append(h('form', { onsubmit: async (e) => {
        e.preventDefault(); err.textContent = '';
        try {
          const payload = { items: items.filter((i) => i.product_id).map((i) => ({ product_id: Number(i.product_id), qty: Number(i.qty), price: i.price === '' ? undefined : Number(i.price) })), address: addrI.value, notes: notesI.value };
          if (who.value) payload.customer_id = Number(who.value); else { payload.name = nameI.value; payload.phone = phoneI.value; }
          await api('POST', '/api/orders/manual', payload); close(); toast(T('saved')); App.checkAlerts(); App.refresh();
        } catch (x) { err.textContent = x.message; }
      } },
      h('p', { class: 'muted' }, T('manual_order_help')),
      h('label', { class: 'field' }, T('customer'), who),
      h('div', { class: 'formgrid' }, nameI, phoneI, addrI, notesI),
      h('h3', { class: 'sub' }, T('items')), linesBox, btn('+ ' + T('add_line'), () => { items.push({ product_id: '', qty: 1, price: '' }); draw(); }, 'ghost small'),
      h('p', {}, T('total'), ': ', totalEl), err,
      h('div', { class: 'dlg-actions' }, btn(T('cancel'), close, 'ghost'), h('button', { class: 'btn gold', type: 'submit' }, T('save')))));
    }, { wide: true });
  };

  App.route('/orders', async (_p, q) => {
    const filter = q.s || 'open';
    const data = await get('/api/orders');
    App.newOrders = data.orders.filter((o) => o.status === 'new').length; App.badges();
    const shown = data.orders.filter((o) => (filter === 'open' ? ['new', 'confirmed'].includes(o.status) : filter === 'all' ? true : o.status === filter));
    const chip = (key, label) => h('a', { href: `#/orders?s=${key}`, class: key === filter ? 'on' : '' }, label);
    return [
      head(T('nav_orders'), btn('+ ' + T('new_order'), () => App.orderForm(), 'gold')),
      h('nav', { class: 'tabs' }, chip('open', T('open_orders')), ST.map((s) => chip(s, T(`status_${s}`))), chip('all', T('all'))),
      shown.length ? shown.map((o) => h('div', { class: `card ordercard${o.status === 'new' ? ' fresh' : ''}` },
        h('div', { class: 'top' }, h('div', {}, h('strong', {}, `#${o.id} · ${o.customer_name}`), ' ', pill(o.source === 'website' ? 'new' : 'confirmed', T(`src_${o.source}`)), ' ', stPill(o.status)),
          h('strong', {}, fm(o.total))),
        h('div', { class: 'muted' }, `${dt(o.created_at)} · ${o.phone}${o.address ? ` · ${o.address}` : ''}`),
        h('ul', {}, o.items.map((i) => h('li', {}, `${i.qty} × ${pname(i)} — ${fm(i.qty * i.price)}`))),
        o.notes ? h('div', { class: 'muted' }, `“${o.notes}”`) : null,
        h('div', { class: 'row-actions wrap' },
          o.status === 'new' ? btn(T('confirm'), () => setStatus(o, 'confirmed'), 'small') : null,
          ['new', 'confirmed'].includes(o.status) ? btn(T('mark_delivered'), () => setStatus(o, 'delivered'), 'small gold') : null,
          ['new', 'confirmed'].includes(o.status) ? btn(T('cancel_order'), () => setStatus(o, 'cancelled'), 'small ghost') : null,
          o.status === 'delivered' && o.invoice_id ? link(`${T('invoice')} #${o.invoice_id}`, `#/sales/${o.invoice_id}`, 'small ghost') : null,
          o.status === 'cancelled' ? btn(T('reopen'), () => setStatus(o, 'new'), 'small ghost') : null,
          h('a', { class: 'btn small ghost', href: App.waLink(o.phone, `${T('wa_order_hi')} #${o.id}`), target: '_blank', rel: 'noopener' }, 'WhatsApp'),
          App.isAdmin() ? btn(T('delete'), async () => { if (!App.confirm()) return; try { await api('DELETE', `/api/orders/${o.id}`); App.refresh(); } catch (e) { fail(e); } }, 'small danger') : null))) : empty(T('no_orders')),
    ];
  });
  async function setStatus(o, status) {
    try { await api('PUT', `/api/orders/${o.id}`, { status }); toast(T('saved')); App.checkAlerts(); App.refresh(); } catch (e) { fail(e); }
  }

  /* ----------------------------------------------- invoices (sales/purchases) */
  const KIND = {
    sale: { base: '/sales', url: '/api/sales', partyUrl: '/api/customers', pkey: 'customer_id', party: 'customer', parties: 'customers', newParty: 'new_customer', no: 'invoice', pay: 'receive_payment' },
    purchase: { base: '/purchases', url: '/api/purchases', partyUrl: '/api/suppliers', pkey: 'supplier_id', party: 'supplier', parties: 'suppliers', newParty: 'new_supplier', no: 'purchase', pay: 'pay_supplier' },
  };
  const partyFields = () => [{ key: 'name', label: T('name'), required: true, full: true }, { key: 'phone', label: T('phone'), type: 'tel' }, { key: 'address', label: T('address') }, { key: 'notes', label: T('notes'), full: true }];

  function tabsFor(kind, on) {
    const K = KIND[kind];
    const t = [[T(kind === 'sale' ? 'invoices' : 'purchases'), `#${K.base}`, 'docs'], [T(K.parties), `#${K.base}/${K.parties}`, 'parties']];
    if (kind === 'purchase') t.push([T('expenses'), '#/purchases/expenses', 'expenses']);
    return tabs(t, on);
  }

  function docList(kind) {
    const K = KIND[kind];
    return async (_p, q) => {
      const month = q.month || '', status = q.status || '', text = (q.q || '').toLowerCase();
      const data = await get(`${K.url}${App.qs({ month, status })}`);
      let rows = data.rows;
      if (text) rows = rows.filter((r) => `${r.party_name || ''} ${r.id} ${r.note || ''}`.toLowerCase().includes(text));
      const go = (patch) => { const n = { month, status, q: q.q || '', ...patch }; App.go(`${K.base}${App.qs(n)}`); };
      const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
      const cols = [
        { label: '#', render: (r) => `#${r.id}` }, { label: T('date'), key: 'date' }, { label: T(K.party), render: (r) => r.party_name || (kind === 'sale' ? T('walk_in') : '—') },
        kind === 'sale' ? { label: T('channel'), render: (r) => T(`ch_${r.channel}`) } : null,
        { label: T('total'), num: true, render: (r) => fm(r.total) }, { label: T('paid'), num: true, render: (r) => fm(r.paid) }, { label: T('due'), num: true, render: (r) => fm(r.due) }, { label: T('status'), render: payPill },
      ].filter(Boolean);
      return [
        head(T(kind === 'sale' ? 'nav_sales' : 'nav_purchases'), link('+ ' + T(kind === 'sale' ? 'new_invoice' : 'new_purchase'), `#${K.base}/new`, 'gold')),
        tabsFor(kind, 'docs'),
        h('div', { class: 'filters' },
          h('input', { type: 'search', placeholder: T('search'), value: q.q || '', onchange: (e) => go({ q: e.target.value }) }),
          h('input', { type: 'month', value: month, onchange: (e) => go({ month: e.target.value }) }),
          h('select', { onchange: (e) => go({ status: e.target.value }) }, [['', T('all')], ['unpaid', T('unpaid_only')]].map(([v, l]) => h('option', { value: v, selected: v === status }, l)))),
        table(cols, rows, { onRow: (r) => App.go(`${K.base}/${r.id}`), foot: rows.length ? cols.map((c, i) => (i === 0 ? T('total') : c.label === T('total') ? fm(sum('total')) : c.label === T('paid') ? fm(sum('paid')) : c.label === T('due') ? fm(sum('due')) : '')) : null }),
      ];
    };
  }

  function docView(kind) {
    const K = KIND[kind];
    return async ({ id }) => {
      const d = await get(`${K.url}/${id}`);
      const name = d.party ? d.party.name : (kind === 'sale' ? T('walk_in') : '—');
      const cols = kind === 'sale'
        ? [{ label: T('product'), render: (l) => l.name }, { label: T('qty'), num: true, render: (l) => fn(l.qty) }, { label: T('price'), num: true, render: (l) => fm(l.price) }, { label: T('total'), num: true, render: (l) => fm(l.qty * l.price) }]
        : [{ label: T('ingredient'), render: (l) => pname(l) }, { label: T('qty'), num: true, render: (l) => `${fn(l.qty)} ${l.unit}` }, { label: T('unit_price'), num: true, render: (l) => fm(l.total / l.qty, 4) }, { label: T('total'), num: true, render: (l) => fm(l.total) }];
      const waText = () => {
        const L = d.lines.map((l) => `• ${fn(l.qty)} × ${l.name} — ${fm(l.qty * l.price)}`);
        return [`${App.S.store_name || 'Chocolatique'} — ${T('invoice')} #${d.id}`, d.date, '', ...L, '', `${T('total')}: ${fm(d.total)}`, d.paid ? `${T('paid')}: ${fm(d.paid)}` : null, d.due > 0.005 ? `${T('due')}: ${fm(d.due)}` : T('paid_in_full')].filter((x) => x !== null).join('\n');
      };
      return [
        head(`${T(K.no)} #${d.id}`, payPill(d),
          link(T('print'), `/admin/print.html?type=${kind}&id=${d.id}`, 'ghost'),
          kind === 'sale' ? h('a', { class: 'btn ghost', target: '_blank', rel: 'noopener', href: App.waLink(d.party && d.party.phone, waText()) }, T('share_whatsapp')) : null,
          !d.order_id ? link(T('edit'), `#${K.base}/${d.id}/edit`, 'ghost') : null,
          btn(T('delete'), async () => { if (!App.confirm()) return; try { await api('DELETE', `${K.url}/${d.id}`); App.go(K.base); } catch (e) { fail(e); } }, 'danger')),
        h('div', { class: 'card' }, h('div', { class: 'kvrow' },
          h('div', {}, h('div', { class: 'muted' }, T(K.party)), d.party ? h('a', { href: `#${K.base}/${K.parties}/${d.party.id}` }, h('strong', {}, name)) : h('strong', {}, name), d.party && d.party.phone ? h('div', { class: 'muted' }, d.party.phone) : null),
          h('div', {}, h('div', { class: 'muted' }, T('date')), h('strong', {}, d.date)),
          kind === 'sale' ? h('div', {}, h('div', { class: 'muted' }, T('channel')), h('strong', {}, T(`ch_${d.channel}`))) : null,
          d.order_id ? h('div', {}, h('div', { class: 'muted' }, T('from_order')), h('a', { href: '#/orders?s=all' }, `#${d.order_id}`)) : null),
        d.note ? h('p', { class: 'muted' }, d.note) : null),
        table(cols, d.lines, { foot: [...cols.slice(0, -1).map((c, i) => (i === 0 ? T('total') : '')), fm(d.total)] }),
        h('div', { class: 'card' }, h('div', { class: 'bar' }, h('h2', {}, T('payments')), d.due > 0.005 ? btn('+ ' + T('add_payment'), () => payModal(`${K.url}/${d.id}/payments`, d.due, T('add_payment')), 'gold small') : null),
          h('div', { class: 'kv' }, h('div', { class: 'k' }, T('total')), h('div', { class: 'v' }, fm(d.total)), h('div', { class: 'k' }, T('paid')), h('div', { class: 'v pos' }, fm(d.paid)), h('div', { class: 'strong' }, h('span', {}, T('due')), h('span', {}, fm(d.due)))),
          d.payments.length ? table([{ label: T('date'), key: 'date' }, { label: T('note'), render: (p) => p.note || '' }, { label: T('amount'), num: true, render: (p) => fm(p.amount) },
            { label: '', render: (p) => btn('×', async () => { if (!App.confirm()) return; try { await api('DELETE', `/api/payments/${p.id}`); App.refresh(); } catch (e) { fail(e); } }, 'small danger') }], d.payments) : null),
      ];
    };
  }

  function payModal(url, due, title, after) {
    App.formModal({ title, values: { amount: due.toFixed(2), date: today(), note: '' }, fields: [
      { key: 'amount', label: T('amount'), type: 'number', required: true }, { key: 'date', label: T('date'), type: 'date', required: true }, { key: 'note', label: T('note'), full: true }],
    onSubmit: async (v) => { await api('POST', url, { amount: Number(v.amount), date: v.date, note: v.note }); toast(T('saved')); (after || App.refresh)(); } });
  }

  function docForm(kind) {
    const K = KIND[kind];
    return async ({ id }) => {
      const doc = id ? await get(`${K.url}/${id}`) : null;
      const parties = (await get(K.partyUrl)).rows;
      const cat = kind === 'sale' ? await App.catalog() : null;
      let ings = kind === 'purchase' ? (await get('/api/ingredients')).rows : null;
      const st = { party: doc ? doc[K.pkey] || '' : '', date: doc ? doc.date : today(), channel: doc ? doc.channel : 'Shop', note: doc ? doc.note : '', paid: doc ? '' : '',
        lines: doc ? doc.lines.map((l) => (kind === 'sale' ? { product_id: l.product_id || '', name: l.name, qty: l.qty, price: l.price } : { ingredient_id: l.ingredient_id, qty: l.qty, total: l.total })) : [kind === 'sale' ? { product_id: '', name: '', qty: 1, price: '' } : { ingredient_id: '', qty: '', total: '' }] };
      const err = h('p', { class: 'err', role: 'alert' });
      const linesBox = h('div', { class: 'lines' }), totalEl = h('strong', {});
      const total = () => st.lines.reduce((a, l) => a + (kind === 'sale' ? (Number(l.qty) || 0) * (Number(l.price) || 0) : Number(l.total) || 0), 0);
      const sum = () => { totalEl.textContent = fm(total()); };
      const drawLines = () => {
        linesBox.replaceChildren(...st.lines.map((l, i) => {
          const del = st.lines.length > 1 ? h('button', { type: 'button', class: 'x', 'aria-label': T('delete'), onclick: () => { st.lines.splice(i, 1); drawLines(); } }, '×') : null;
          if (kind === 'sale') {
            const sel = h('select', { onchange: () => { l.product_id = sel.value; const p = cat.products.find((x) => String(x.id) === sel.value); if (p) { l.name = pname(p); if (p.price != null) l.price = p.price; } drawLines(); } },
              h('option', { value: '' }, '— ' + T('product') + ' —'), cat.products.map((p) => h('option', { value: p.id, selected: String(p.id) === String(l.product_id) }, pname(p))));
            return h('div', { class: 'lrow' }, l.product_id ? sel : h('div', { class: 'stack' }, sel, h('input', { placeholder: T('custom_item'), value: l.name, oninput: (e) => { l.name = e.target.value; } })),
              h('input', { type: 'number', min: '0', step: 'any', class: 'q', value: l.qty, 'aria-label': T('qty'), oninput: (e) => { l.qty = e.target.value; sum(); } }),
              h('input', { type: 'number', min: '0', step: 'any', class: 'q', value: l.price, placeholder: T('price'), 'aria-label': T('price'), oninput: (e) => { l.price = e.target.value; sum(); } }), del);
          }
          const g = ings.find((x) => String(x.id) === String(l.ingredient_id));
          const sel = h('select', { onchange: async () => {
            if (sel.value === '__new') { sel.value = l.ingredient_id; App.ingredientForm(async (created) => { ings = (await get('/api/ingredients')).rows; l.ingredient_id = created.id; drawLines(); }); return; }
            l.ingredient_id = sel.value; drawLines();
          } }, h('option', { value: '' }, '— ' + T('ingredient') + ' —'), ings.map((x) => h('option', { value: x.id, selected: String(x.id) === String(l.ingredient_id) }, `${pname(x)} (${x.unit})`)), h('option', { value: '__new' }, '+ ' + T('new_ingredient')));
          const unitTxt = () => { const u = Number(l.qty) > 0 && Number(l.total) > 0 ? Number(l.total) / Number(l.qty) : null; const gg = ings.find((y) => String(y.id) === String(l.ingredient_id)); return u === null ? '' : `${fm(u, 4)}/${gg ? gg.unit : ''}`; };
          const upEl = h('small', { class: 'muted up' }, unitTxt());
          return h('div', { class: 'lrow' }, sel,
            h('input', { type: 'number', min: '0', step: 'any', class: 'q', value: l.qty, placeholder: g ? g.unit : T('qty'), 'aria-label': T('qty'), oninput: (e) => { l.qty = e.target.value; upEl.textContent = unitTxt(); sum(); } }),
            h('input', { type: 'number', min: '0', step: 'any', class: 'q', value: l.total, placeholder: T('total'), 'aria-label': T('total'), oninput: (e) => { l.total = e.target.value; upEl.textContent = unitTxt(); sum(); } }),
            upEl, del);
        }));
        sum();
      };
      drawLines();

      const partySel = h('select', { onchange: () => {
        if (partySel.value === '__new') { partySel.value = st.party; App.formModal({ title: T(K.newParty), fields: partyFields(), onSubmit: async (v) => { const c = await api('POST', K.partyUrl, v); parties.push(c); st.party = c.id; redrawParty(); } }); return; }
        st.party = partySel.value;
      } });
      const redrawParty = () => partySel.replaceChildren(h('option', { value: '' }, kind === 'sale' ? '— ' + T('walk_in') + ' —' : '— ' + T('supplier') + ' —'), ...parties.map((p) => h('option', { value: p.id, selected: String(p.id) === String(st.party) }, p.name)), h('option', { value: '__new' }, '+ ' + T(K.newParty)));
      redrawParty();

      const save = async (e) => {
        e.preventDefault(); err.textContent = '';
        const body = { [K.pkey]: st.party ? Number(st.party) : null, date: st.date, note: st.note,
          lines: st.lines.filter((l) => (kind === 'sale' ? (l.product_id || l.name) : l.ingredient_id)).map((l) => (kind === 'sale' ? { product_id: l.product_id ? Number(l.product_id) : null, name: l.name, qty: Number(l.qty), price: Number(l.price) } : { ingredient_id: Number(l.ingredient_id), qty: Number(l.qty), total: Number(l.total) })) };
        if (kind === 'sale') body.channel = st.channel;
        if (!doc && st.paid !== '') body.paid = Number(st.paid);
        try {
          const saved = doc ? await api('PUT', `${K.url}/${id}`, body) : await api('POST', K.url, body);
          toast(T('saved'));
          if (kind === 'purchase') { const c = await get('/api/cost/pending'); App.pendingCost = c.changes.length; App.badges(); if (c.changes.length) { App.go(`${K.base}/${saved.id}`); App.updateCost(); return; } }
          App.go(`${K.base}/${saved.id}`);
        } catch (x) { err.textContent = x.message; }
      };
      return [
        head(doc ? `${T('edit')} #${doc.id}` : T(kind === 'sale' ? 'new_invoice' : 'new_purchase')),
        h('form', { class: 'card', onsubmit: save },
          h('div', { class: 'formgrid' },
            h('label', { class: 'field' }, T(K.party), partySel),
            h('label', { class: 'field' }, T('date'), h('input', { type: 'date', value: st.date, required: true, onchange: (e) => { st.date = e.target.value; } })),
            kind === 'sale' ? h('label', { class: 'field' }, T('channel'), h('select', { onchange: (e) => { st.channel = e.target.value; } }, (App.cat.channels).map((c) => h('option', { value: c, selected: c === st.channel }, T(`ch_${c}`))))) : null),
          h('h3', { class: 'sub' }, T('items')), linesBox, btn('+ ' + T('add_line'), () => { st.lines.push(kind === 'sale' ? { product_id: '', name: '', qty: 1, price: '' } : { ingredient_id: '', qty: '', total: '' }); drawLines(); }, 'ghost small'),
          h('div', { class: 'totalbar' }, T('total'), ': ', totalEl),
          kind === 'purchase' ? h('p', { class: 'muted' }, T('purchase_price_help')) : null,
          h('div', { class: 'formgrid' },
            !doc ? h('label', { class: 'field' }, T('paid_now'), h('input', { type: 'number', min: '0', step: 'any', placeholder: '0', oninput: (e) => { st.paid = e.target.value; } }), h('span', { class: 'help' }, T('paid_now_help'))) : null,
            h('label', { class: 'field' }, T('note'), h('input', { value: st.note, oninput: (e) => { st.note = e.target.value; } }))),
          err, h('div', { class: 'dlg-actions' }, link(T('cancel'), doc ? `#${K.base}/${doc.id}` : `#${K.base}`, 'ghost'), h('button', { class: 'btn gold', type: 'submit' }, T('save')))),
      ];
    };
  }

  /* ----------------------------------------------- customers / suppliers */
  function partyList(kind) {
    const K = KIND[kind];
    return async () => {
      const data = await get(K.partyUrl);
      const add = () => App.formModal({ title: T(K.newParty), fields: partyFields(), onSubmit: async (v) => { const c = await api('POST', K.partyUrl, v); toast(T('saved')); App.go(`${K.base}/${K.parties}/${c.id}`); } });
      return [
        head(T(kind === 'sale' ? 'nav_sales' : 'nav_purchases'), btn('+ ' + T(K.newParty), add, 'gold')), tabsFor(kind, 'parties'),
        h('div', { class: 'tiles' }, tile(T(kind === 'sale' ? 'customers_owe' : 'we_owe'), fm(data.totalDue))),
        table([{ label: T('name'), render: (r) => h('strong', {}, r.name) }, { label: T('phone'), key: 'phone' }, { label: T('invoices'), num: true, render: (r) => r.count }, { label: T('invoiced'), num: true, render: (r) => fm(r.invoiced) }, { label: T('paid'), num: true, render: (r) => fm(r.paid) }, { label: T('balance'), num: true, render: (r) => h('strong', { class: r.due > 0.005 ? 'neg' : '' }, fm(r.due)) }],
        data.rows, { onRow: (r) => App.go(`${K.base}/${K.parties}/${r.id}`), empty: T('none_yet') }),
      ];
    };
  }

  function partyView(kind) {
    const K = KIND[kind];
    return async ({ id }) => {
      const d = await get(`${K.partyUrl}/${id}`);
      const p = d.party;
      const wa = kind === 'sale' && p.phone && d.totals.due > 0.005 ? h('a', { class: 'btn ghost', target: '_blank', rel: 'noopener', href: App.waLink(p.phone, `${T('wa_reminder_1')} ${p.name}, ${T('wa_reminder_2')} ${fm(d.totals.due)}. ${App.S.store_name || ''}`) }, T('remind_whatsapp')) : null;
      const edit = () => App.formModal({ title: T('edit'), fields: partyFields(), values: p, onSubmit: async (v) => { await api('PUT', `${K.partyUrl}/${id}`, v); toast(T('saved')); App.refresh(); } });
      return [
        head(p.name, d.totals.due > 0.005 ? btn(T(K.pay), () => payModal(`${K.partyUrl}/${id}/pay`, d.totals.due, T(K.pay)), 'gold') : null,
          link('+ ' + T(kind === 'sale' ? 'new_invoice' : 'new_purchase'), `#${K.base}/new?party=${id}`, 'ghost'), wa,
          App.isAdmin() ? link(T('statement'), `#/reports/statement/${kind === 'sale' ? 'customer' : 'supplier'}/${id}`, 'ghost') : null,
          btn(T('edit'), edit, 'ghost'),
          btn(T('delete'), async () => { if (!App.confirm()) return; try { await api('DELETE', `${K.partyUrl}/${id}`); App.go(`${K.base}/${K.parties}`); } catch (e) { fail(e); } }, 'danger')),
        h('div', { class: 'muted' }, [p.phone, p.address, p.notes].filter(Boolean).join(' · ')),
        h('div', { class: 'tiles' }, tile(T('invoiced'), fm(d.totals.invoiced)), tile(T('paid'), fm(d.totals.paid)), tile(T('balance'), fm(d.totals.due), { cls: d.totals.due > 0.005 ? 'hot' : '' })),
        table([{ label: '#', render: (r) => `#${r.id}` }, { label: T('date'), key: 'date' }, { label: T('total'), num: true, render: (r) => fm(r.total) }, { label: T('paid'), num: true, render: (r) => fm(r.paid) }, { label: T('due'), num: true, render: (r) => fm(r.due) }, { label: T('status'), render: payPill }],
        d.docs, { onRow: (r) => App.go(`${K.base}/${r.id}`) }),
      ];
    };
  }

  /* ---------------------------------------------------------------- expenses */
  App.route('/purchases/expenses', async (_p, q) => {
    const month = q.month || App.thisMonth();
    const first = `${month}-01`, last = `${month}-31`;
    const data = await get(`/api/expenses${App.qs({ from: first, to: last })}`);
    const fields = () => [{ key: 'date', label: T('date'), type: 'date', required: true }, { key: 'category', label: T('category'), type: 'select', options: data.categories.map((c) => [c, T(`cat_${c}`)]) },
      { key: 'description', label: T('description'), full: true }, { key: 'amount', label: T('amount'), type: 'number', required: true }, { key: 'note', label: T('note'), full: true }];
    const open = (row) => App.formModal({ title: row ? T('edit') : T('add_expense'), fields: fields(), values: row || { date: today(), category: data.categories[0] },
      onSubmit: async (v) => { const b = { ...v, amount: Number(v.amount) }; if (row) await api('PUT', `/api/expenses/${row.id}`, b); else await api('POST', '/api/expenses', b); toast(T('saved')); App.refresh(); } });
    return [
      head(T('nav_purchases'), btn('+ ' + T('add_expense'), () => open(null), 'gold')), tabsFor('purchase', 'expenses'),
      h('div', { class: 'filters' }, h('input', { type: 'month', value: month, onchange: (e) => App.go(`/purchases/expenses?month=${e.target.value}`) }), h('strong', {}, `${T('total')}: ${fm(data.total)}`)),
      h('p', { class: 'muted' }, T('expenses_help')),
      table([{ label: T('date'), key: 'date' }, { label: T('category'), render: (r) => T(`cat_${r.category}`) }, { label: T('description'), key: 'description' }, { label: T('amount'), num: true, render: (r) => fm(r.amount) },
        { label: '', render: (r) => btn('×', async () => { if (!App.confirm()) return; try { await api('DELETE', `/api/expenses/${r.id}`); App.refresh(); } catch (e) { fail(e); } }, 'small danger') }],
      data.rows, { onRow: open }),
    ];
  }, { admin: true });

  for (const kind of ['sale', 'purchase']) {
    const K = KIND[kind], opt = kind === 'purchase' ? { admin: true } : {};
    App.route(K.base, docList(kind), opt);
    App.route(`${K.base}/${K.parties}`, partyList(kind), opt);
    App.route(`${K.base}/${K.parties}/:id`, partyView(kind), opt);
    App.route(`${K.base}/new`, async (p, q) => { const f = await docForm(kind)({ id: null }); if (q.party) setTimeout(() => { const s = document.querySelector('.card select'); if (s) { s.value = q.party; s.dispatchEvent(new Event('change')); } }, 0); return f; }, opt);
    App.route(`${K.base}/:id/edit`, (p) => docForm(kind)(p), opt);
    App.route(`${K.base}/:id`, docView(kind), opt);
  }

})();
