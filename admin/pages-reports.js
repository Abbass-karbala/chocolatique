/* Reports (generic renderer + print + CSV), customer/supplier statements, monthly results. Admin only. */
(() => {
  'use strict';
  const App = window.App;
  const { h, T, fm, fp, fn, api, get, fail, btn, link, head, table, tile, toast } = App;

  const GROUPS = {
    sales: ['product', 'customer', 'channel', 'month', 'day', 'invoice'],
    purchases: ['supplier', 'ingredient', 'month', 'day', 'invoice'],
    expenses: ['category', 'month', 'day', 'list'],
  };
  // [key, titleKey, descKey, {dated, groups, params}]
  const HUB = [
    ['rg_sales', [['sales', 'r_sales', 'rd_sales', {}], ['customers', 'r_customers', 'rd_customers', { nodate: true }], ['aging', 'r_aging_sales', 'rd_aging', { nodate: true, kind: 'sale' }]]],
    ['rg_purchases', [['purchases', 'r_purchases', 'rd_purchases', {}], ['suppliers', 'r_suppliers', 'rd_suppliers', { nodate: true }], ['goods', 'r_goods', 'rd_goods', {}], ['aging', 'r_aging_purchases', 'rd_aging_p', { nodate: true, kind: 'purchase' }]]],
    ['rg_profit', [['profit', 'r_profit', 'rd_profit', {}], ['netprofit', 'r_netprofit', 'rd_netprofit', {}], ['monthly', 'nav_monthly', 'rd_monthly', { page: true }]]],
    ['rg_money', [['expenses', 'r_expenses', 'rd_expenses', {}], ['income', 'r_income', 'rd_income', {}], ['cashflow', 'r_cashflow', 'rd_cashflow', {}], ['journal', 'r_journal', 'rd_journal', {}]]],
  ];

  App.route('/reports', () => [
    head(T('nav_reports')), h('p', { class: 'muted' }, T('reports_help')),
    HUB.map(([gk, items]) => h('section', {}, h('h3', { class: 'sub' }, T(gk)),
      h('div', { class: 'hub' }, items.map(([name, title, desc, o]) => h('a', { class: 'hubcard', href: o.page ? `#/reports/${name}` : `#/reports/r/${name}${o.kind ? `?kind=${o.kind}` : ''}` }, h('strong', {}, T(title)), h('span', { class: 'muted' }, T(desc))))))),
  ], { admin: true });

  /* ----------------------------------------------------------- date presets */
  const pad = (n) => String(n).padStart(2, '0');
  const lastDay = (y, m) => new Date(y, m, 0).getDate();
  function preset(k) {
    const t = new Date(), y = t.getFullYear(), m = t.getMonth() + 1;
    if (k === 'month') return [`${y}-${pad(m)}-01`, `${y}-${pad(m)}-${lastDay(y, m)}`];
    if (k === 'last') { const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1; return [`${py}-${pad(pm)}-01`, `${py}-${pad(pm)}-${lastDay(py, pm)}`]; }
    if (k === 'year') return [`${y}-01-01`, `${y}-12-31`];
    return ['', ''];
  }

  function cell(c, r) {
    const v = r[c.key];
    if (c.type === 'money') return v === null || v === undefined ? '—' : fm(v);
    if (c.type === 'money4') return v === null || v === undefined ? '—' : fm(v, 4);
    if (c.type === 'num') return v === null || v === undefined ? '—' : fn(v);
    if (c.type === 'pct') return v === null || v === undefined ? '—' : fp(v);
    if (c.tr === 'row') return T(`${r.tr || ''}${v}`);
    if (c.tr !== undefined) return T(`${c.tr}${v}`);
    if (c.link === 'sale') return h('a', { href: `#/sales/${v}` }, `#${v}`);
    if (c.link === 'purchase') return h('a', { href: `#/purchases/${v}` }, `#${v}`);
    if (c.link === 'customer' || c.link === 'supplier') return h('a', { href: `#/${c.link === 'customer' ? 'sales/customers' : 'purchases/suppliers'}/${r[c.idKey]}` }, v);
    if (c.key === 'name' && ['product', 'customer', 'channel', 'supplier', 'ingredient'].includes(c.label) === false && /^\d{4}-\d{2}/.test(String(v))) return v;
    return v === null || v === undefined ? '' : v;
  }

  function csv(rep) {
    const esc = (x) => { const s = String(x ?? ''); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const raw = (c, r) => (c.type === 'money' || c.type === 'money4' || c.type === 'num' ? (r[c.key] ?? '') : c.type === 'pct' ? (r[c.key] === null ? '' : (r[c.key] * 100).toFixed(2)) : c.tr === 'row' ? T(`${r.tr || ''}${r[c.key]}`) : c.tr !== undefined ? T(`${c.tr}${r[c.key]}`) : (r[c.key] ?? ''));
    const lines = [rep.columns.map((c) => esc(T(c.label))).join(',')];
    for (const r of rep.rows) lines.push(rep.columns.map((c) => esc(raw(c, r))).join(','));
    if (Object.keys(rep.totals).length) lines.push(rep.columns.map((c, i) => esc(i === 0 ? T('total') : (rep.totals[c.key] ?? ''))).join(','));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${rep.title.replace(/^r_/, '')}-${App.today()}.csv` });
    document.body.append(a); a.click(); a.remove();
  }

  App.route('/reports/r/:name', async ({ name }, q) => {
    const nodate = ['customers', 'suppliers', 'aging'].includes(name);
    const pk = q.p || (q.from !== undefined || q.to !== undefined ? 'custom' : 'month');
    let [from, to] = pk === 'custom' ? [q.from || '', q.to || ''] : preset(pk);
    const groups = GROUPS[name], group = q.group || (groups ? groups[0] : '');
    const rep = await get(`/api/reports/${name}${App.qs({ from: nodate ? '' : from, to: nodate ? '' : to, group, kind: q.kind })}`);
    const go = (patch) => { const n = { p: pk, from, to, group, kind: q.kind, ...patch }; if (n.p !== 'custom') { delete n.from; delete n.to; } App.go(`/reports/r/${name}${App.qs(n)}`); };
    const chips = [['month', 'p_month'], ['last', 'p_last'], ['year', 'p_year'], ['all', 'p_all']];
    const body = rep.rows.length ? h('div', { class: 'tablewrap' }, h('table', { class: 'rt' },
      h('thead', {}, h('tr', {}, rep.columns.map((c) => h('th', { class: ['money', 'money4', 'num', 'pct'].includes(c.type) ? 'num' : '' }, T(c.label))))),
      h('tbody', {}, rep.rows.map((r) => h('tr', { class: r.bold ? 'bold' : '' }, rep.columns.map((c) => h('td', { 'data-label': T(c.label), class: ['money', 'money4', 'num', 'pct'].includes(c.type) ? 'num' : '' }, cell(c, r)))))),
      Object.keys(rep.totals).length ? h('tfoot', {}, h('tr', {}, rep.columns.map((c, i) => h('td', { 'data-label': T(c.label), class: ['money', 'money4', 'num', 'pct'].includes(c.type) ? 'num' : '' }, i === 0 ? T('total') : c.key in rep.totals ? (c.type === 'money' ? fm(rep.totals[c.key]) : c.type === 'pct' ? fp(rep.totals[c.key]) : fn(rep.totals[c.key])) : '')))) : null)) : App.empty(T('no_data'));
    const periodTxt = nodate ? T('p_asof') + ' ' + App.today() : (from || to ? `${from || '…'} → ${to || '…'}` : T('p_all'));
    return [
      head(T(rep.title), btn(T('print'), () => window.print(), 'ghost'), btn('CSV', () => csv(rep), 'ghost')),
      h('div', { class: 'filters noprint' },
        nodate ? null : h('div', { class: 'chips' }, chips.map(([k, l]) => h('button', { class: k === pk ? 'on' : '', onclick: () => go({ p: k }) }, T(l))), h('button', { class: pk === 'custom' ? 'on' : '', onclick: () => go({ p: 'custom' }) }, T('p_custom'))),
        !nodate && pk === 'custom' ? [h('input', { type: 'date', value: from, onchange: (e) => go({ p: 'custom', from: e.target.value }) }), h('input', { type: 'date', value: to, onchange: (e) => go({ p: 'custom', to: e.target.value }) })] : null,
        groups ? h('label', { class: 'inl' }, T('group_by'), h('select', { onchange: (e) => go({ group: e.target.value }) }, groups.map((g) => h('option', { value: g, selected: g === group }, T(`g_${g}`))))) : null),
      h('div', { class: 'printhead' }, h('strong', {}, `${App.S.store_name} — ${T(rep.title)}`), h('div', { class: 'muted' }, periodTxt)),
      rep.summary && rep.summary.length ? h('div', { class: 'tiles' }, rep.summary.map((s) => tile(T(s.key), s.type === 'pct' ? fp(s.value) : fm(s.value), { cls: s.value < 0 ? 'hot' : '' }))) : null,
      body, rep.note ? h('p', { class: 'muted' }, T(rep.note)) : null,
    ];
  }, { admin: true });

  /* -------------------------------------------------------------- statements */
  App.route('/reports/statement/:kind/:id', async ({ kind, id }, q) => {
    const from = q.from || '', to = q.to || '';
    const d = await get(`/api/statement/${kind}/${id}${App.qs({ from, to })}`);
    const sale = kind === 'customer';
    const filt = (patch) => App.go(`/reports/statement/${kind}/${id}${App.qs({ from, to, ...patch })}`);
    return [
      head(`${T('statement')}: ${d.party.name}`, btn(T('print'), () => window.print(), 'ghost'), link(T('back'), `#/${sale ? 'sales/customers' : 'purchases/suppliers'}/${id}`, 'ghost')),
      h('div', { class: 'filters noprint' }, h('input', { type: 'date', value: from, onchange: (e) => filt({ from: e.target.value }) }), h('input', { type: 'date', value: to, onchange: (e) => filt({ to: e.target.value }) })),
      h('div', { class: 'printhead' }, h('strong', {}, `${App.S.store_name} — ${T('statement')}`), h('div', {}, d.party.name, d.party.phone ? ` · ${d.party.phone}` : ''), h('div', { class: 'muted' }, `${from || '…'} → ${to || App.today()}`)),
      h('div', { class: 'tiles' }, tile(T('opening'), fm(d.opening)), tile(T('closing_balance'), fm(d.closing), { cls: d.closing > 0.005 ? 'hot' : '' })),
      table([
        { label: T('date'), key: 'date' }, { label: T('description'), render: (r) => h('a', { href: `#/${sale ? 'sales' : 'purchases'}/${r.docId}` }, `${r.kind === 'doc' ? T(sale ? 'invoice' : 'purchase') : T('payment')} ${r.ref}${r.note ? ` · ${r.note}` : ''}`) },
        { label: T(sale ? 'invoiced' : 'purchases_n'), num: true, render: (r) => (r.charge ? fm(r.charge) : '') }, { label: T('paid'), num: true, render: (r) => (r.pay ? fm(r.pay) : '') }, { label: T('balance'), num: true, render: (r) => fm(r.balance) },
      ], d.rows, { empty: T('no_data') }),
    ];
  }, { admin: true });

  /* ------------------------------------------------------------------ monthly */
  App.route('/reports/monthly', async (_p, q) => {
    const month = q.month || App.thisMonth();
    const r = await get(`/api/monthly?month=${month}`);
    const fields = [['cash_start', 'm_cash_start'], ['stock_start', 'm_stock_start'], ['stock_end', 'm_stock_end'], ['hours', 'm_hours'], ['pieces_made', 'm_pieces_made'], ['pieces_wasted', 'm_pieces_wasted'], ['pay_taken', 'm_pay_taken'], ['equipment_life', 'm_equip_life']];
    const form = h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault();
      try { await api('PUT', `/api/monthly/${month}`, Object.fromEntries(fields.map(([k]) => [k, form.elements[k].value]))); toast(T('saved')); App.refresh(); } catch (x) { fail(x); }
    } }, h('h2', {}, T('m_inputs')), r.saved ? null : h('p', { class: 'note' }, T('m_prefilled')),
    h('div', { class: 'formgrid' }, fields.map(([k, l]) => h('label', { class: 'field' }, T(l), h('input', { name: k, type: 'number', min: '0', step: 'any', value: r.inputs[k] })))),
    h('div', { class: 'dlg-actions' }, h('button', { class: 'btn gold', type: 'submit' }, T('m_save'))));
    const kv = (k, v, cls) => [h('div', { class: 'k' }, k), h('div', { class: `v ${cls || ''}` }, v)];
    const strong = (k, v) => h('div', { class: 'strong' }, h('span', {}, k), h('span', {}, v));
    const P = r.profit, C = r.cash, H = r.health, S = r.sales;
    const card = (title, ...kids) => h('div', { class: 'card' }, h('h2', {}, title), h('div', { class: 'kv' }, kids));
    return [
      head(T('nav_monthly'), h('input', { type: 'month', value: month, onchange: (e) => App.go(`/reports/monthly?month=${e.target.value}`) }), btn(T('print'), () => window.print(), 'ghost')),
      h('p', { class: 'muted' }, T('m_help2')), form,
      h('div', { class: 'grid2' },
        card(T('m_sales'), ['Supermarket', 'Shop', 'Website', 'WhatsApp'].map((c) => kv(T(`ch_${c}`), fm(S.byChannel[c]))), strong(T('m_sales_total'), fm(S.total)), kv(T('m_pieces_sold'), fn(S.piecesSold)), kv(T('m_cash_received'), fm(S.cashReceived)), kv(T('m_owed'), fm(S.owed)), kv(T('m_payable'), fm(S.payable))),
        card(T('m_spent'), Object.entries(r.spent).map(([k, v]) => kv(T(`cat_${k}`), fm(v))), strong(T('m_spent_total'), fm(r.totalSpent))),
        card(T('m_profit'), kv(T('m_sales_total'), fm(S.total)), kv(T('m_materials'), fm(-P.materialsUsed)), kv(T('m_bills'), fm(-P.bills)), kv(T('m_delivery'), fm(-P.delivery)), kv(T('m_equip_share'), fm(-P.equipmentShare)),
          strong(T('m_before_pay'), fm(P.beforePay)), kv(T('m_fair_labor'), fm(-P.fairLabor)), strong(T('m_real_profit'), fm(P.real)), kv(T('m_real_margin'), fp(P.realMargin)), kv(T('m_testing'), fm(-P.testing)), kv(T('m_after_invest'), fm(P.afterInvestment))),
        card(T('m_cash'), kv(T('m_cash_start'), fm(C.start)), kv(T('m_cash_plus'), fm(C.received)), kv(T('m_cash_minus'), fm(-C.spent)), kv(T('m_cash_pay'), fm(-C.pay)), strong(T('m_cash_end'), fm(C.end)), h('div', { class: 'help muted' }, T('m_cash_end_help'))),
        card(T('m_health'), kv(T('m_avg_price'), fm(H.avgPrice)), kv(T('m_real_cost'), fm(H.realCostPerPiece)), kv(T('m_exp_cost'), H.expectedCost == null ? '—' : fm(H.expectedCost)), kv(T('m_diff'), H.diffVsExpected == null ? '—' : fm(H.diffVsExpected)),
          kv(T('m_real_waste'), fp(H.realWaste)), kv(T('m_plan_waste'), fp(H.plannedWaste)), kv(T('m_invest_pct'), fp(H.investmentPct)), kv(T('m_pph'), fm(H.profitPerHour)), kv(T('m_eph'), fm(H.earningsPerHour))),
        h('div', { class: 'card' }, h('h2', {}, T('m_look')), h('ul', { class: 'insights' }, r.insights.map((i) => h('li', {}, T(`i_${i}`)))))),
    ];
  }, { admin: true });
})();
