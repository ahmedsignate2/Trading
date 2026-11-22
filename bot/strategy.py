"""Stratégie : cassure de canal (Donchian) dans le sens de la tendance, long uniquement.

Règles (évaluées à la clôture de chaque bougie) :
- Filtre de tendance : clôture > EMA lente ET EMA rapide > EMA lente.
- Entrée : la clôture dépasse le plus haut des N dernières bougies.
- Stop initial : prix d'entrée - stop_atr x ATR.
- Stop suiveur : plus haute clôture depuis l'entrée - trail_atr x ATR (ne descend jamais).
- Sortie de régime : clôture sous l'EMA lente.
"""
from __future__ import annotations

from dataclasses import dataclass

import pandas as pd


@dataclass
class StrategyParams:
    ema_fast: int = 50
    ema_slow: int = 200
    breakout: int = 20
    atr_period: int = 14
    stop_atr: float = 2.5
    trail_atr: float = 3.0


def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False, min_periods=n).mean()


def atr(df: pd.DataFrame, n: int) -> pd.Series:
    prev_close = df["close"].shift(1)
    tr = pd.concat(
        [df["high"] - df["low"], (df["high"] - prev_close).abs(), (df["low"] - prev_close).abs()],
        axis=1,
    ).max(axis=1)
    return tr.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()  # lissage de Wilder


def prepare(df: pd.DataFrame, p: StrategyParams) -> pd.DataFrame:
    out = df.copy()
    out["ema_fast"] = ema(out["close"], p.ema_fast)
    out["ema_slow"] = ema(out["close"], p.ema_slow)
    out["atr"] = atr(out, p.atr_period)
    out["channel_high"] = out["high"].rolling(p.breakout).max().shift(1)
    trend_up = (out["close"] > out["ema_slow"]) & (out["ema_fast"] > out["ema_slow"])
    out["entry"] = trend_up & (out["close"] > out["channel_high"]) & out["atr"].notna()
    out["regime_exit"] = out["close"] < out["ema_slow"]
    return out


def initial_stop(price: float, atr_value: float, p: StrategyParams) -> float:
    return price - p.stop_atr * atr_value


def trail_stop(current_stop: float, highest_close: float, atr_value: float, p: StrategyParams) -> float:
    return max(current_stop, highest_close - p.trail_atr * atr_value)
