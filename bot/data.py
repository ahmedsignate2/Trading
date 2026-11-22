"""Récupération des bougies Coinbase (API publique Advanced Trade, sans clé)."""
from __future__ import annotations

import time
from pathlib import Path

import pandas as pd
import requests

API = "https://api.coinbase.com/api/v3/brokerage/market/products"
GRANULARITY_SECONDS = {
    "ONE_HOUR": 3600,
    "TWO_HOUR": 7200,
    "FOUR_HOUR": 14400,
    "SIX_HOUR": 21600,
    "ONE_DAY": 86400,
}
MAX_CANDLES_PER_CALL = 300  # l'API en accepte 350, on garde une marge


def _get(url: str, params: dict | None = None, retries: int = 4) -> dict:
    for attempt in range(retries):
        try:
            r = requests.get(url, params=params, timeout=15)
            if r.status_code == 429:
                time.sleep(2 ** attempt)
                continue
            r.raise_for_status()
            return r.json()
        except requests.RequestException:
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)
    raise RuntimeError(f"Échec de la requête {url}")


def fetch_candles(product: str, granularity: str, start: int, end: int) -> pd.DataFrame:
    """Bougies entre deux timestamps UNIX, en paginant. Index UTC, trié."""
    sec = GRANULARITY_SECONDS[granularity]
    rows = []
    cursor = start
    while cursor < end:
        chunk_end = min(cursor + sec * MAX_CANDLES_PER_CALL, end)
        data = _get(
            f"{API}/{product}/candles",
            {"granularity": granularity, "start": cursor, "end": chunk_end},
        )
        rows.extend(data.get("candles", []))
        cursor = chunk_end
        time.sleep(0.12)  # rester sous la limite de requêtes publique
    return _to_frame(rows)


def _to_frame(rows: list[dict]) -> pd.DataFrame:
    cols = ["open", "high", "low", "close", "volume"]
    if not rows:
        return pd.DataFrame(columns=cols, index=pd.DatetimeIndex([], tz="UTC", name="time"))
    df = pd.DataFrame(rows)
    df["time"] = pd.to_datetime(df["start"].astype(int), unit="s", utc=True)
    df = df.set_index("time")[cols].astype(float)
    return df[~df.index.duplicated(keep="last")].sort_index()


def drop_incomplete(df: pd.DataFrame, granularity: str, now: float | None = None) -> pd.DataFrame:
    """Retire la bougie en cours (pas encore clôturée) pour éviter tout biais."""
    if df.empty:
        return df
    now = time.time() if now is None else now
    sec = GRANULARITY_SECONDS[granularity]
    last_start = df.index[-1].timestamp()
    return df.iloc[:-1] if last_start + sec > now else df


def load_history(product: str, granularity: str, start: str, cache_dir: str = "data") -> pd.DataFrame:
    """Historique avec cache CSV local, mis à jour de façon incrémentale."""
    path = Path(cache_dir) / f"{product}_{granularity}.csv"
    path.parent.mkdir(parents=True, exist_ok=True)
    start_ts = int(pd.Timestamp(start, tz="UTC").timestamp())
    now = int(time.time())

    cached = None
    if path.exists():
        cached = pd.read_csv(path, index_col="time", parse_dates=True)
        if cached.index.tz is None:
            cached.index = cached.index.tz_localize("UTC")
        if cached.empty or cached.index[0].timestamp() > start_ts + GRANULARITY_SECONDS[granularity]:
            cached = None  # le cache ne couvre pas le début demandé

    if cached is not None:
        fresh = fetch_candles(product, granularity, int(cached.index[-1].timestamp()), now)
        df = pd.concat([cached, fresh])
        df = df[~df.index.duplicated(keep="last")].sort_index()
    else:
        df = fetch_candles(product, granularity, start_ts, now)

    df = drop_incomplete(df, granularity)
    df.to_csv(path)
    return df[df.index >= pd.Timestamp(start, tz="UTC")]


def recent_candles(product: str, granularity: str, count: int = 300) -> pd.DataFrame:
    """Dernières bougies clôturées (utilisé par le bot en direct)."""
    sec = GRANULARITY_SECONDS[granularity]
    end = int(time.time())
    df = fetch_candles(product, granularity, end - sec * count, end)
    return drop_incomplete(df, granularity)


def last_price(product: str) -> float:
    data = _get(f"{API}/{product}")
    return float(data["price"])
