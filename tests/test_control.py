import base64
import threading
import time
import urllib.error
import urllib.request

import pytest

from bot import data
from bot.config import Config
from bot.live import LiveBot
from bot.telegram_bot import TelegramController
from tests.test_bot import SP, candles
from bot.strategy import prepare


@pytest.fixture
def bot(tmp_path, monkeypatch):
    monkeypatch.setattr("bot.live.send_telegram", lambda msg: None)
    monkeypatch.setattr(data, "last_price", lambda pid: 150.0)
    b = LiveBot(Config(products=["X-USD"], strategy=SP), str(tmp_path / "s.json"))
    df = prepare(candles([100] * 30 + [100 + 3 * i for i in range(1, 30)]), SP)
    b.on_bar("X-USD", df, {"X-USD": df["close"].iloc[-1]})
    b.prices = {"X-USD": 150.0}
    return b


@pytest.fixture
def tg(bot):
    sent = []
    return TelegramController(bot, token="t", chat_id="42", send=sent.append), sent


def test_ignores_unknown_chat(tg):
    ctl, sent = tg
    ctl.on_message({"chat": {"id": 999}, "text": "/statut"})
    assert sent == []
    ctl.on_message({"chat": {"id": 42}, "text": "/statut"})
    assert "SIMULATION" not in sent[0] and "PAPER" in sent[0]


def test_status_and_positions(tg):
    ctl, _ = tg
    assert "Positions ouvertes : 1" in ctl.handle("/statut")
    assert "X-USD" in ctl.handle("/positions")
    assert "achat" in ctl.handle("/journal").lower() or "🟢" in ctl.handle("/journal")


def test_sell_requires_confirmation(tg, bot):
    ctl, _ = tg
    assert "/confirmer" in ctl.handle("/vendre x")  # complété en X-USD
    assert "X-USD" in bot.state["positions"]
    assert "Fait" in ctl.handle("/confirmer")
    assert "X-USD" not in bot.state["positions"]
    assert "Rien à confirmer" in ctl.handle("/confirmer")
    assert "1" in ctl.handle("/perf")


def test_confirmation_expires(tg, bot, monkeypatch):
    ctl, _ = tg
    ctl.handle("/vendre X-USD")
    monkeypatch.setattr(time, "time", lambda: 10 ** 12)
    assert "Délai dépassé" in ctl.handle("/confirmer")
    assert "X-USD" in bot.state["positions"]


def test_pause_blocks_new_entries(tg, bot):
    ctl, _ = tg
    ctl.handle("/vendre_tout")
    ctl.handle("/confirmer")
    assert bot.state["paused"] and not bot.state["positions"]
    df = prepare(candles([100] * 30 + [100 + 3 * i for i in range(1, 30)]), SP)
    bot.on_bar("X-USD", df, {"X-USD": df["close"].iloc[-1]})
    assert not bot.state["positions"]
    ctl.handle("/reprendre")
    bot.on_bar("X-USD", df, {"X-USD": df["close"].iloc[-1]})
    assert bot.state["positions"]


def test_unknown_command(tg):
    assert "inconnue" in tg[0].handle("/nimportequoi")


def _get(url, password=None):
    req = urllib.request.Request(url)
    if password:
        req.add_header("Authorization", "Basic " + base64.b64encode(f"admin:{password}".encode()).decode())
    return urllib.request.urlopen(req, timeout=5)


def test_dashboard_requires_password(bot, monkeypatch):
    from bot.dashboard import serve
    monkeypatch.setenv("DASHBOARD_PASSWORD", "un-mot-de-passe-long")
    stop = threading.Event()
    t = threading.Thread(target=serve, args=(bot, stop, "127.0.0.1", 8765), daemon=True)
    t.start()
    time.sleep(0.3)
    try:
        assert _get("http://127.0.0.1:8765/healthz").read() == b"ok"
        with pytest.raises(urllib.error.HTTPError) as e:
            _get("http://127.0.0.1:8765/api/status", "mauvais")
        assert e.value.code == 401
        body = _get("http://127.0.0.1:8765/api/status", "un-mot-de-passe-long").read()
        assert b"X-USD" in body
        assert b"<title>" in _get("http://127.0.0.1:8765/", "un-mot-de-passe-long").read()
    finally:
        stop.set()
        t.join(3)


def test_dashboard_disabled_without_password(bot, monkeypatch):
    from bot.dashboard import serve
    monkeypatch.delenv("DASHBOARD_PASSWORD", raising=False)
    serve(bot, threading.Event(), "127.0.0.1", 8766)  # retourne immédiatement
