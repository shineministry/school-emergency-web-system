const crypto = require('crypto');
const express = require('express');
const { db, hashPassword, verifyPassword } = require('./db');

// Sliding 1-year sessions: any use refreshes the token, so a registered
// device stays signed in indefinitely ("always logged in" after first login).
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 365;
const SLIDE_AFTER_MS = 1000 * 60 * 60 * 24;
const loginAttempts = new Map();

function rateLimited(key) {
  const now = Date.now();
  const entry = loginAttempts.get(key) || { count: 0, first: now };
  if (now - entry.first > 60000) {
    loginAttempts.delete(key);
    return false;
  }
  entry.count += 1;
  loginAttempts.set(key, entry);
  return entry.count > 10;
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_TTL_MS;
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').run(token, userId, expires);
  return { token, expires };
}

function getUserByToken(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.*, sc.name AS school_name, s.expires_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         JOIN schools sc ON sc.id = u.school_id
        WHERE s.token = ?`
    )
    .get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  if (row.expires_at < Date.now() + SESSION_TTL_MS - SLIDE_AFTER_MS) {
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(Date.now() + SESSION_TTL_MS, token);
  }
  return row;
}

function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  if (req.query && req.query.token) return String(req.query.token);
  return null;
}

function requireAuth(req, res, next) {
  const user = getUserByToken(extractToken(req));
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.user = user;
  next();
}

function requireStaff(req, res, next) {
  if (req.user.role !== 'admin' && req.user.role !== 'staff') {
    return res.status(403).json({ error: 'Only emergency staff can do this' });
  }
  next();
}

function publicUser(u) {
  return { id: u.id, role: u.role, name: u.name, email: u.email, group: u.group_name, school: u.school_name, schoolId: u.school_id };
}

const router = express.Router();

router.post('/register', (req, res) => {
  const { schoolId, name, email, password, group } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email, password required' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const school = db.prepare('SELECT id, name FROM schools WHERE id = ?').get(Number(schoolId));
  if (!school) return res.status(400).json({ error: 'Unknown school' });
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(String(email).toLowerCase());
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const info = db
    .prepare(
      "INSERT INTO users (school_id, role, name, email, password_hash, group_name) VALUES (?, 'student', ?, ?, ?, ?)"
    )
    .run(school.id, String(name).trim(), String(email).toLowerCase(), hashPassword(String(password)), String(group || 'students').trim() || 'students');

  const session = createSession(Number(info.lastInsertRowid));
  const user = getUserByToken(session.token);
  res.status(201).json({ token: session.token, user: publicUser(user) });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const ip = req.ip || 'unknown';
  if (rateLimited(ip) || rateLimited(String(email))) {
    return res.status(429).json({ error: 'Too many attempts, try again in a minute' });
  }
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase());
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const session = createSession(user.id);
  res.json({ token: session.token, user: publicUser(getUserByToken(session.token)) });
});

router.post('/logout', requireAuth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(extractToken(req));
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

router.get('/schools', (req, res) => {
  res.json({ schools: db.prepare('SELECT id, name FROM schools ORDER BY name').all() });
});

module.exports = { router, requireAuth, requireStaff, getUserByToken, extractToken };
