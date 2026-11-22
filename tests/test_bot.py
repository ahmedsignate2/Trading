import numpy as np
import pandas as pd
import pytest

from bot.backtest import CostParams, run_backtest
from bot.broker import PaperBroker
from bot.data import drop_incomplete
from bot.live import LiveBot
from bot.config import Config
from bot.risk import RiskGuard, RiskParams, position_size_usd
from bot.strategy import StrategyParams, atr, prepare, trail_stop

SP = StrategyParams(ema_fast=5, ema_slow=10, breakout=5, atr_period=5)


def candles(closes, start="2024-01-01", freq="1D"):
    c = np.asarray(closes, dtype=float)
    idx = pd.date_range(start, periods=len(c), freq=freq, tz="UTC")
    return pd.DataFrame({"open": c, "high": c * 1.01, "low": c * 0.99, "close": c,
                         "volume": 1.0}, index=idx)


def test_position_size_respects_risk_and_caps():
    rp = RiskParams(risk_per_trade=0.01, max_position_pct=0.5)
    # stop à 10 % : 1 % de risque => 10 % du capital
    assert position_size_usd(10_000, 10_000, 0, 100, 90, rp) == pytest.approx(1_000)
    # stop très serré : plafonné à 50 % du capital
    assert position_size_usd(10_000, 10_000, 0, 100, 99.9, rp) == pytest.approx(5_000)
    # stop au-dessus du prix : pas de trade
    assert position_size_usd(10_000, 10_000, 0, 100, 101, rp) == 0


def test_guard_halts_on_drawdown_and_daily_loss():
    g = RiskGuard(RiskParams(daily_loss_limit=0.03, max_drawdown=0.2))
    g.update(10_000, pd.Timestamp("2024-01-01", tz="UTC"))
    assert g.can_open(9_600)[0] is False  # -4 % dans la journée
    g.update(9_600, pd.Timestamp("2024-01-02", tz="UTC"))
    assert g.can_open(9_600)[0] is True   # nouveau jour
    g.update(7_900, pd.Timestamp("2024-01-03", tz="UTC"))
    assert g.halted and g.can_open(7_900)[0] is False


def test_trailing_stop_never_moves_down():
    assert trail_stop(95, 100, 10, SP) == 95  # 100 - 3*10 = 70 < 95
    assert trail_stop(95, 150, 10, SP) == 120


def test_atr_constant_range():
    df = candles([100] * 30)
    assert atr(df, 5).iloc[-1] == pytest.approx(2.0)


def test_no_lookahead_entry_happens_next_open():
    closes = [100] * 30 + [100 + 3 * i for i in range(1, 30)]
    df = candles(closes)
    df["open"] = df["close"].shift(1).fillna(100) + 0.5  # ouverture distincte de la clôture
    res = run_backtest({"X": df}, SP, RiskParams(), CostParams(fee=0, slippage=0))
    first_signal = prepare(df, SP).query("entry").index[0]
    entry_time = res.trades.iloc[0]["entry_time"]
    assert entry_time > first_signal
    assert res.trades.iloc[0]["entry_price"] == pytest.approx(df.loc[entry_time, "open"])


def test_gap_below_stop_exits_at_open():
    closes = [100] * 30 + [100 + 3 * i for i in range(1, 15)]
    df = candles(closes)
    crash = df.index[-1] + pd.Timedelta(days=1)
    df.loc[crash] = {"open": 50, "high": 52, "low": 49, "close": 51, "volume": 1}
    res = run_backtest({"X": df}, SP, RiskParams(), CostParams(fee=0, slippage=0))
    last = res.trades.iloc[-1]
    assert last["reason"] == "stop" and last["exit_price"] == pytest.approx(50)


def test_fees_reduce_paper_cash():
    b = PaperBroker(1_000, fee=0.006, slippage=0)
    qty, _ = b.buy("BTC-USD", 500, 100)
    assert qty == pytest.approx(4.97)
    b.sell("BTC-USD", qty, 100)
    assert b.cash < 1_000


def test_drop_incomplete_candle():
    df = candles([1, 2, 3], start="2024-01-01")
    now = pd.Timestamp("2024-01-03 12:00", tz="UTC").timestamp()
    assert len(drop_incomplete(df, "ONE_DAY", now)) == 2


def test_live_bot_paper_buys_on_signal_and_stops_out(tmp_path, monkeypatch):
    cfg = Config(products=["X-USD"], granularity="ONE_DAY", strategy=SP)
    bot = LiveBot(cfg, str(tmp_path / "state.json"))
    df = prepare(candles([100] * 30 + [100 + 3 * i for i in range(1, 30)]), SP)
    assert df["entry"].iloc[-1]
    bot.on_bar("X-USD", df, {"X-USD": df["close"].iloc[-1]})
    pos = bot.state["positions"]["X-USD"]
    assert pos["qty"] > 0 and pos["stop"] < df["close"].iloc[-1]
    bot.check_stops({"X-USD": pos["stop"] - 1})
    assert "X-USD" not in bot.state["positions"]
    assert bot.broker.cash < 10_000  # frais payés


def test_live_mode_requires_confirmation(tmp_path, monkeypatch):
    monkeypatch.delenv("BOT_CONFIRM_LIVE", raising=False)
    with pytest.raises(SystemExit):
        LiveBot(Config(mode="live"), str(tmp_path / "s.json"))
