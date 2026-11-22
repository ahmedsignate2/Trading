from __future__ import annotations

from dataclasses import dataclass, field

import yaml

from .backtest import CostParams
from .risk import RiskParams
from .strategy import StrategyParams


@dataclass
class Config:
    mode: str = "paper"  # "paper" (simulation) ou "live" (argent réel)
    products: list = field(default_factory=lambda: ["BTC-USD", "ETH-USD", "SOL-USD"])
    granularity: str = "FOUR_HOUR"
    quote_currency: str = "USD"
    initial_cash: float = 10_000.0
    history_start: str = "2021-01-01"
    poll_seconds: int = 60
    strategy: StrategyParams = field(default_factory=StrategyParams)
    risk: RiskParams = field(default_factory=RiskParams)
    costs: CostParams = field(default_factory=CostParams)


def load_config(path: str) -> Config:
    with open(path) as f:
        raw = yaml.safe_load(f) or {}
    cfg = Config(**{k: v for k, v in raw.items() if k not in ("strategy", "risk", "costs")})
    cfg.strategy = StrategyParams(**raw.get("strategy", {}))
    cfg.risk = RiskParams(**raw.get("risk", {}))
    cfg.costs = CostParams(**raw.get("costs", {}))
    if cfg.mode not in ("paper", "live"):
        raise ValueError("mode doit valoir 'paper' ou 'live'")
    return cfg
