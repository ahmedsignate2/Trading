"""Boucle du bot en direct (paper ou réel).

Chaque minute : vérification des stops au prix courant.
À chaque nouvelle bougie clôturée : mise à jour du stop suiveur, sortie de tendance, entrées.
L'état est sauvegardé dans un fichier JSON pour survivre à un redémarrage, et chaque
trade / événement est enregistré dans un journal SQLite.

Toutes les méthodes publiques sont protégées par un verrou : la boucle de trading,
le bot Telegram et le tableau de bord tournent dans des threads différents.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path

import pandas as pd
import requests

from . import data
from .broker import CoinbaseBroker, PaperBroker
from .journal import Journal
from .risk import RiskGuard, position_size_usd
from .strategy import initial_stop, prepare, trail_stop

log = logging.getLogger("bot")
EQUITY_SNAPSHOT_MINUTES = 15


def send_telegram(msg: str) -> None:
    token, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if token and chat:
        try:
            requests.post(f"https://api.telegram.org/bot{token}/sendMessage",
                          json={"chat_id": chat, "text": msg}, timeout=10)
        except requests.RequestException as e:
            log.warning("Alerte Telegram non envoyée : %s", e)


class LiveBot:
    def __init__(self, cfg, state_path: str, journal_path: str | None = None):
        self.cfg = cfg
        self.lock = threading.RLock()
        self.state_path = Path(state_path)
        self.state = self._load_state()
        self.journal = Journal(journal_path or str(self.state_path.with_suffix(".db")))
        self.guard = RiskGuard.from_dict(cfg.risk, self.state.get("guard", {}))
        self.prices: dict[str, float] = {}
        self.started = pd.Timestamp.now("UTC")
        self.last_step: pd.Timestamp | None = None
        self.last_error: str = ""
        if cfg.mode == "live":
            if os.environ.get("BOT_CONFIRM_LIVE") != "oui":
                raise SystemExit("Mode réel refusé : définissez BOT_CONFIRM_LIVE=oui pour confirmer.")
            self.broker = CoinbaseBroker(cfg.quote_currency)
            self._reconcile()
        else:
            self.broker = PaperBroker(self.state.get("paper_cash", cfg.initial_cash),
                                      {p: v["qty"] for p, v in self.state["positions"].items()},
                                      cfg.costs.fee, cfg.costs.slippage)

    # --- état -------------------------------------------------------------
    def _load_state(self) -> dict:
        state = {"positions": {}, "last_bar": {}, "paused": False}
        if self.state_path.exists():
            state.update(json.loads(self.state_path.read_text()))
        return state

    def _save(self) -> None:
        self.state["guard"] = self.guard.to_dict()
        if isinstance(self.broker, PaperBroker):
            self.state["paper_cash"] = self.broker.cash
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state, indent=2, default=str))
        tmp.replace(self.state_path)

    def say(self, msg: str, level: str = "info") -> None:
        """Message important : journal + log + Telegram."""
        log.info(msg)
        self.journal.event(msg, level)
        send_telegram(msg)

    def _reconcile(self) -> None:
        """Vérifie que les positions connues existent bien sur le compte."""
        for pid in list(self.state["positions"]):
            held = self.broker.base_balance(pid)
            if held < self.state["positions"][pid]["qty"] * 0.95:
                self.say(f"⚠️ {pid} : position attendue introuvable sur Coinbase, retirée du suivi.",
                         "warning")
                del self.state["positions"][pid]

    # --- calculs ----------------------------------------------------------
    def _equity(self, prices: dict[str, float]) -> float:
        return self.broker.usd_balance() + sum(
            p["qty"] * prices[pid] for pid, p in self.state["positions"].items())

    def _sell(self, pid: str, price: float, reason: str) -> None:
        pos = self.state["positions"][pid]
        qty, fill = self.broker.sell(pid, pos["qty"], price)
        pnl = (fill - pos["entry_price"]) / pos["entry_price"]
        self.journal.trade(pid, "sell", qty, fill, reason, self.cfg.mode, pnl)
        self.say(f"🔴 VENTE {pid} {qty:.6f} @ {fill:,.2f} ({reason}) | variation {pnl:+.2%}")
        del self.state["positions"][pid]

    # --- boucle -----------------------------------------------------------
    def check_stops(self, prices: dict[str, float]) -> None:
        for pid, pos in list(self.state["positions"].items()):
            if prices[pid] <= pos["stop"]:
                self._sell(pid, prices[pid], "stop")

    def on_bar(self, pid: str, df: pd.DataFrame, prices: dict[str, float]) -> None:
        sp, rp = self.cfg.strategy, self.cfg.risk
        bar = prepare(df, sp).iloc[-1]
        pos = self.state["positions"].get(pid)
        if pos:
            pos["highest_close"] = max(pos["highest_close"], bar["close"])
            pos["stop"] = trail_stop(pos["stop"], pos["highest_close"], bar["atr"], sp)
            if bar["regime_exit"]:
                self._sell(pid, prices[pid], "tendance")
            return
        if not bar["entry"]:
            return
        if self.state.get("paused"):
            self.say(f"Signal d'achat {pid} ignoré : bot en pause (/reprendre pour réactiver)")
            return
        equity = self._equity(prices)
        ok, why = self.guard.can_open(equity)
        if not ok:
            self.say(f"Signal d'achat {pid} ignoré : {why}", "warning")
            return
        price = prices[pid]
        stop = initial_stop(bar["close"], bar["atr"], sp)
        cash = self.broker.usd_balance()
        usd = position_size_usd(equity, cash, equity - cash, price, stop, rp)
        if usd <= 0:
            return
        qty, fill = self.broker.buy(pid, usd, price)
        self.state["positions"][pid] = {"qty": qty, "entry_price": fill, "stop": stop,
                                        "highest_close": bar["close"],
                                        "entry_time": pd.Timestamp.now("UTC").isoformat()}
        self.journal.trade(pid, "buy", qty, fill, "cassure", self.cfg.mode)
        self.say(f"🟢 ACHAT {pid} {qty:.6f} @ {fill:,.2f} ({usd:,.0f} $) | stop {stop:,.2f}")

    def _snapshot_equity(self, equity: float) -> None:
        last = self.journal.last_equity_time()
        if last is None or pd.Timestamp.now("UTC") - last >= pd.Timedelta(minutes=EQUITY_SNAPSHOT_MINUTES):
            self.journal.equity(equity, self.broker.usd_balance())

    def step(self) -> None:
        cfg = self.cfg
        prices = {pid: data.last_price(pid) for pid in cfg.products}
        with self.lock:
            self.prices = prices
            equity = self._equity(prices)
            self.guard.update(equity, pd.Timestamp.now("UTC"))
            self._snapshot_equity(equity)

            if self.guard.halted:
                if self.state["positions"]:
                    self.say(f"🛑 Coupe-circuit : {self.guard.halt_reason}. Liquidation des positions.",
                             "error")
                    for pid in list(self.state["positions"]):
                        self._sell(pid, prices[pid], "coupe-circuit")
                self._save()
                return

            self.check_stops(prices)
            sec = data.GRANULARITY_SECONDS[cfg.granularity]
            for pid in cfg.products:
                latest_closed = (int(time.time()) // sec - 1) * sec
                if self.state["last_bar"].get(pid, 0) >= latest_closed:
                    continue
                df = data.recent_candles(pid, cfg.granularity, count=max(600, cfg.strategy.ema_slow * 3))
                if df.empty or int(df.index[-1].timestamp()) < latest_closed:
                    continue  # bougie pas encore publiée, on réessaie au prochain tour
                self.on_bar(pid, df, prices)
                self.state["last_bar"][pid] = int(df.index[-1].timestamp())
            self.last_step = pd.Timestamp.now("UTC")
            self._save()

    def run(self, stop_event: threading.Event | None = None) -> None:
        stop_event = stop_event or threading.Event()
        self.say(f"Bot démarré en mode {self.cfg.mode.upper()} sur {', '.join(self.cfg.products)}")
        while not stop_event.is_set():
            try:
                self.step()
                self.last_error = ""
            except Exception as e:  # le bot ne doit pas mourir sur une erreur réseau
                log.exception("Erreur pendant le cycle")
                if str(e) != self.last_error:  # éviter de spammer la même erreur
                    self.say(f"⚠️ Erreur : {e}", "error")
                self.last_error = str(e)
            stop_event.wait(self.cfg.poll_seconds)

    # --- commandes (Telegram / tableau de bord) ---------------------------
    def snapshot(self) -> dict:
        """Vue complète de l'état du bot, utilisée par Telegram et le tableau de bord."""
        with self.lock:
            prices = self.prices
            cash = self.broker.usd_balance()
            positions = []
            for pid, p in self.state["positions"].items():
                price = prices.get(pid, p["entry_price"])
                positions.append({
                    "product": pid, "qty": p["qty"], "entry_price": p["entry_price"],
                    "price": price, "value": p["qty"] * price, "stop": p["stop"],
                    "pnl_pct": price / p["entry_price"] - 1,
                    "stop_dist_pct": p["stop"] / price - 1, "entry_time": p["entry_time"]})
            equity = cash + sum(p["value"] for p in positions)
            g = self.guard
            return {
                "mode": self.cfg.mode, "products": self.cfg.products,
                "granularity": self.cfg.granularity, "paused": bool(self.state.get("paused")),
                "halted": g.halted, "halt_reason": g.halt_reason,
                "equity": equity, "cash": cash, "initial_cash": self.cfg.initial_cash,
                "peak_equity": g.peak_equity,
                "drawdown": equity / g.peak_equity - 1 if g.peak_equity else 0.0,
                "day_pnl": equity / g.day_start_equity - 1 if g.day_start_equity else 0.0,
                "positions": positions, "prices": prices,
                "started": self.started.isoformat(timespec="seconds"),
                "last_step": self.last_step.isoformat(timespec="seconds") if self.last_step else None,
                "last_error": self.last_error,
            }

    def set_paused(self, paused: bool) -> None:
        with self.lock:
            self.state["paused"] = paused
            self._save()
        self.say("⏸️ Bot en pause : plus de nouveaux achats (les stops restent actifs)." if paused
                 else "▶️ Bot réactivé : les nouveaux achats sont autorisés.")

    def close_position(self, pid: str) -> bool:
        price = data.last_price(pid)
        with self.lock:
            if pid not in self.state["positions"]:
                return False
            self._sell(pid, price, "manuel")
            self._save()
            return True

    def reset_halt(self) -> None:
        with self.lock:
            equity = self._equity(self.prices) if self.prices else self.broker.usd_balance()
            self.guard.halted, self.guard.halt_reason = False, ""
            self.guard.peak_equity = equity  # le drawdown repart de zéro
            self._save()
        self.say("🔓 Coupe-circuit réinitialisé manuellement.", "warning")

    def signal_report(self) -> list[dict]:
        """Où en est chaque crypto par rapport aux conditions d'achat (bougies clôturées)."""
        out = []
        for pid in self.cfg.products:
            df = data.recent_candles(pid, self.cfg.granularity,
                                     count=max(600, self.cfg.strategy.ema_slow * 3))
            b = prepare(df, self.cfg.strategy).iloc[-1]
            out.append({
                "product": pid, "close": b["close"],
                "trend_up": bool(b["close"] > b["ema_slow"] and b["ema_fast"] > b["ema_slow"]),
                "ema_slow": b["ema_slow"], "channel_high": b["channel_high"],
                "to_breakout_pct": b["channel_high"] / b["close"] - 1, "entry": bool(b["entry"])})
        return out
