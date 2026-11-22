"""Pilotage du bot par Telegram.

Sécurité : seul le chat dont l'identifiant est TELEGRAM_CHAT_ID est obéi.
Les actions sensibles (vente, réinitialisation du coupe-circuit) demandent /confirmer.
"""
from __future__ import annotations

import logging
import os
import threading
import time

import requests

log = logging.getLogger("bot")
CONFIRM_SECONDS = 60

COMMANDS = [
    ("statut", "Capital, performance du jour, état du bot"),
    ("positions", "Positions ouvertes avec gain et stop"),
    ("prix", "Prix actuels"),
    ("signaux", "Distance de chaque crypto à un signal d'achat"),
    ("journal", "Derniers trades (ex. /journal 20)"),
    ("perf", "Bilan des trades réalisés"),
    ("backtest", "Relance le backtest sur l'historique"),
    ("pause", "Bloque les nouveaux achats (les stops restent actifs)"),
    ("reprendre", "Réautorise les achats"),
    ("vendre", "Vend une position (ex. /vendre BTC-USD)"),
    ("vendre_tout", "Vend toutes les positions"),
    ("reset_coupe_circuit", "Relance le bot après un coupe-circuit"),
    ("confirmer", "Confirme la dernière action sensible"),
    ("dashboard", "Lien vers le tableau de bord"),
    ("aide", "Liste des commandes"),
]


def money(x: float) -> str:
    return f"{x:,.2f} $".replace(",", " ")


def pct(x: float) -> str:
    return f"{x:+.2%}"


class TelegramController:
    def __init__(self, bot, token: str | None = None, chat_id: str | None = None, send=None):
        self.bot = bot
        self.token = token or os.environ.get("TELEGRAM_BOT_TOKEN", "")
        self.chat_id = str(chat_id or os.environ.get("TELEGRAM_CHAT_ID", ""))
        self.send = send or self._send
        self.pending: tuple[str, float, callable] | None = None  # (description, expiration, action)
        self.offset = 0

    # --- réseau -----------------------------------------------------------
    def _api(self, method: str, **params):
        r = requests.post(f"https://api.telegram.org/bot{self.token}/{method}", json=params, timeout=40)
        r.raise_for_status()
        return r.json()["result"]

    def _send(self, text: str) -> None:
        for i in range(0, len(text), 4000):  # limite Telegram : 4096 caractères
            self._api("sendMessage", chat_id=self.chat_id, text=text[i:i + 4000])

    def run(self, stop_event: threading.Event) -> None:
        if not self.token or not self.chat_id:
            log.info("Telegram désactivé (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID absents)")
            return
        try:
            self._api("setMyCommands", commands=[{"command": c, "description": d} for c, d in COMMANDS])
        except requests.RequestException as e:
            log.warning("Menu des commandes Telegram non enregistré : %s", e)
        while not stop_event.is_set():
            try:
                updates = self._api("getUpdates", offset=self.offset, timeout=30,
                                    allowed_updates=["message"])
                for u in updates:
                    self.offset = u["update_id"] + 1
                    self.on_message(u.get("message") or {})
            except Exception:
                log.exception("Erreur Telegram")
                stop_event.wait(5)

    def on_message(self, msg: dict) -> None:
        chat = str(msg.get("chat", {}).get("id", ""))
        text = (msg.get("text") or "").strip()
        if not text.startswith("/"):
            return
        if chat != self.chat_id:
            log.warning("Commande Telegram refusée depuis le chat %s : %s", chat, text)
            return
        reply = self.handle(text)
        if reply:
            self.send(reply)

    # --- commandes ----------------------------------------------------------
    def handle(self, text: str) -> str:
        parts = text.split()
        cmd = parts[0][1:].split("@")[0].lower()
        args = parts[1:]
        fn = getattr(self, f"cmd_{cmd}", None)
        if fn is None:
            return "Commande inconnue. /aide pour la liste."
        try:
            return fn(args)
        except Exception as e:
            log.exception("Erreur commande %s", cmd)
            return f"⚠️ Erreur : {e}"

    def cmd_start(self, args) -> str:
        return self.cmd_aide(args)

    def cmd_aide(self, args) -> str:
        return "Commandes disponibles :\n" + "\n".join(f"/{c} : {d}" for c, d in COMMANDS)

    def cmd_statut(self, args) -> str:
        s = self.bot.snapshot()
        etat = ("🛑 ARRÊTÉ (" + s["halt_reason"] + ")" if s["halted"]
                else "⏸️ en pause" if s["paused"] else "✅ actif")
        lines = [
            f"Mode : {s['mode'].upper()} | {etat}",
            f"Capital : {money(s['equity'])} ({pct(s['equity'] / s['initial_cash'] - 1)} depuis le départ)"
            if s["mode"] == "paper" else f"Capital : {money(s['equity'])}",
            f"Liquidités : {money(s['cash'])}",
            f"Aujourd'hui : {pct(s['day_pnl'])} | Recul depuis le plus haut : {pct(s['drawdown'])}",
            f"Positions ouvertes : {len(s['positions'])}",
            f"Dernier cycle : {s['last_step'] or 'pas encore'}",
        ]
        if s["last_error"]:
            lines.append(f"⚠️ Dernière erreur : {s['last_error']}")
        return "\n".join(lines)

    def cmd_positions(self, args) -> str:
        s = self.bot.snapshot()
        if not s["positions"]:
            return "Aucune position ouverte."
        return "\n\n".join(
            f"{p['product']} : {p['qty']:.6f} ({money(p['value'])})\n"
            f"Entrée {money(p['entry_price'])} → {money(p['price'])} ({pct(p['pnl_pct'])})\n"
            f"Stop {money(p['stop'])} ({pct(p['stop_dist_pct'])})"
            for p in s["positions"])

    def cmd_prix(self, args) -> str:
        from . import data
        return "\n".join(f"{p} : {money(data.last_price(p))}" for p in self.bot.cfg.products)

    def cmd_signaux(self, args) -> str:
        lines = []
        for r in self.bot.signal_report():
            if r["entry"]:
                etat = "🟢 signal d'achat sur la dernière bougie"
            elif not r["trend_up"]:
                etat = f"⚪ pas de tendance haussière (EMA 200 à {money(r['ema_slow'])})"
            else:
                etat = f"🟡 tendance haussière, cassure à {money(r['channel_high'])} ({pct(r['to_breakout_pct'])})"
            lines.append(f"{r['product']} {money(r['close'])}\n{etat}")
        return "\n\n".join(lines)

    def cmd_journal(self, args) -> str:
        n = int(args[0]) if args and args[0].isdigit() else 10
        trades = self.bot.journal.trades(min(n, 50))
        if not trades:
            return "Aucun trade enregistré."
        return "\n".join(
            f"{t['time'][:16].replace('T', ' ')} {'🟢' if t['side'] == 'buy' else '🔴'} "
            f"{t['product']} {money(t['price'])} ({t['reason']})"
            + (f" {pct(t['pnl_pct'])}" if t["pnl_pct"] is not None else "")
            for t in trades)

    def cmd_perf(self, args) -> str:
        sells = [t for t in self.bot.journal.trades(10_000) if t["side"] == "sell"]
        if not sells:
            return "Aucun trade clôturé pour l'instant."
        wins = [t for t in sells if t["pnl_pct"] > 0]
        avg = sum(t["pnl_pct"] for t in sells) / len(sells)
        best = max(sells, key=lambda t: t["pnl_pct"])
        worst = min(sells, key=lambda t: t["pnl_pct"])
        return (f"Trades clôturés : {len(sells)}\n"
                f"Gagnants : {len(wins)} ({len(wins) / len(sells):.0%})\n"
                f"Variation moyenne : {pct(avg)}\n"
                f"Meilleur : {best['product']} {pct(best['pnl_pct'])}\n"
                f"Pire : {worst['product']} {pct(worst['pnl_pct'])}")

    def cmd_backtest(self, args) -> str:
        def work():
            from .backtest import buy_and_hold, metrics, run_backtest
            from .data import load_history
            cfg = self.bot.cfg
            d = {p: load_history(p, cfg.granularity, cfg.history_start) for p in cfg.products}
            res = run_backtest(d, cfg.strategy, cfg.risk, cfg.costs, cfg.initial_cash)
            m, eq = metrics(res), res.equity
            bh = buy_and_hold(d, eq.index[0], eq.index[-1], cfg.initial_cash, cfg.costs.fee)
            self.send(
                f"Backtest {eq.index[0]:%Y-%m-%d} → {eq.index[-1]:%Y-%m-%d}\n"
                f"Rendement : {pct(m['rendement_total'])} ({pct(m['rendement_annuel'])}/an)\n"
                f"Perte max : {pct(m['drawdown_max'])} | Sharpe : {m['sharpe']:.2f}\n"
                f"Trades : {m['nb_trades']} | Réussite : {m.get('taux_reussite', 0):.0%}\n"
                f"Achat-conservation : {pct(bh['rendement_total'])} (perte max {pct(bh['drawdown_max'])})")
        threading.Thread(target=lambda: self._safe(work), daemon=True).start()
        return "⏳ Backtest lancé, résultat dans quelques secondes…"

    def _safe(self, fn) -> None:
        try:
            fn()
        except Exception as e:
            log.exception("Erreur tâche Telegram")
            self.send(f"⚠️ Erreur : {e}")

    def cmd_pause(self, args) -> str:
        self.bot.set_paused(True)
        return ""

    def cmd_reprendre(self, args) -> str:
        self.bot.set_paused(False)
        return ""

    def _ask(self, description: str, action) -> str:
        self.pending = (description, time.time() + CONFIRM_SECONDS, action)
        return f"❓ {description}\nEnvoyez /confirmer dans les {CONFIRM_SECONDS} secondes pour valider."

    def cmd_vendre(self, args) -> str:
        if not args:
            return "Précisez la crypto, ex. /vendre BTC-USD"
        pid = args[0].upper()
        if "-" not in pid:
            pid = f"{pid}-{self.bot.cfg.quote_currency}"
        if pid not in self.bot.state["positions"]:
            return f"Aucune position ouverte sur {pid}."
        mode = " (ARGENT RÉEL)" if self.bot.cfg.mode == "live" else ""
        return self._ask(f"Vendre toute la position {pid}{mode} ?",
                         lambda: self.bot.close_position(pid))

    def cmd_vendre_tout(self, args) -> str:
        pids = list(self.bot.state["positions"])
        if not pids:
            return "Aucune position ouverte."
        return self._ask(f"Vendre TOUTES les positions ({', '.join(pids)}) et mettre le bot en pause ?",
                         lambda: (self.bot.set_paused(True), [self.bot.close_position(p) for p in pids]))

    def cmd_reset_coupe_circuit(self, args) -> str:
        if not self.bot.guard.halted:
            return "Le coupe-circuit n'est pas déclenché."
        return self._ask("Réinitialiser le coupe-circuit et relancer le trading ?", self.bot.reset_halt)

    def cmd_confirmer(self, args) -> str:
        if not self.pending:
            return "Rien à confirmer."
        description, expires, action = self.pending
        self.pending = None
        if time.time() > expires:
            return "⌛ Délai dépassé, recommencez la commande."
        action()
        return f"✅ Fait : {description}"

    def cmd_dashboard(self, args) -> str:
        url = os.environ.get("DASHBOARD_URL")
        return f"📊 {url}" if url else "DASHBOARD_URL n'est pas défini dans .env."
