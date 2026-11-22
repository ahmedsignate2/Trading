"""Journal d'audit SQLite : trades, évolution du capital, événements."""
from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

import pandas as pd

SCHEMA = """
CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY, time TEXT, product TEXT, side TEXT, qty REAL,
    price REAL, usd REAL, reason TEXT, pnl_pct REAL, mode TEXT);
CREATE TABLE IF NOT EXISTS equity (time TEXT PRIMARY KEY, equity REAL, cash REAL);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, time TEXT, level TEXT, message TEXT);
"""


def _now() -> str:
    return pd.Timestamp.now("UTC").isoformat(timespec="seconds")


class Journal:
    def __init__(self, path: str):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.Lock()
        with self.lock:
            self.db.executescript(SCHEMA)

    def _exec(self, sql: str, args: tuple = ()) -> None:
        with self.lock:
            self.db.execute(sql, args)
            self.db.commit()

    def _query(self, sql: str, args: tuple = ()) -> list[dict]:
        with self.lock:
            return [dict(r) for r in self.db.execute(sql, args).fetchall()]

    def trade(self, product, side, qty, price, reason, mode, pnl_pct=None) -> None:
        self._exec("INSERT INTO trades (time, product, side, qty, price, usd, reason, pnl_pct, mode)"
                   " VALUES (?,?,?,?,?,?,?,?,?)",
                   (_now(), product, side, qty, price, qty * price, reason, pnl_pct, mode))

    def equity(self, equity: float, cash: float) -> None:
        self._exec("INSERT OR REPLACE INTO equity VALUES (?,?,?)", (_now(), equity, cash))

    def event(self, message: str, level: str = "info") -> None:
        self._exec("INSERT INTO events (time, level, message) VALUES (?,?,?)",
                   (_now(), level, message))

    def last_equity_time(self) -> pd.Timestamp | None:
        rows = self._query("SELECT max(time) AS t FROM equity")
        return pd.Timestamp(rows[0]["t"]) if rows and rows[0]["t"] else None

    def trades(self, limit: int = 50) -> list[dict]:
        return self._query("SELECT * FROM trades ORDER BY id DESC LIMIT ?", (limit,))

    def equity_curve(self, limit: int = 5000) -> list[dict]:
        rows = self._query("SELECT * FROM equity ORDER BY time DESC LIMIT ?", (limit,))
        return rows[::-1]

    def events(self, limit: int = 30) -> list[dict]:
        return self._query("SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,))
