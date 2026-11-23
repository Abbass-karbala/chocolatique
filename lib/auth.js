'use strict';
const crypto = require('crypto');
const express = require('express');
const { db } = require('./db');
const { httpError, str, wrap, limiter, toId } = require('./util');

const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) => `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
const DUMMY = hashPw('not-a-real-password');
function checkPw(pw, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const a = crypto.scryptSync(pw, salt, 64), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function cookie(req, name) {
  const m = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name, role: u.role, must_change: !!u.must_change });

// First run: user "admin" with password "admin" (flagged so the app nags until it is changed).
// ADMIN_PASSWORD in the environment (re)sets the password of "admin" at start-up: handy to recover access.
function initUsers() {
  if (!db.prepare('SELECT 1 FROM users').get()) {
    const pw = process.env.ADMIN_PASSWORD || 'admin';
    db.prepare("INSERT INTO users(username,name,password_hash,role,must_change,created_at) VALUES('admin','Admin',?,'admin',?,?)")
      .run(hashPw(pw), pw === 'admin' ? 1 : 0, new Date().toISOString());
  } else if (process.env.ADMIN_PASSWORD) {
    db.prepare("UPDATE users SET password_hash=?, must_change=0 WHERE username='admin'").run(hashPw(process.env.ADMIN_PASSWORD));
  }
}

function requireAuth(req, res, next) {
  const tok = cookie(req, 'sid');
  if (tok) {
    const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>?`).get(sha(tok), Date.now());
    if (row) { req.user = row; return next(); }
  }
  res.status(401).json({ error: 'Not signed in' });
}
const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only' }));

function validPassword(pw, username) {
  if (typeof pw !== 'string' || pw.length < 6 || pw.length > 200) throw httpError(400, 'Password must be at least 6 characters');
  if (username && pw.toLowerCase() === String(username).toLowerCase()) throw httpError(400, 'Password cannot be the same as the username');
  if (['admin', 'password', '123456', '1234567', '12345678'].includes(pw.toLowerCase())) throw httpError(400, 'Choose a less obvious password');
}

/* ---- public auth routes (login/logout) */
const authRouter = express.Router();
authRouter.post('/login', limiter(10, 10 * 60 * 1000), wrap((req, res) => {
  const b = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(b.username ?? '').trim());
  const ok = checkPw(String(b.password ?? ''), u ? u.password_hash : DUMMY);
  if (!u || !ok) return res.status(401).json({ error: 'Wrong username or password' });
  const tok = crypto.randomBytes(32).toString('base64url');
  const maxAge = 14 * 24 * 3600;
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires) VALUES(?,?,?)').run(sha(tok), u.id, Date.now() + maxAge * 1000);
  const secure = req.secure || process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  res.set('Set-Cookie', `sid=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
  res.json({ user: publicUser(u) });
}));
authRouter.post('/logout', (req, res) => {
  const tok = cookie(req, 'sid');
  if (tok) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(tok));
  res.set('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

/* ---- signed-in routes: who am I, change my password, manage users (admin) */
const meRouter = express.Router();
meRouter.get('/me', (req, res) => res.json({ user: publicUser(req.user) }));
meRouter.post('/me/password', limiter(10, 10 * 60 * 1000), wrap((req, res) => {
  const b = req.body || {};
  if (!checkPw(String(b.current ?? ''), req.user.password_hash)) throw httpError(400, 'Current password is wrong');
  validPassword(b.password, req.user.username);
  db.prepare('UPDATE users SET password_hash=?, must_change=0 WHERE id=?').run(hashPw(b.password), req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(req.user.id, sha(cookie(req, 'sid')));
  res.json({ ok: true });
}));

const usersRouter = express.Router();
usersRouter.use(requireAdmin);
const cleanRole = (r) => { if (r !== 'admin' && r !== 'staff') throw httpError(400, 'Bad role'); return r; };
usersRouter.get('/', (req, res) => res.json({ users: db.prepare('SELECT id,username,name,role,must_change,created_at FROM users ORDER BY id').all().map((u) => ({ ...u, must_change: !!u.must_change })) }));
usersRouter.post('/', wrap((req, res) => {
  const b = req.body || {};
  const username = str(b.username, 30);
  if (!/^[a-z0-9_.-]{3,30}$/i.test(username)) throw httpError(400, 'Username: 3-30 letters, numbers, dot, dash or underscore');
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) throw httpError(400, 'That username is taken');
  validPassword(b.password, username);
  const r = db.prepare('INSERT INTO users(username,name,password_hash,role,must_change,created_at) VALUES(?,?,?,?,0,?)')
    .run(username, str(b.name, 60), hashPw(b.password), cleanRole(b.role), new Date().toISOString());
  res.status(201).json({ id: Number(r.lastInsertRowid) });
}));
usersRouter.put('/:id', wrap((req, res) => {
  const id = toId(req.params.id), b = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) throw httpError(404, 'Not found');
  const role = b.role ? cleanRole(b.role) : u.role;
  if (u.role === 'admin' && role !== 'admin' && db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='admin'").get().c < 2) throw httpError(400, 'There must be at least one admin');
  db.prepare('UPDATE users SET name=?, role=? WHERE id=?').run(b.name !== undefined ? str(b.name, 60) : u.name, role, id);
  if (b.password) {
    validPassword(b.password, u.username);
    db.prepare('UPDATE users SET password_hash=?, must_change=0 WHERE id=?').run(hashPw(b.password), id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  }
  res.json({ ok: true });
}));
usersRouter.delete('/:id', wrap((req, res) => {
  const id = toId(req.params.id);
  if (id === req.user.id) throw httpError(400, 'You cannot delete your own user');
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) throw httpError(404, 'Not found');
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  res.json({ ok: true });
}));

module.exports = { initUsers, requireAuth, requireAdmin, authRouter, meRouter, usersRouter };
