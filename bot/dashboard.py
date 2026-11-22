"""Tableau de bord web en lecture seule, servi par le bot.

- Protégé par mot de passe (DASHBOARD_PASSWORD, authentification HTTP Basic).
  Sans mot de passe, le tableau de bord ne démarre pas.
- Écoute sur 127.0.0.1 par défaut : on l'expose sur Internet avec Cloudflare Tunnel,
  sans ouvrir de port sur la machine (voir scripts/tunnel.sh et le README).
- Aucune action possible depuis le web : le pilotage se fait uniquement par Telegram.
"""
from __future__ import annotations

import base64
import hmac
import json
import logging
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

log = logging.getLogger("bot")
HTML = (Path(__file__).parent / "dashboard.html").read_text(encoding="utf-8")


def make_handler(bot, password: str):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):  # pas de bruit dans les logs
            pass

        def _authorized(self) -> bool:
            header = self.headers.get("Authorization", "")
            if not header.startswith("Basic "):
                return False
            try:
                _, _, given = base64.b64decode(header[6:]).decode().partition(":")
            except Exception:
                return False
            return hmac.compare_digest(given.encode(), password.encode())

        def _send(self, code: int, body: bytes, ctype: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, obj) -> None:
            self._send(200, json.dumps(obj, default=str).encode(), "application/json")

        def do_GET(self):
            path = self.path.split("?")[0]
            if path == "/healthz":
                return self._send(200, b"ok", "text/plain")
            if not self._authorized():
                self.send_response(401)
                self.send_header("WWW-Authenticate", 'Basic realm="Trading bot"')
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if path == "/":
                return self._send(200, HTML.encode(), "text/html; charset=utf-8")
            if path == "/api/status":
                return self._json(bot.snapshot())
            if path == "/api/equity":
                return self._json(bot.journal.equity_curve())
            if path == "/api/trades":
                return self._json(bot.journal.trades(100))
            if path == "/api/events":
                return self._json(bot.journal.events(30))
            self._send(404, b"introuvable", "text/plain")

    return Handler


def serve(bot, stop_event: threading.Event, host: str = "127.0.0.1", port: int = 8080) -> None:
    password = os.environ.get("DASHBOARD_PASSWORD", "")
    if len(password) < 12:
        log.warning("Tableau de bord désactivé : DASHBOARD_PASSWORD absent ou trop court (12 caractères min).")
        return
    server = ThreadingHTTPServer((host, port), make_handler(bot, password))
    server.timeout = 1
    log.info("Tableau de bord sur http://%s:%d", host, port)
    while not stop_event.is_set():
        server.handle_request()
    server.server_close()
