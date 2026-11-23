/* Printable invoice / purchase / recipe sheet. Plain DOM, textContent only. */
(() => {
  'use strict';
  const T = (k) => I18N.t(k);
  const q = new URLSearchParams(location.search);
  const type = q.get('type'), id = Number(q.get('id'));
  const h = (tag, a, ...kids) => { const el = document.createElement(tag); for (const [k, v] of Object.entries(a || {})) { if (v == null || v === false) continue; if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v); } for (const kid of kids.flat(Infinity)) { if (kid == null || kid === false) continue; el.append(kid.nodeType ? kid : document.createTextNode(String(kid))); } return el; };
  let cur = '$';
  const fm = (n, d = 2) => I18N.money(n, cur, d);
  const fn = (n, d = 2) => (n == null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d }));
  const pname = (p) => I18N.pick(p, 'name') || '';
  const get = async (u) => { const r = await fetch(u, { credentials: 'same-origin' }); if (r.status === 401) { location.href = '/admin/'; throw new Error('auth'); } const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Error'); return d; };
  const qty = (n, unit) => { if (unit === 'kg' && n < 1) return `${fn(n * 1000, 1)} g`; if (unit === 'L' && n < 1) return `${fn(n * 1000, 1)} ml`; return `${fn(n, 3)} ${unit}`; };
  const doc = document.getElementById('doc'), bar = document.getElementById('bar');
  const toolbar = (...extra) => bar.replaceChildren(h('button', { class: 'btn gold', onclick: () => window.print() }, T('print')), ...extra, h('button', { class: 'lang-toggle', onclick: () => { I18N.setLang(I18N.lang === 'ar' ? 'en' : 'ar'); draw(); } }, I18N.lang === 'ar' ? 'English' : 'العربية'));

  async function draw() {
    I18N.apply();
    try {
      const s = (await get('/api/settings')).settings; cur = s.currency || '$';
      if (type === 'sale' || type === 'purchase') await invoice(s); else if (type === 'recipe') await recipe(s); else doc.textContent = 'Unknown document';
    } catch (e) { if (e.message !== 'auth') doc.textContent = e.message; }
  }

  async function invoice(s) {
    const sale = type === 'sale';
    const d = await get(`/api/${sale ? 'sales' : 'purchases'}/${id}`);
    document.title = `${T(sale ? 'invoice' : 'purchase')} #${d.id}`;
    const status = d.due <= 0.005 ? ['paid', T('paid')] : d.paid > 0.005 ? ['part', T('partial')] : ['due', T('unpaid')];
    const text = () => [`${s.store_name} — ${T('invoice')} #${d.id}`, d.date, '', ...d.lines.map((l) => `• ${fn(l.qty)} × ${l.name} — ${fm(l.qty * l.price)}`), '', `${T('total')}: ${fm(d.total)}`, d.paid ? `${T('paid')}: ${fm(d.paid)}` : null, d.due > 0.005 ? `${T('due')}: ${fm(d.due)}` : T('paid_in_full')].filter((x) => x !== null).join('\n');
    const phone = (d.party && d.party.phone || '').replace(/\D/g, '');
    const wa = phone ? (phone.startsWith('961') || (d.party.phone || '').trim().startsWith('+') ? phone : '961' + phone.replace(/^0/, '')) : '';
    toolbar(sale ? h('a', { class: 'btn ghost', target: '_blank', rel: 'noopener', href: `https://wa.me/${wa}?text=${encodeURIComponent(text())}` }, T('share_whatsapp')) : null);
    doc.replaceChildren(
      h('div', { class: 'top' }, h('div', {}, h('h1', {}, s.store_name || 'Chocolatique'), h('div', { class: 'muted' }, I18N.lang === 'ar' ? s.tagline_ar : s.tagline_en), s.whatsapp_number ? h('div', { class: 'muted' }, `WhatsApp +${s.whatsapp_number}`) : null),
        h('div', { class: 'meta' }, h('h1', {}, `${T(sale ? 'invoice' : 'purchase')} #${d.id}`), h('div', {}, d.date), h('span', { class: `stamp ${status[0]}` }, status[1]))),
      h('div', {}, h('div', { class: 'muted' }, T(sale ? 'customer' : 'supplier')), h('strong', {}, d.party ? d.party.name : T('walk_in')), d.party && d.party.phone ? h('div', {}, d.party.phone) : null, d.party && d.party.address ? h('div', {}, d.party.address) : null),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, T(sale ? 'product' : 'ingredient')), h('th', { class: 'num' }, T('qty')), h('th', { class: 'num' }, T(sale ? 'price' : 'unit_price')), h('th', { class: 'num' }, T('total')))),
        h('tbody', {}, d.lines.map((l) => h('tr', {}, h('td', {}, sale ? l.name : pname(l)), h('td', { class: 'num' }, sale ? fn(l.qty) : `${fn(l.qty)} ${l.unit}`), h('td', { class: 'num' }, sale ? fm(l.price) : fm(l.total / l.qty, 4)), h('td', { class: 'num' }, sale ? fm(l.qty * l.price) : fm(l.total)))))),
      h('div', { class: 'totals' }, h('div', {}, h('span', {}, T('total')), h('span', {}, fm(d.total))), h('div', {}, h('span', {}, T('paid')), h('span', {}, fm(d.paid))), h('div', { class: 'big' }, h('span', {}, T('due')), h('span', {}, fm(d.due)))),
      d.payments.length ? h('div', { class: 'muted', style: 'margin-top:1rem' }, T('payments'), ': ', d.payments.map((p) => `${p.date} ${fm(p.amount)}`).join(' · ')) : null,
      d.note ? h('p', { class: 'muted' }, d.note) : null,
      sale ? h('div', { class: 'foot' }, T('thank_you')) : null);
  }

  async function recipe(s) {
    const mode = ['qty', 'prices', 'summary'].includes(q.get('mode')) ? q.get('mode') : 'qty';
    const n = Number(q.get('batches')) > 0 ? Number(q.get('batches')) : 1;
    const d = await get(`/api/products/${id}`);
    const p = d.product, c = p.cost, pcs = (Number(p.pieces_per_batch) || 0) * n;
    document.title = `${pname(p)} — ${T('recipe')}`;
    toolbar();
    const showPrice = mode !== 'qty';
    const sum = d.parts.reduce((a, x) => a + x.line_cost * n, 0);
    doc.replaceChildren(
      h('div', { class: 'top' }, h('div', {}, h('h1', {}, pname(p)), h('div', { class: 'muted' }, s.store_name)),
        h('div', { class: 'meta' }, h('div', {}, h('strong', {}, `${n} ${n === 1 ? T('batch') : T('batches')}`)), pcs ? h('div', {}, `${T('makes')} ${fn(pcs)} ${T('pieces').toLowerCase()}`) : null, p.hours_per_batch ? h('div', { class: 'muted' }, `${fn(p.hours_per_batch * n)} ${T('hours')}`) : null, h('div', { class: 'muted' }, App_today()))),
      h('table', {}, h('thead', {}, h('tr', {}, mode === 'qty' ? h('th', { style: 'width:2rem' }) : null, h('th', {}, T('ingredient')), h('th', { class: 'num' }, T('qty')), showPrice ? [h('th', { class: 'num' }, T('unit_price')), h('th', { class: 'num' }, T('line_cost'))] : null)),
        h('tbody', {}, d.parts.map((x) => h('tr', {}, mode === 'qty' ? h('td', {}, h('span', { class: 'box' })) : null, h('td', {}, (x.type === 'product' ? '📦 ' : '') + pname(x)), h('td', { class: 'num' }, x.type === 'product' ? `${fn(x.qty * n, 3)} ×` : qty(x.qty * n, x.unit)),
          showPrice ? [h('td', { class: 'num' }, fm(x.unit_cost, 4)), h('td', { class: 'num' }, fm(x.line_cost * n))] : null))),
        showPrice ? h('tfoot', {}, h('tr', {}, h('td', {}, T('materials_batch')), h('td', {}), h('td', {}), h('td', { class: 'num' }, fm(sum)))) : null),
      mode === 'summary' && c ? h('div', { class: 'totals' },
        [[T('food_cost'), fm(d.foodPerPiece)], d.componentPerPiece ? [T('components_cost'), fm(d.componentPerPiece)] : null, [T('waste'), fm(c.waste)], [T('packaging'), fm(d.packPerPiece)], [T('labor'), fm(c.labor)], [T('overhead'), fm(c.overhead)], [T('distribution'), fm(p.distribution || 0)]].filter(Boolean).map(([k, v]) => h('div', {}, h('span', {}, k), h('span', {}, v))),
        h('div', { class: 'big' }, h('span', {}, T('cost_piece')), h('span', {}, fm(c.total))), h('div', {}, h('span', {}, `${T('cost_batch')} (${n})`), h('span', {}, fm(c.total * pcs))),
        p.price ? [h('div', {}, h('span', {}, T('sell_price')), h('span', {}, fm(p.price))), c.profit != null ? h('div', {}, h('span', {}, T('profit_piece')), h('span', {}, `${fm(c.profit)} (${I18N.pct(c.margin)})`)) : null] : null) : null,
      mode === 'qty' ? h('div', { class: 'foot' }, '☐ ' + T('kitchen_tick')) : null);
  }
  const App_today = () => new Date().toLocaleDateString('en-CA');
  draw();
})();
