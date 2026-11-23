'use strict';

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in the server's TZ
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const isMonth = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
const str = (v, max = 200) => { const s = String(v ?? '').trim(); if (s.length > max) throw httpError(400, 'Text too long'); return s; };
const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  if (!Number.isFinite(x) || x < 0 || x > 1e9) throw httpError(400, 'Invalid number');
  return x;
};
const numReq = (v) => { const x = numOrNull(v); if (x === null) throw httpError(400, 'Number required'); return x; };
const posNum = (v) => { const x = numReq(v); if (x <= 0) throw httpError(400, 'Must be greater than zero'); return x; };
const reqDate = (v) => { if (!isDate(v)) throw httpError(400, 'Invalid date'); return v; };
const optDate = (v) => (v ? reqDate(v) : null);
const toId = (v) => { const x = Number(v); if (!Number.isInteger(x) || x < 1) throw httpError(400, 'Bad id'); return x; };
const optId = (v) => (v === null || v === undefined || v === '' ? null : toId(v));
const round2 = (x) => Math.round(x * 100) / 100;
const wrap = (fn) => (req, res, next) => {
  try { const r = fn(req, res, next); if (r && typeof r.catch === 'function') r.catch(next); } catch (e) { next(e); }
};

function limiter(max, windowMs) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const arr = (hits.get(req.ip) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'Too many requests, try again later' });
    arr.push(now); hits.set(req.ip, arr);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
    next();
  };
}

module.exports = { httpError, today, isDate, isMonth, str, numOrNull, numReq, posNum, reqDate, optDate, toId, optId, round2, wrap, limiter };
