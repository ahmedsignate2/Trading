-- Base D1 du bot (exécutée automatiquement au premier lancement, idempotente)
CREATE TABLE IF NOT EXISTS account (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cash REAL NOT NULL, paused INTEGER NOT NULL DEFAULT 0,
  guard TEXT NOT NULL DEFAULT '{}', last_bar TEXT NOT NULL DEFAULT '{}',
  prices TEXT NOT NULL DEFAULT '{}', last_step TEXT, last_error TEXT DEFAULT '',
  webhook_key TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS positions (
  product TEXT PRIMARY KEY, qty REAL, entry_price REAL, stop REAL,
  highest_close REAL, entry_time TEXT);
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY, time TEXT, product TEXT, side TEXT, qty REAL,
  price REAL, usd REAL, reason TEXT, pnl_pct REAL, mode TEXT);
CREATE TABLE IF NOT EXISTS equity (time TEXT PRIMARY KEY, equity REAL, cash REAL);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, time TEXT, level TEXT, message TEXT);
