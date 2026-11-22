"""Gestion du risque : taille des positions et coupe-circuits."""
from __future__ import annotations

from dataclasses import dataclass, field

import pandas as pd


@dataclass
class RiskParams:
    risk_per_trade: float = 0.01      # perte max si le stop est touché, en % du capital
    max_position_pct: float = 0.33    # taille max d'une position, en % du capital
    max_total_exposure: float = 0.99  # spot : jamais plus que le capital
    daily_loss_limit: float = 0.03    # plus de nouvelles entrées ce jour-là au-delà
    max_drawdown: float = 0.20        # arrêt complet du bot (reprise manuelle)
    min_order_usd: float = 10.0
    max_order_usd: float = 1_000_000.0  # plafond absolu par ordre (sécurité en réel)


def position_size_usd(equity: float, cash: float, exposure: float, entry: float, stop: float,
                      rp: RiskParams) -> float:
    """Montant en USD à acheter. 0 si le trade n'est pas autorisé."""
    if entry <= 0 or stop >= entry:
        return 0.0
    stop_dist = (entry - stop) / entry
    by_risk = equity * rp.risk_per_trade / stop_dist
    by_cap = equity * rp.max_position_pct
    by_exposure = equity * rp.max_total_exposure - exposure
    usd = min(by_risk, by_cap, by_exposure, cash * 0.995, rp.max_order_usd)
    return usd if usd >= rp.min_order_usd else 0.0


@dataclass
class RiskGuard:
    rp: RiskParams
    peak_equity: float = 0.0
    day: str = ""
    day_start_equity: float = 0.0
    halted: bool = False
    halt_reason: str = ""
    events: list = field(default_factory=list)

    def update(self, equity: float, now: pd.Timestamp) -> None:
        today = now.strftime("%Y-%m-%d")
        if today != self.day:
            self.day, self.day_start_equity = today, equity
        self.peak_equity = max(self.peak_equity, equity)
        if not self.halted and self.peak_equity > 0:
            dd = 1 - equity / self.peak_equity
            if dd >= self.rp.max_drawdown:
                self.halted = True
                self.halt_reason = f"drawdown {dd:.1%} >= {self.rp.max_drawdown:.0%}"
                self.events.append((now, self.halt_reason))

    def can_open(self, equity: float) -> tuple[bool, str]:
        if self.halted:
            return False, f"bot arrêté : {self.halt_reason}"
        if self.day_start_equity > 0:
            day_pnl = equity / self.day_start_equity - 1
            if day_pnl <= -self.rp.daily_loss_limit:
                return False, f"perte du jour {day_pnl:.1%}"
        return True, ""

    def to_dict(self) -> dict:
        return {k: getattr(self, k) for k in
                ("peak_equity", "day", "day_start_equity", "halted", "halt_reason")}

    @classmethod
    def from_dict(cls, rp: RiskParams, d: dict) -> "RiskGuard":
        g = cls(rp)
        for k, v in d.items():
            setattr(g, k, v)
        return g
