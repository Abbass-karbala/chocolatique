/* Chocolatique app core: helpers, API, router, shell (sidebar + phone tab bar), login, order alerts.
   Plain JS, no build step. All text goes through textContent (h()), never innerHTML. */
(() => {
  'use strict';
  const App = window.App = { pages: [], user: null, S: {}, cat: null, pendingCost: 0 };
  const T = (k) => I18N.t(k);
  App.T = T;

  /* ---------------------------------------------------------------- helpers */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    let value;
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'required') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    if (value !== undefined) el.value = value;
    return el;
  }
  const $ = (s, r = document) => r.querySelector(s);
  const today = () => new Date().toLocaleDateString('en-CA');
  const fm = (n, d = 2) => I18N.money(n, App.S.currency || '$', d);
  const fp = (n) => I18N.pct(n);
  const fn = (n, d = 2) => (n === null || n === undefined || n === '' ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d }));
  const pname = (p) => (I18N.lang === 'ar' ? p.name_ar || p.name_en : p.name_en || p.name_ar) || `#${p.id}`;
  Object.assign(App, { h, $, today, fm, fp, fn, pname, thisMonth: () => today().slice(0, 7) });

  let toastTimer;
  App.toast = (msg, bad) => {
    const el = $('#toast');
    el.textContent = msg; el.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.className = ''; }, 2600);
  };
  App.api = async (method, url, body) => {
    const res = await fetch(url, {
      method, credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (res.status === 401 && url !== '/api/login') { showLogin(); throw new Error('auth'); }
    if (!res.ok) throw new Error((data && data.error) || T('error'));
    return data;
  };
  App.fail = (e) => { if (e && e.message !== 'auth') App.toast(e.message, true); };
  App.get = (u) => App.api('GET', u);
  App.qs = (o) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== '' && v !== null && v !== undefined) p.set(k, v); const s = p.toString(); return s ? `?${s}` : ''; };
  App.isAdmin = () => App.user && App.user.role === 'admin';
  App.confirm = (msg) => window.confirm(msg || T('confirm_delete'));

  // phone -> wa.me digits (Lebanese local numbers get 961)
  App.waNumber = (phone) => {
    let d = String(phone || '').replace(/\D/g, '');
    if (!d) return '';
    if (d.startsWith('00')) d = d.slice(2); else if (String(phone).trim().startsWith('+')) return d; else if (d.startsWith('0')) d = '961' + d.slice(1); else if (d.length <= 8) d = '961' + d;
    return d;
  };
  App.waLink = (phone, text) => `https://wa.me/${App.waNumber(phone)}?text=${encodeURIComponent(text || '')}`;

  /* --------------------------------------------------------- small widgets */
  App.pill = (cls, text) => h('span', { class: `pill ${cls}` }, text);
  App.payPill = (d) => (d.due <= 0.005 ? App.pill('good', T('paid')) : d.paid > 0.005 ? App.pill('low', T('partial')) : App.pill('loss', T('unpaid')));
  App.btn = (label, onclick, cls = '') => h('button', { type: 'button', class: `btn ${cls}`, onclick }, label);
  App.link = (label, href, cls = '') => h('a', { class: `btn ${cls}`, href }, label);
  App.head = (title, ...actions) => h('div', { class: 'pagehead' }, h('h1', {}, title), h('div', { class: 'grp' }, ...actions));
  App.empty = (msg) => h('div', { class: 'empty' }, msg);
  App.tabs = (items, active) => h('nav', { class: 'tabs' }, items.map(([label, href, key]) => h('a', { href, class: key === active ? 'on' : '' }, label)));

  // Table that turns into cards on phones. cols: [{label, render(row)|key, cls, num}]
  App.table = (cols, rows, { onRow, foot, empty } = {}) => {
    if (!rows.length) return App.empty(empty || T('none_yet'));
    const tbl = h('table', { class: 'rt' },
      h('thead', {}, h('tr', {}, cols.map((c) => h('th', { class: c.num ? 'num' : '' }, c.label)))),
      h('tbody', {}, rows.map((r) => h('tr', { class: onRow ? 'click' : '', onclick: onRow ? (e) => { if (!e.target.closest('a,button,input,select')) onRow(r); } : null },
        cols.map((c) => h('td', { 'data-label': c.label, class: `${c.num ? 'num ' : ''}${c.cls || ''}` }, c.render ? c.render(r) : r[c.key]))))),
      foot ? h('tfoot', {}, h('tr', {}, foot.map((x, i) => h('td', { 'data-label': cols[i] ? cols[i].label : '', class: cols[i] && cols[i].num ? 'num' : '' }, x)))) : null);
    return h('div', { class: 'tablewrap' }, tbl);
  };
  App.tile = (label, value, { cls = '', href, sub } = {}) => h(href ? 'a' : 'div', { class: `tile ${cls}`, href }, h('div', { class: 'tl' }, label), h('div', { class: 'tv' }, value), sub ? h('div', { class: 'ts' }, sub) : null);

  /* ----------------------------------------------------------------- dialogs */
  // Generic modal: build(body, close) fills the body. Returns {close, el}.
  App.modal = (title, build, { wide } = {}) => {
    const dlg = h('dialog', { class: wide ? 'wide' : '' });
    const body = h('div', { class: 'dlgbody' });
    const rawAppend = body.append.bind(body);
    body.append = (...k) => rawAppend(...k.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false));
    const close = () => { dlg.close(); dlg.remove(); };
    dlg.append(h('div', { class: 'dlghead' }, h('h2', {}, title), h('button', { type: 'button', class: 'x', 'aria-label': T('close'), onclick: close }, '×')), body);
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
    document.body.append(dlg);
    build(body, close);
    dlg.showModal();
    return { close, el: dlg };
  };

  // Simple form dialog. fields: [{key,label,type,options,help,required,full,step}] ; onSubmit(values) -> promise
  App.field = (f, v) => {
    let input;
    if (f.type === 'select') input = h('select', { name: f.key }, f.options.map(([val, lab]) => h('option', { value: val, selected: String(val) === String(v ?? '') }, lab)));
    else if (f.type === 'textarea') input = h('textarea', { name: f.key, value: v ?? '' });
    else if (f.type === 'check') return h('label', { class: 'field check full' }, h('input', { type: 'checkbox', name: f.key, checked: !!v }), ' ', f.label);
    else input = h('input', { name: f.key, type: f.type || 'text', value: v ?? '', step: f.type === 'number' ? (f.step || 'any') : null, min: f.type === 'number' ? '0' : null, required: f.required, autocomplete: 'off', inputmode: f.type === 'number' ? 'decimal' : f.type === 'tel' ? 'tel' : null });
    return h('label', { class: `field${f.full ? ' full' : ''}` }, f.label, input, f.help ? h('span', { class: 'help' }, f.help) : null);
  };
  App.readForm = (form, fields) => {
    const out = {};
    for (const f of fields) {
      const el = form.elements[f.key];
      out[f.key] = f.type === 'check' ? el.checked : el.value;
    }
    return out;
  };
  App.formModal = ({ title, fields, values = {}, onSubmit, submitLabel, extra }) => App.modal(title, (body, close) => {
    const err = h('p', { class: 'err', role: 'alert' });
    const form = h('form', { onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      try { await onSubmit(App.readForm(form, fields)); close(); } catch (x) { if (x.message !== 'auth') err.textContent = x.message; }
    } }, h('div', { class: 'formgrid' }, fields.map((f) => App.field(f, values[f.key]))), extra ? extra : null, err,
    h('div', { class: 'dlg-actions' }, App.btn(T('cancel'), close, 'ghost'), h('button', { class: 'btn gold', type: 'submit' }, submitLabel || T('save'))));
    body.append(form);
    const first = form.querySelector('input:not([type=checkbox]),select,textarea'); if (first) setTimeout(() => first.focus(), 30);
  });

  /* ------------------------------------------------------------------ router */
  // App.route('/sales/:id', (params, q) => node)
  const routes = [];
  App.route = (pattern, render, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:[a-z]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '/?$');
    routes.push({ re, keys, render, ...opts });
  };
  App.go = (path) => { if (location.hash === `#${path}`) route(); else location.hash = path; };
  let routeSeq = 0;
  async function route() {
    const raw = location.hash.slice(1) || '/';
    const [path, query] = raw.split('?');
    const q = Object.fromEntries(new URLSearchParams(query || ''));
    const view = $('#view'); if (!view) return;
    for (const r of routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      if (r.admin && !App.isAdmin()) { view.replaceChildren(App.empty(T('admins_only'))); return; }
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const seq = ++routeSeq;
      view.replaceChildren(h('div', { class: 'loading' }, T('loading')));
      try {
        const node = await r.render(params, q);
        if (seq !== routeSeq) return;
        view.replaceChildren(...[node].flat(Infinity).filter(Boolean));
        window.scrollTo(0, 0);
      } catch (e) { if (e.message !== 'auth') view.replaceChildren(h('div', { class: 'note bad' }, e.message)); }
      markNav(path);
      return;
    }
    App.go('/');
  }
  App.refresh = () => route();

  /* ------------------------------------------------------------------- shell */
  const NAV = [
    ['/', 'nav_home', 'home', false], ['/orders', 'nav_orders', 'orders', false], ['/sales', 'nav_sales', 'sales', false],
    ['/purchases', 'nav_purchases', 'purchases', true], ['/cost', 'nav_cost', 'cost', true], ['/reports', 'nav_reports', 'reports', true], ['/settings', 'nav_settings', 'settings', false],
  ];
  const ICON = { home: '⌂', orders: '🔔', sales: '🧾', purchases: '🛒', cost: '🧮', reports: '📊', settings: '⚙', more: '☰' };
  const items = () => NAV.filter((n) => !n[3] || App.isAdmin());
  function markNav(path) {
    const seg = '/' + (path.split('/')[1] || '');
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === seg));
  }
  function badges() {
    document.querySelectorAll('[data-badge=orders]').forEach((b) => { b.textContent = App.newOrders || ''; b.classList.toggle('hidden', !App.newOrders); });
    document.querySelectorAll('[data-badge=cost]').forEach((b) => { b.textContent = App.pendingCost || ''; b.classList.toggle('hidden', !App.pendingCost); });
    document.title = `${App.newOrders ? `(${App.newOrders}) ` : ''}${App.S.store_name || 'Chocolatique'}`;
  }
  App.badges = badges;

  function navLink(n, cls) {
    return h('a', { class: cls, href: `#${n[0]}`, 'data-nav': n[0] }, h('span', { class: 'ico', 'aria-hidden': 'true' }, ICON[n[2]]), h('span', { class: 'lab' }, T(n[1])), h('span', { class: 'badge hidden', 'data-badge': n[2] }));
  }
  function langBtn() { return h('button', { class: 'lang-toggle', onclick: () => { I18N.setLang(I18N.lang === 'ar' ? 'en' : 'ar'); drawShell(); route(); } }, I18N.lang === 'ar' ? 'English' : 'العربية'); }

  function drawShell() {
    const all = items();
    const main = all.filter((n) => ['home', 'orders', 'sales', 'cost'].includes(n[2]) || (!App.isAdmin() && n[2] === 'settings')).slice(0, 4);
    const rest = all.filter((n) => !main.includes(n));
    const more = () => App.modal(T('more'), (body, close) => body.append(
      h('div', { class: 'morelist' }, rest.map((n) => h('a', { class: 'btn ghost', href: `#${n[0]}`, onclick: close }, ICON[n[2]], ' ', T(n[1]))),
        h('a', { class: 'btn ghost', href: '#/settings', onclick: close }, ICON.settings, ' ', T('nav_settings')), langBtn(), App.btn(T('logout'), logout, 'danger'))));
    $('#app').replaceChildren(
      h('div', { class: 'shell' },
        h('aside', { class: 'side' }, h('div', { class: 'brand' }, App.S.store_name || 'Chocolatique', h('small', {}, T('app_sub'))),
          all.map((n) => navLink(n, 'nav')), h('div', { class: 'spacer' }),
          h('div', { class: 'who' }, App.user.name || App.user.username, ' · ', T(`role_${App.user.role}`)), langBtn(), App.btn(T('logout'), logout, 'ghost')),
        h('main', { class: 'main' }, h('div', { id: 'banner' }), h('div', { id: 'view' })),
        h('nav', { class: 'tabbar' }, main.map((n) => navLink(n, 'tab')), h('button', { class: 'tab', onclick: more }, h('span', { class: 'ico' }, ICON.more), h('span', { class: 'lab' }, T('more')))),
      ));
    banner(); badges();
  }

  function banner() {
    const b = $('#banner'); if (!b) return;
    b.replaceChildren();
    if (App.user.must_change) b.append(h('div', { class: 'note bad' }, h('strong', {}, T('default_pw_title')), ' ', T('default_pw_msg'), ' ', h('a', { href: '#/settings' }, T('change_now'))));
  }
  App.banner = banner;

  async function logout() { try { await App.api('POST', '/api/logout', {}); } catch (e) { /* ignore */ } App.user = null; clearInterval(poll); showLogin(); }

  function showLogin() {
    clearInterval(poll);
    const err = h('p', { class: 'err', role: 'alert' });
    const form = h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      try { const r = await App.api('POST', '/api/login', { username: form.u.value.trim(), password: form.p.value }); App.user = r.user; await boot(); } catch (x) { err.textContent = x.message; form.p.value = ''; }
    } },
    h('h1', {}, '🍫 ' + (App.S.store_name || 'Chocolatique')), h('p', { class: 'muted' }, T('login_sub')),
    h('label', { class: 'field' }, T('username'), h('input', { name: 'u', autocomplete: 'username', autocapitalize: 'none', required: true })),
    h('label', { class: 'field' }, T('password'), h('input', { name: 'p', type: 'password', autocomplete: 'current-password', required: true })),
    err, h('button', { class: 'btn gold', type: 'submit', style: 'width:100%' }, T('login')), h('div', { style: 'text-align:center;margin-top:.8rem' }, h('button', { type: 'button', class: 'lang-toggle', onclick: () => { I18N.setLang(I18N.lang === 'ar' ? 'en' : 'ar'); showLogin(); } }, I18N.lang === 'ar' ? 'English' : 'العربية')));
    $('#app').replaceChildren(h('div', { class: 'login' }, form));
    setTimeout(() => form.u.focus(), 30);
  }

  /* ---------------------------------------------------------- order alerts */
  let audio, poll, lastNew = null, tick = 0;
  document.addEventListener('click', () => { if (!audio) { try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* no audio */ } } }, { once: true });
  function beep() {
    if (!audio) return;
    try {
      [880, 1175].forEach((f, i) => { const o = audio.createOscillator(), g = audio.createGain(); o.frequency.value = f; o.connect(g); g.connect(audio.destination); const t = audio.currentTime + i * 0.18; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16); o.start(t); o.stop(t + 0.18); });
    } catch (e) { /* ignore */ }
  }
  async function check() {
    try {
      const r = await App.get('/api/orders/pending');
      if (lastNew !== null && r.count > lastNew) {
        beep();
        const l = r.latest;
        App.toast(`🔔 ${T('new_order_alert')}${l ? `: ${l.customer_name} · ${fm(l.total)}` : ''}`);
        if (/^\/orders\/?$/.test(location.hash.slice(1) || '')) route();
      }
      lastNew = r.count; App.newOrders = r.count;
      if (App.isAdmin() && tick++ % 3 === 0) { const c = await App.get('/api/cost/pending'); App.pendingCost = c.changes.length; }
      badges();
    } catch (e) { /* offline: try next time */ }
  }
  App.checkAlerts = check;

  /* -------------------------------------------------------------------- boot */
  async function boot() {
    App.cat = null; lastNew = null; tick = 0;
    const s = await App.get('/api/settings'); App.S = s.settings;
    drawShell();
    await check();
    clearInterval(poll); poll = setInterval(check, 20000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
    route();
  }
  App.catalog = async () => { if (!App.cat) App.cat = await App.get('/api/catalog'); return App.cat; };

  window.addEventListener('hashchange', () => { route(); });
  window.addEventListener('DOMContentLoaded', async () => {
    try { const r = await fetch('/api/public/config'); const c = await r.json(); App.S = { store_name: c.store_name, currency: c.currency }; } catch (e) { /* ignore */ }
    try { const r = await App.api('GET', '/api/me'); App.user = r.user; await boot(); } catch (e) { if (e.message !== 'auth') showLogin(); }
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/admin/sw.js').catch(() => {});
  });
})();
