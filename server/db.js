// SQLite through Node's built-in driver (no native build step).
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

let db;

function open(file = config.databaseFile) {
  if (db) return db;
  if ((config.isVercel || file.startsWith('/tmp/')) && !fs.existsSync(file)) {
    const candidates = [
      path.join(config.root, 'data', 'tailored-dev.db'),
      path.join(config.root, 'data', 'tailored.db'),
    ];
    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.copyFileSync(cand, file);
          break;
        } catch (e) {
          console.warn('Could not copy seed database to /tmp:', e);
        }
      }
    }
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {}
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  return db;
}

function get() {
  return db || open();
}

/** Applies every .sql file in server/migrations that hasn't run yet, in name order. */
function migrate({ log = console.log } = {}) {
  const d = get();
  d.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`);
  const done = new Set(d.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  let applied = 0;
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    tx(() => {
      d.exec(sql);
      d.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
    });
    log(`  applied ${file}`);
    applied++;
  }
  return applied;
}

/**
 * Runs fn inside a write transaction. BEGIN IMMEDIATE takes the write lock up
 * front, so availability checks and the inserts that depend on them can't race.
 */
function tx(fn) {
  const d = get();
  if (d.isTransaction) return fn(d);
  d.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(d);
    d.exec('COMMIT');
    return result;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

const one = (sql, ...params) => get().prepare(sql).get(...params);
const all = (sql, ...params) => get().prepare(sql).all(...params);
const run = (sql, ...params) => get().prepare(sql).run(...params);

function close() {
  if (db) db.close();
  db = undefined;
}

module.exports = { open, get, migrate, tx, one, all, run, close };
