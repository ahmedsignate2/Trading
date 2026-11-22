"""Boucle du bot en direct (paper ou réel).

Chaque minute : vérification des stops au prix courant.
À chaque nouvelle bougie clôturée : mise à jour du stop suiveur, sortie de tendance, entrées.
L'état est sauvegardé dans un fichier JSON pour survivre à un redémarrage.
"""
from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path

import pandas as pd
import requests

from . import data
from .broker import CoinbaseBroker, PaperBroker
from .risk import RiskGuard, position_size_usd
from .strategy import initial_stop, prepare, trail_stop

log = logging.getLogger("bot")


def notify(msg: str) -> None:
    log.info(msg)
    token, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if token and chat:
        try:
            requests.post(f"https://api.telegram.org/bot{token}/sendMessage",
                          json={"chat_id": chat, "text": msg}, timeout=10)
        except requests.RequestException as e:
            log.warning("Alerte Telegram non envoyée : %s", e)


class LiveBot:
    def __init__(self, cfg, state_path: str):
        self.cfg = cfg
        self.state_path = Path(state_path)
        self.state = self._load_state()
        self.guard = RiskGuard.from_dict(cfg.risk, self.state.get("guard", {}))
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
        if self.state_path.exists():
            return json.loads(self.state_path.read_text())
        return {"positions": {}, "last_bar": {}}

    def _save(self) -> None:
        self.state["guard"] = self.guard.to_dict()
        if isinstance(self.broker, PaperBroker):
            self.state["paper_cash"] = self.broker.cash
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state, indent=2, default=str))
        tmp.replace(self.state_path)

    def _reconcile(self) -> None:
        """Vérifie que les positions connues existent bien sur le compte."""
        for pid in list(self.state["positions"]):
            held = self.broker.base_balance(pid)
            if held < self.state["positions"][pid]["qty"] * 0.95:
                notify(f"⚠️ {pid} : position attendue introuvable sur Coinbase, retirée du suivi.")
                del self.state["positions"][pid]

    # --- calculs ----------------------------------------------------------
    def _equity(self, prices: dict[str, float]) -> float:
        return self.broker.usd_balance() + sum(
            p["qty"] * prices[pid] for pid, p in self.state["positions"].items())

    def _sell(self, pid: str, price: float, reason: str) -> None:
        pos = self.state["positions"][pid]
        qty, fill = self.broker.sell(pid, pos["qty"], price)
        pnl = (fill - pos["entry_price"]) / pos["entry_price"]
        notify(f"VENTE {pid} {qty:.6f} @ {fill:,.2f} ({reason}) | variation {pnl:+.2%}")
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
        equity = self._equity(prices)
        ok, why = self.guard.can_open(equity)
        if not ok:
            notify(f"Signal d'achat {pid} ignoré : {why}")
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
                                        "entry_time": pd.Timestamp.now('UTC').isoformat()}
        notify(f"ACHAT {pid} {qty:.6f} @ {fill:,.2f} ({usd:,.0f} $) | stop {stop:,.2f}")

    def step(self) -> None:
        cfg = self.cfg
        prices = {pid: data.last_price(pid) for pid in cfg.products}
        equity = self._equity(prices)
        self.guard.update(equity, pd.Timestamp.now('UTC'))

        if self.guard.halted:
            if self.state["positions"]:
                notify(f"🛑 Coupe-circuit : {self.guard.halt_reason}. Liquidation des positions.")
                for pid in list(self.state["positions"]):
                    self._sell(pid, prices[pid], "coupe-circuit")
            self._save()
            return

        self.check_stops(prices)
        sec = data.GRANULARITY_SECONDS[cfg.granularity]
        for pid in cfg.products:
            # Nouvelle bougie clôturée depuis le dernier passage ?
            latest_closed = (int(time.time()) // sec - 1) * sec
            if self.state["last_bar"].get(pid, 0) >= latest_closed:
                continue
            df = data.recent_candles(pid, cfg.granularity, count=max(600, cfg.strategy.ema_slow * 3))
            if df.empty or int(df.index[-1].timestamp()) < latest_closed:
                continue  # l'API n'a pas encore publié la bougie, on réessaie au prochain tour
            self.on_bar(pid, df, prices)
            self.state["last_bar"][pid] = int(df.index[-1].timestamp())
        self._save()

    def run(self) -> None:
        notify(f"Bot démarré en mode {self.cfg.mode.upper()} sur {', '.join(self.cfg.products)}")
        while True:
            try:
                self.step()
            except Exception as e:  # le bot ne doit pas mourir sur une erreur réseau
                log.exception("Erreur pendant le cycle")
                notify(f"⚠️ Erreur : {e}")
            time.sleep(self.cfg.poll_seconds)
