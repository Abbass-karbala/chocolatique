'use strict';
const { db, tx } = require('./db');
const { httpError } = require('./util');

const SETTING_DEFS = {
  labor_rate: { t: 'n', d: 2 },
  waste_pct: { t: 'n', d: 0.05, max: 1 },
  target_margin: { t: 'n', d: 0.4, max: 0.99 },
  gas: { t: 'n', d: 20 },
  electricity: { t: 'n', d: 50 },
  other_bills: { t: 'n', d: 10 },
  hours_per_month: { t: 'n', d: 100 },
  store_name: { t: 's', d: 'Chocolatique', max: 60 },
  tagline_en: { t: 's', d: 'Artisan Belgian chocolate, handmade in Lebanon', max: 140 },
  tagline_ar: { t: 's', d: 'شوكولا بلجيكية فاخرة، مصنوعة يدوياً في لبنان', max: 140 },
  whatsapp_number: { t: 'phone', d: '96171193278' },
  instagram: { t: 's', d: 'chocolatique.lb', max: 60 },
  email: { t: 's', d: 'info@chocolatique.com', max: 100 },
  currency: { t: 's', d: '$', max: 6 },
  delivery_note_en: { t: 's', d: 'Delivered across Lebanon, cash on delivery. In busy seasons, please order one week ahead.', max: 240 },
  delivery_note_ar: { t: 's', d: 'توصيل إلى كل لبنان، الدفع عند الاستلام. في المواسم، يرجى الطلب قبل أسبوع.', max: 240 },
};

function getSettings() {
  const map = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
  const out = {};
  for (const [k, def] of Object.entries(SETTING_DEFS)) out[k] = k in map ? (def.t === 'n' ? Number(map[k]) : map[k]) : def.d;
  return out;
}

function cleanSetting(k, v) {
  const def = SETTING_DEFS[k];
  if (def.t === 'n') {
    const x = Number(v);
    if (!Number.isFinite(x) || x < 0 || x > (def.max ?? 1e9)) throw httpError(400, `Invalid value for ${k}`);
    return String(x);
  }
  if (def.t === 'phone') {
    const digits = String(v ?? '').replace(/\D/g, '');
    if (digits && (digits.length < 6 || digits.length > 15)) throw httpError(400, 'WhatsApp number must be 6-15 digits, with country code');
    return digits;
  }
  const s = String(v ?? '').trim();
  if (s.length > def.max) throw httpError(400, `${k} is too long`);
  return s;
}

function putSettings(obj) {
  const stmt = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const clean = {};
  for (const k of Object.keys(SETTING_DEFS)) if (k in obj) clean[k] = cleanSetting(k, obj[k]);
  tx(() => { for (const [k, v] of Object.entries(clean)) stmt.run(k, v); });
}

module.exports = { SETTING_DEFS, getSettings, putSettings };
