// Données publiques Coinbase Advanced Trade (aucune clé nécessaire).
import type { Candle } from "./strategy";

const API = "https://api.coinbase.com/api/v3/brokerage/market/products";

async function getJson(url: string): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "trading-bot-worker" } });
      if (r.ok) return await r.json();
      lastErr = new Error(`Coinbase ${r.status} sur ${url.replace(API, "")}`);
    } catch (e) { lastErr = e; }
    await new Promise(res => setTimeout(res, 500 * (attempt + 1)));
  }
  throw lastErr;
}

export async function lastPrice(product: string): Promise<number> {
  const d = await getJson(`${API}/${product}`);
  return parseFloat(d.price);
}

/** Bougies clôturées les plus récentes, de la plus ancienne à la plus récente. */
export async function recentCandles(product: string, granularity: string, sec: number,
                                    count = 600): Promise<Candle[]> {
  const now = Math.floor(Date.now() / 1000);
  const byTime = new Map<number, Candle>();
  for (let end = now; end > now - count * sec; end -= 300 * sec) {
    const start = Math.max(now - count * sec, end - 300 * sec);
    const d = await getJson(`${API}/${product}/candles?granularity=${granularity}&start=${start}&end=${end}`);
    for (const c of d.candles ?? []) {
      const t = parseInt(c.start);
      byTime.set(t, { time: t, open: +c.open, high: +c.high, low: +c.low, close: +c.close });
    }
  }
  return [...byTime.values()]
    .sort((a, b) => a.time - b.time)
    .filter(c => c.time + sec <= now); // retire la bougie en cours
}
