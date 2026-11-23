/* Settings: rates, store details, my password, users. */
(() => {
  'use strict';
  const App = window.App;
  const { h, T, fm, api, get, fail, btn, head, table, toast, pill } = App;

  const RATES = [['labor_rate', 'set_labor', 'n'], ['waste_pct', 'set_waste', '%'], ['target_margin', 'set_target', '%'], ['gas', 'set_gas', 'n'], ['electricity', 'set_elec', 'n'], ['other_bills', 'set_other', 'n'], ['hours_per_month', 'set_hours', 'n']];
  const STORE = [['store_name', 'set_store_name'], ['tagline_en', 'set_tagline_en'], ['tagline_ar', 'set_tagline_ar'], ['whatsapp_number', 'set_whatsapp'], ['instagram', 'set_instagram'], ['email', 'set_email'], ['currency', 'set_currency'], ['delivery_note_en', 'set_delivery_en'], ['delivery_note_ar', 'set_delivery_ar']];

  function passwordCard() {
    const err = h('p', { class: 'err', role: 'alert' });
    const f = h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      if (f.n.value !== f.n2.value) { err.textContent = T('pw_mismatch'); return; }
      try { await api('POST', '/api/me/password', { current: f.c.value, password: f.n.value }); App.user.must_change = false; App.banner(); f.reset(); toast(T('pw_changed')); } catch (x) { err.textContent = x.message; }
    } }, h('h2', {}, T('change_my_password')), h('p', { class: 'muted' }, T('pw_rules')),
    h('div', { class: 'formgrid' },
      h('label', { class: 'field' }, T('current_password'), h('input', { name: 'c', type: 'password', autocomplete: 'current-password', required: true })),
      h('label', { class: 'field' }, T('set_new_password'), h('input', { name: 'n', type: 'password', autocomplete: 'new-password', required: true, minlength: 6 })),
      h('label', { class: 'field' }, T('repeat_password'), h('input', { name: 'n2', type: 'password', autocomplete: 'new-password', required: true }))),
    err, h('div', { class: 'dlg-actions' }, h('button', { class: 'btn gold', type: 'submit' }, T('set_change_pw'))));
    return f;
  }

  async function usersCard() {
    const { users } = await get('/api/users');
    const fields = (isNew) => [
      ...(isNew ? [{ key: 'username', label: T('username'), required: true }] : []), { key: 'name', label: T('name') },
      { key: 'role', label: T('role'), type: 'select', options: [['staff', T('role_staff')], ['admin', T('role_admin')]], help: T('role_help') },
      { key: 'password', label: isNew ? T('password') : T('new_password_optional'), type: 'password', required: isNew }];
    const save = (u) => async (v) => { const b = { ...v }; if (!b.password) delete b.password; if (u) await api('PUT', `/api/users/${u.id}`, b); else await api('POST', '/api/users', b); toast(T('saved')); App.refresh(); };
    return h('div', { class: 'card' }, h('div', { class: 'bar' }, h('h2', {}, T('users')), btn('+ ' + T('new_user'), () => App.formModal({ title: T('new_user'), fields: fields(true), values: { role: 'staff' }, onSubmit: save(null) }), 'gold small')),
      h('p', { class: 'muted' }, T('users_help')),
      table([{ label: T('username'), render: (u) => h('strong', {}, u.username) }, { label: T('name'), key: 'name' }, { label: T('role'), render: (u) => pill(u.role === 'admin' ? 'good' : 'new', T(`role_${u.role}`)) },
        { label: '', render: (u) => h('div', { class: 'row-actions' }, btn(T('edit'), () => App.formModal({ title: u.username, fields: fields(false), values: { ...u, password: '' }, onSubmit: save(u) }), 'small ghost'),
          u.id !== App.user.id ? btn('×', async () => { if (!App.confirm()) return; try { await api('DELETE', `/api/users/${u.id}`); App.refresh(); } catch (e) { fail(e); } }, 'small danger') : null) }], users));
  }

  App.route('/settings', async () => {
    const admin = App.isAdmin();
    const out = [head(T('nav_settings')), passwordCard()];
    if (!admin) return out;
    out.push(await usersCard());
    const { settings: s } = await get('/api/settings');
    const form = h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault();
      const b = {};
      for (const [k, , t] of RATES) b[k] = t === '%' ? Number(form.elements[k].value) / 100 : form.elements[k].value;
      for (const [k] of STORE) b[k] = form.elements[k].value;
      try { const r = await api('PUT', '/api/settings', b); App.S = r.settings; toast(T('saved')); App.refresh(); } catch (x) { fail(x); }
    } },
    h('h2', {}, T('set_rates')), h('p', { class: 'muted' }, T('rates_help')),
    h('div', { class: 'formgrid' }, RATES.map(([k, l, t]) => h('label', { class: 'field' }, T(l), h('input', { name: k, type: 'number', min: '0', step: 'any', value: t === '%' ? +(s[k] * 100).toFixed(4) : s[k] })))),
    h('div', { class: 'kv' }, h('div', { class: 'k' }, T('set_total_overhead'), ' / ', T('set_oh_hour')), h('div', { class: 'v' }, `${fm(s.gas + s.electricity + s.other_bills)} / ${fm(s.hours_per_month > 0 ? (s.gas + s.electricity + s.other_bills) / s.hours_per_month : 0)}`)),
    h('h2', { style: 'margin-top:1.4rem' }, T('set_store')), h('p', { class: 'muted' }, T('store_help')),
    h('div', { class: 'formgrid' }, STORE.map(([k, l]) => h('label', { class: `field${k.startsWith('delivery') || k.startsWith('tagline') ? ' full' : ''}` }, T(l), h('input', { name: k, value: s[k], inputmode: k === 'whatsapp_number' ? 'numeric' : null }), k === 'whatsapp_number' ? h('span', { class: 'help' }, T('set_whatsapp_help')) : null))),
    h('div', { class: 'dlg-actions' }, h('a', { class: 'btn ghost', href: '/', target: '_blank', rel: 'noopener' }, T('view_store')), h('button', { class: 'btn gold', type: 'submit' }, T('save'))));
    out.push(form);
    return out;
  });
})();
