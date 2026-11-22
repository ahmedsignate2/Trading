"""Backtest multi-actifs sans biais d'anticipation.

- Les signaux sont calculés à la clôture de la bougie t et exécutés à l'ouverture de t+1.
- Les stops sont vérifiés à l'intérieur de chaque bougie (plus bas <= stop).
  En cas de gap sous le stop, la sortie se fait au prix d'ouverture (pire cas réaliste).
- Frais et glissement (slippage) appliqués à chaque ordre.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .risk import RiskGuard, RiskParams, position_size_usd
from .strategy import StrategyParams, initial_stop, prepare, trail_stop


@dataclass
class CostParams:
    fee: float = 0.006       # frais taker Coinbase (palier le plus bas)
    slippage: float = 0.0005


@dataclass
class BacktestResult:
    equity: pd.Series
    trades: pd.DataFrame
    halts: list
    bars_per_year: float


def run_backtest(data: dict[str, pd.DataFrame], sp: StrategyParams, rp: RiskParams,
                 cp: CostParams, initial_cash: float = 10_000.0,
                 trade_from: pd.Timestamp | None = None) -> BacktestResult:
    """trade_from : aucune position avant cette date (indicateurs calculés sur tout l'historique)."""
    frames = {pid: prepare(df, sp) for pid, df in data.items()}
    timeline = sorted(set().union(*[f.index for f in frames.values()]))
    cash = initial_cash
    positions: dict[str, dict] = {}
    pending: dict[str, dict] = {}   # ordres à exécuter à la prochaine ouverture
    last_close: dict[str, float] = {}
    guard = RiskGuard(rp)
    trades, equity_curve = [], []

    def equity_now() -> float:
        return cash + sum(p["qty"] * last_close[pid] for pid, p in positions.items())

    def close_position(pid, raw_price, ts, reason):
        nonlocal cash
        pos = positions.pop(pid)
        price = raw_price * (1 - cp.slippage)
        proceeds = pos["qty"] * price
        fee = proceeds * cp.fee
        cash += proceeds - fee
        pnl = proceeds - fee - pos["cost"]
        trades.append({"product": pid, "entry_time": pos["entry_time"], "exit_time": ts,
                       "entry_price": pos["entry_price"], "exit_price": price, "qty": pos["qty"],
                       "pnl": pnl, "return": pnl / pos["cost"], "reason": reason})

    for ts in timeline:
        if trade_from is not None and ts < trade_from:
            continue
        for pid, f in frames.items():
            if ts not in f.index:
                continue
            bar = f.loc[ts]

            # 1) Ordres en attente, exécutés à l'ouverture
            order = pending.pop(pid, None)
            if order and order["side"] == "sell" and pid in positions:
                close_position(pid, bar["open"], ts, order["reason"])
            elif order and order["side"] == "buy" and pid not in positions:
                eq = equity_now()
                ok, _ = guard.can_open(eq)
                entry = bar["open"] * (1 + cp.slippage)
                exposure = eq - cash
                usd = position_size_usd(eq, cash, exposure, entry, order["stop"], rp) if ok else 0
                if usd > 0:
                    fee = usd * cp.fee
                    qty = (usd - fee) / entry
                    cash -= usd
                    positions[pid] = {"qty": qty, "cost": usd, "entry_price": entry,
                                      "entry_time": ts, "stop": order["stop"],
                                      "highest_close": bar["open"]}

            # 2) Stop touché pendant la bougie
            pos = positions.get(pid)
            if pos and bar["low"] <= pos["stop"]:
                close_position(pid, min(bar["open"], pos["stop"]), ts, "stop")
                pos = None

            last_close[pid] = bar["close"]

            # 3) Décisions à la clôture
            if pos:
                pos["highest_close"] = max(pos["highest_close"], bar["close"])
                if not np.isnan(bar["atr"]):
                    pos["stop"] = trail_stop(pos["stop"], pos["highest_close"], bar["atr"], sp)
                if bar["regime_exit"]:
                    pending[pid] = {"side": "sell", "reason": "tendance"}
            elif bar["entry"]:
                pending[pid] = {"side": "buy",
                                "stop": initial_stop(bar["close"], bar["atr"], sp)}

        eq = equity_now()
        guard.update(eq, ts)
        equity_curve.append((ts, eq))
        if guard.halted:
            for pid in list(positions):
                close_position(pid, last_close[pid], ts, "coupe-circuit")
            equity_curve[-1] = (ts, cash)
            break

    # Clôture des positions restantes pour un bilan propre
    if timeline and positions:
        for pid in list(positions):
            close_position(pid, last_close[pid], timeline[-1], "fin du test")
        equity_curve[-1] = (timeline[-1], cash)

    equity = pd.Series(dict(equity_curve), name="equity")
    bar_sec = _median_bar_seconds(frames)
    return BacktestResult(equity, pd.DataFrame(trades), guard.events, 365 * 86400 / bar_sec)


def _median_bar_seconds(frames: dict[str, pd.DataFrame]) -> float:
    f = next(iter(frames.values()))
    return float(pd.Series(f.index).diff().dt.total_seconds().median())


def metrics(res: BacktestResult) -> dict:
    eq = res.equity
    if len(eq) < 2:
        return {}
    rets = eq.pct_change().dropna()
    years = (eq.index[-1] - eq.index[0]).total_seconds() / (365 * 86400)
    total = eq.iloc[-1] / eq.iloc[0] - 1
    dd = (eq / eq.cummax() - 1).min()
    sharpe = rets.mean() / rets.std() * np.sqrt(res.bars_per_year) if rets.std() > 0 else 0.0
    t = res.trades
    m = {
        "rendement_total": total,
        "rendement_annuel": (1 + total) ** (1 / years) - 1 if years > 0 and total > -1 else np.nan,
        "drawdown_max": dd,
        "sharpe": sharpe,
        "nb_trades": len(t),
    }
    if len(t):
        wins, losses = t[t.pnl > 0], t[t.pnl <= 0]
        m.update({
            "taux_reussite": len(wins) / len(t),
            "profit_factor": wins.pnl.sum() / abs(losses.pnl.sum()) if len(losses) else np.inf,
            "gain_moyen_trade": t["return"].mean(),
        })
    return m


def buy_and_hold(data: dict[str, pd.DataFrame], start, end, initial_cash: float, fee: float) -> dict:
    """Référence : capital réparti à parts égales, acheté au début et conservé."""
    curves = []
    for df in data.values():
        s = df["close"][(df.index >= start) & (df.index <= end)]
        if len(s):
            curves.append(s / s.iloc[0])
    eq = pd.concat(curves, axis=1).ffill().mean(axis=1) * initial_cash * (1 - fee)
    return {"rendement_total": eq.iloc[-1] / initial_cash - 1,
            "drawdown_max": (eq / eq.cummax() - 1).min()}
