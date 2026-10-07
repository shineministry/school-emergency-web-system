const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'emergency.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS schools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL REFERENCES schools(id),
    role TEXT NOT NULL CHECK (role IN ('admin','staff','student')),
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    group_name TEXT NOT NULL DEFAULT 'students',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subscription TEXT NOT NULL,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, subscription)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL REFERENCES schools(id),
    created_by INTEGER NOT NULL REFERENCES users(id),
    type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'critical',
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT 'all',
    drill INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS deliveries (
    alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','notified','safe')),
    notified_at TEXT,
    safe_at TEXT,
    PRIMARY KEY (alert_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_users_school ON users(school_id);
  CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
  CREATE INDEX IF NOT EXISTS idx_alerts_school ON alerts(school_id, status);
`);

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(password, s, 64).toString('hex');
  return `${s}:${h}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const calc = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return calc.length === expected.length && crypto.timingSafeEqual(calc, expected);
}

function seed() {
  const schoolCount = db.prepare('SELECT COUNT(*) AS c FROM schools').get().c;
  if (schoolCount > 0) return;

  const insertSchool = db.prepare('INSERT INTO schools (name) VALUES (?)');
  const insertUser = db.prepare(
    'INSERT INTO users (school_id, role, name, email, password_hash, group_name) VALUES (?,?,?,?,?,?)'
  );

  const schoolId = insertSchool.run('Bundesgymnasium Wien 7').lastInsertRowid;
  insertUser.run(schoolId, 'admin', 'System Administrator', 'admin@bg7.at', hashPassword('Admin123!'), 'staff');
  insertUser.run(schoolId, 'staff', 'Frau Schmid (Sicherheitsbeauftragte)', 'schmid@bg7.at', hashPassword('Staff123!'), 'teachers');
  insertUser.run(schoolId, 'staff', 'Herr Berger (Klassenlehrer)', 'berger@bg7.at', hashPassword('Staff123!'), 'teachers');

  const classes = ['8A', '8B', '9A', '9B'];
  const first = ['Anna', 'Lukas', 'Sophie', 'Max', 'Lea', 'Felix', 'Mia', 'Jonas', 'Emma', 'David', 'Hannah', 'Elias'];
  const last = ['Müller', 'Hofer', 'Gruber', 'Berger', 'Huber', 'Mayr', 'Koch', 'Leitner', 'Schmid', 'Wagner', 'Bauer', 'Fischer'];
  for (let i = 0; i < 12; i++) {
    const email = `student${i + 1}@bg7.at`;
    insertUser.run(
      schoolId,
      'student',
      `${first[i]} ${last[i]}`,
      email,
      hashPassword('Student123!'),
      classes[i % classes.length]
    );
  }

  console.log('Seeded demo school: Bundesgymnasium Wien 7');
  console.log('  Admin   : admin@bg7.at / Admin123!');
  console.log('  Staff   : schmid@bg7.at / Staff123!');
  console.log('  Student : student1@bg7.at / Student123!');
}

seed();

module.exports = { db, hashPassword, verifyPassword };
