/* Chocolatique storefront. Cart lives in the browser; the server re-prices every order. */
(() => {
  'use strict';
  const T = (k) => I18N.t(k);

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'disabled' || k === 'required') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const $ = (s) => document.querySelector(s);

  let cfg = { store_name: 'Chocolatique', currency: '$' };
  let products = [];
  let loaded = false;
  let category = '';
  let cart = {}; // product id -> qty
  try { cart = JSON.parse(localStorage.getItem('cart') || '{}') || {}; } catch (e) { cart = {}; }

  const money = (n) => I18N.money(n, cfg.currency);
  const saveCart = () => { try { localStorage.setItem('cart', JSON.stringify(cart)); } catch (e) { /* ignore */ } };
  const count = () => Object.values(cart).reduce((a, b) => a + b, 0);
  const find = (id) => products.find((p) => p.id === Number(id));
  const name = (p) => I18N.pick(p, 'name');
  let toastTimer;
  const toast = (m) => { const el = $('#toast'); el.textContent = m; el.className = 'show'; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.className = ''; }, 1800); };

  function setQty(id, q) {
    if (q <= 0) delete cart[id]; else cart[id] = Math.min(q, 99);
    saveCart(); renderTop(); renderProducts(); if (cartDlg && cartDlg.open) renderCart();
  }

  /* ---------------------------------------------------------------- layout */
  function renderTop() {
    $('#top').replaceChildren(
      h('a', { class: 'logo', href: '/' }, cfg.store_name),
      h('div', { class: 'tools' },
        h('button', { class: 'lang-toggle', type: 'button', onclick: () => { I18N.setLang(I18N.lang === 'ar' ? 'en' : 'ar'); renderAll(); } }, I18N.lang === 'ar' ? 'English' : 'العربية'),
        h('button', { class: 'cartbtn', type: 'button', onclick: openCart }, T('cart'), h('span', { class: 'count', 'aria-live': 'polite' }, count()))));
  }

  function renderMain() {
    const feats = [['feat_belgian', '🍫'], ['feat_palm', '🌿'], ['feat_hand', '🤲']];
    $('#main').replaceChildren(
      h('section', { class: 'hero' }, h('h1', null, I18N.lang === 'ar' ? cfg.tagline_ar || cfg.tagline_en : cfg.tagline_en || cfg.tagline_ar || cfg.store_name),
        h('p', null, T('feat_belgian'), ' · ', T('feat_palm'), ' · ', T('feat_hand')), h('a', { class: 'btn gold', href: '#products' }, T('shop_now'))),
      h('section', { class: 'feats' }, feats.map(([k, i]) => h('div', { class: 'feat' }, h('span', { 'aria-hidden': 'true' }, i), h('strong', null, T(k)), h('small', null, T(`${k}_d`))))),
      h('section', { class: 'section', id: 'products' }, h('h2', null, T('our_products')), h('div', { class: 'chips', id: 'chips' }), h('div', { id: 'grid' })),
      h('section', { class: 'about' }, h('div', null, h('h2', null, T('about_title')), h('p', null, T('about_text'))),
        h('div', null, h('h2', null, T('delivery_title')), h('p', null, I18N.lang === 'ar' ? cfg.delivery_note_ar || cfg.delivery_note_en : cfg.delivery_note_en || cfg.delivery_note_ar))));
    renderProducts();
  }

  function renderFoot() {
    const wa = cfg.whatsapp ? h('a', { href: `https://wa.me/${cfg.whatsapp}`, target: '_blank', rel: 'noopener noreferrer' }, T('wa_us')) : null;
    const ig = cfg.instagram ? h('a', { href: `https://instagram.com/${encodeURIComponent(cfg.instagram)}`, target: '_blank', rel: 'noopener noreferrer' }, `Instagram @${cfg.instagram}`) : null;
    const em = cfg.email ? h('a', { href: `mailto:${cfg.email}` }, cfg.email) : null;
    $('#foot').replaceChildren(h('strong', null, cfg.store_name), h('div', { class: 'links' }, wa, ig, em),
      h('p', null, `© ${new Date().getFullYear()} ${cfg.store_name}`));
    const old = document.getElementById('wafab'); if (old) old.remove();
    if (cfg.whatsapp) document.body.append(h('a', { id: 'wafab', class: 'wafab', href: `https://wa.me/${cfg.whatsapp}`, target: '_blank', rel: 'noopener noreferrer', 'aria-label': T('wa_us') }, '💬'));
  }

  function renderProducts() {
    const grid = $('#grid'), chips = $('#chips');
    if (!grid) return;
    const cat = (p) => I18N.pick(p, 'category');
    const cats = [...new Set(products.map(cat).filter(Boolean))];
    if (category && !cats.includes(category)) category = '';
    chips.replaceChildren(...(cats.length > 1 ? [h('button', { class: 'chip', 'aria-pressed': String(!category), onclick: () => { category = ''; renderProducts(); } }, T('shop_all')),
      ...cats.map((c) => h('button', { class: 'chip', 'aria-pressed': String(category === c), onclick: () => { category = c; renderProducts(); } }, c))] : []));
    const list = products.filter((p) => !category || cat(p) === category);
    if (!list.length) { grid.replaceChildren(h('p', { class: 'emptyshop' }, loaded ? T('no_products') : T('loading'))); return; }
    grid.replaceChildren(h('div', { class: 'grid' }, list.map((p) => {
      const q = cart[p.id] || 0;
      return h('article', { class: 'pcard' },
        h('div', { class: 'pimg' }, p.image ? h('img', { src: p.image, alt: name(p), loading: 'lazy' }) : '🍫'),
        h('div', { class: 'pbody' }, h('h3', null, name(p)), h('p', null, I18N.pick(p, 'desc')),
          h('div', { class: 'pfoot' }, h('div', { class: 'price' }, money(p.price), ' ', h('small', null, T('each'))),
            q ? h('div', { class: 'stepper' },
              h('button', { type: 'button', 'aria-label': `${T('remove')} ${name(p)}`, onclick: () => setQty(p.id, q - 1) }, '−'), h('span', null, q),
              h('button', { type: 'button', 'aria-label': `${T('add_to_cart')} ${name(p)}`, onclick: () => setQty(p.id, q + 1) }, '+'))
              : h('button', { class: 'btn small', type: 'button', onclick: () => { setQty(p.id, 1); toast(`${name(p)} ✓`); } }, T('add_to_cart')))));
    })));
  }

  /* ------------------------------------------------------------------ cart */
  let cartDlg;
  function openCart() {
    if (!cartDlg) {
      cartDlg = h('dialog', { class: 'cart', 'aria-label': T('cart') });
      cartDlg.addEventListener('click', (e) => { if (e.target === cartDlg) cartDlg.close(); });
      document.body.append(cartDlg);
    }
    renderCart(); if (!cartDlg.open) cartDlg.showModal();
  }
  const closeBtn = () => h('button', { class: 'xbtn', type: 'button', 'aria-label': T('close'), onclick: () => cartDlg.close() }, '×');

  function renderCart() {
    cartDlg.setAttribute('aria-label', T('cart'));
    const lines = Object.entries(cart).map(([id, q]) => ({ p: find(id), q })).filter((l) => l.p);
    for (const id of Object.keys(cart)) if (!find(id)) delete cart[id]; // product no longer on sale
    saveCart();
    if (!lines.length) {
      cartDlg.replaceChildren(h('div', { class: 'cartin' }, h('div', { class: 'carthead' }, h('h2', null, T('cart')), closeBtn()), h('div', { class: 'cartbody' }, h('p', { class: 'emptyshop' }, T('cart_empty')))));
      return;
    }
    const total = lines.reduce((a, l) => a + l.q * l.p.price, 0);
    const err = h('p', { class: 'err', role: 'alert' });
    const f = {
      name: h('input', { type: 'text', name: 'name', required: true, maxlength: '80', autocomplete: 'name' }),
      phone: h('input', { type: 'tel', name: 'phone', required: true, maxlength: '30', autocomplete: 'tel' }),
      address: h('textarea', { name: 'address', maxlength: '300', autocomplete: 'street-address' }),
      notes: h('textarea', { name: 'notes', maxlength: '500' }),
    };
    const submit = h('button', { class: 'btn gold', type: 'submit', style: 'width:100%' }, `${T('send_order')} · ${money(total)}`);
    const form = h('form', { class: 'cartfoot', onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      if (!f.name.value.trim() || f.phone.value.replace(/\D/g, '').length < 6) { err.textContent = T('required'); return; }
      submit.disabled = true;
      try {
        const res = await fetch('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: f.name.value, phone: f.phone.value, address: f.address.value, notes: f.notes.value, lang: I18N.lang, items: lines.map((l) => ({ id: l.p.id, qty: l.q })) }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || T('order_failed'));
        cart = {}; saveCart(); renderTop(); renderProducts(); renderSuccess(data);
      } catch (ex) { err.textContent = ex.message || T('order_failed'); submit.disabled = false; }
    } },
    h('div', { class: 'sumrow' }, h('span', null, T('total')), h('span', null, money(total))),
    h('label', { class: 'field' }, T('your_name'), f.name), h('label', { class: 'field' }, T('phone'), f.phone),
    h('label', { class: 'field' }, T('address'), f.address), h('label', { class: 'field' }, T('notes'), f.notes), err, submit);

    cartDlg.replaceChildren(h('div', { class: 'cartin' },
      h('div', { class: 'carthead' }, h('h2', null, T('cart')), closeBtn()),
      h('div', { class: 'cartbody' }, lines.map(({ p, q }) => h('div', { class: 'line' },
        h('div', null, h('div', { class: 'nm' }, name(p)), h('div', { class: 'sub' }, `${money(p.price)} ${T('each')}`)), h('div', { class: 'tot' }, money(q * p.price)),
        h('div', { class: 'stepper' }, h('button', { type: 'button', 'aria-label': T('remove'), onclick: () => setQty(p.id, q - 1) }, '−'), h('span', null, q),
          h('button', { type: 'button', 'aria-label': T('add_to_cart'), onclick: () => setQty(p.id, q + 1) }, '+')),
        h('button', { class: 'link', type: 'button', onclick: () => setQty(p.id, 0) }, T('remove'))))),
      form));
  }

  function renderSuccess(data) {
    cartDlg.replaceChildren(h('div', { class: 'cartin' }, h('div', { class: 'carthead' }, h('h2', null, T('order_saved')), closeBtn()),
      h('div', { class: 'success' }, h('div', { class: 'tick', 'aria-hidden': 'true' }, '✅'),
        h('p', null, `#${data.id} — ${data.whatsapp_url ? T('order_saved_wa') : T('order_saved_plain')}`),
        data.whatsapp_url ? h('a', { class: 'btn wa', href: data.whatsapp_url, target: '_blank', rel: 'noopener noreferrer' }, T('open_whatsapp')) : null,
        h('button', { class: 'btn ghost', type: 'button', onclick: () => cartDlg.close() }, T('back_to_shop')))));
  }

  /* ------------------------------------------------------------------ boot */
  function renderAll() {
    document.title = cfg.store_name;
    renderTop(); renderMain(); renderFoot();
    if (cartDlg && cartDlg.open) renderCart();
  }

  async function init() {
    renderAll();
    try {
      const [c, p] = await Promise.all([fetch('/api/public/config').then((r) => r.json()), fetch('/api/public/products').then((r) => r.json())]);
      cfg = c; products = p.products || [];
      for (const id of Object.keys(cart)) if (!find(id)) delete cart[id];
      saveCart();
    } catch (e) { /* offline: show empty shop message */ }
    loaded = true;
    renderAll();
  }
  init();
})();
