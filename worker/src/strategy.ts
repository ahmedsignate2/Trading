// Même stratégie et même gestion du risque que bot/strategy.py et bot/risk.py.
// La parité avec Python est vérifiée par test/parity.test.mjs.

export interface Candle { time: number; open: number; high: number; low: number; close: number }

export const CONFIG = {
  mode: "paper" as const,
  products: ["BTC-USD", "ETH-USD", "SOL-USD"],
  granularity: "ONE_DAY",
  granularitySeconds: 86400,
  initialCash: 10_000,
  strategy: { emaFast: 50, emaSlow: 200, breakout: 20, atrPeriod: 14, stopAtr: 2.5, trailAtr: 3.0 },
  risk: {
    riskPerTrade: 0.01, maxPositionPct: 0.33, maxTotalExposure: 0.99,
    dailyLossLimit: 0.03, maxDrawdown: 0.20, minOrderUsd: 10, maxOrderUsd: 500,
  },
  costs: { fee: 0.006, slippage: 0.0005 },
};

/** EMA façon pandas ewm(span=n, adjust=False, min_periods=n). */
export function ema(values: number[], n: number): number[] {
  const a = 2 / (n + 1);
  const out: number[] = [];
  let prev = NaN;
  values.forEach((v, i) => {
    prev = i === 0 ? v : a * v + (1 - a) * prev;
    out.push(i >= n - 1 ? prev : NaN);
  });
  return out;
}

/** ATR avec lissage de Wilder (pandas ewm(alpha=1/n, adjust=False, min_periods=n)). */
export function atr(c: Candle[], n: number): number[] {
  const out: number[] = [];
  let prev = NaN;
  c.forEach((b, i) => {
    const tr = i === 0 ? b.high - b.low : Math.max(
      b.high - b.low, Math.abs(b.high - c[i - 1].close), Math.abs(b.low - c[i - 1].close));
    prev = i === 0 ? tr : prev + (tr - prev) / n;
    out.push(i >= n - 1 ? prev : NaN);
  });
  return out;
}

export interface Signal {
  close: number; emaFast: number; emaSlow: number; atr: number; channelHigh: number;
  trendUp: boolean; entry: boolean; regimeExit: boolean;
}

/** Indicateurs et signaux de la dernière bougie clôturée. */
export function lastSignal(c: Candle[], p = CONFIG.strategy): Signal {
  const closes = c.map(b => b.close);
  const i = c.length - 1;
  const ef = ema(closes, p.emaFast)[i], es = ema(closes, p.emaSlow)[i], a = atr(c, p.atrPeriod)[i];
  const prevHighs = c.slice(Math.max(0, i - p.breakout), i).map(b => b.high);
  const channelHigh = prevHighs.length === p.breakout ? Math.max(...prevHighs) : NaN;
  const close = closes[i];
  const trendUp = close > es && ef > es;
  return {
    close, emaFast: ef, emaSlow: es, atr: a, channelHigh, trendUp,
    entry: trendUp && close > channelHigh && !Number.isNaN(a),
    regimeExit: close < es,
  };
}

export const initialStop = (price: number, atrValue: number, p = CONFIG.strategy) =>
  price - p.stopAtr * atrValue;

export const trailStop = (stop: number, highestClose: number, atrValue: number, p = CONFIG.strategy) =>
  Math.max(stop, highestClose - p.trailAtr * atrValue);

export function positionSizeUsd(equity: number, cash: number, exposure: number,
                                entry: number, stop: number, r = CONFIG.risk): number {
  if (entry <= 0 || stop >= entry) return 0;
  const stopDist = (entry - stop) / entry;
  const usd = Math.min(equity * r.riskPerTrade / stopDist, equity * r.maxPositionPct,
                       equity * r.maxTotalExposure - exposure, cash * 0.995, r.maxOrderUsd);
  return usd >= r.minOrderUsd ? usd : 0;
}

export interface Guard {
  peakEquity: number; day: string; dayStartEquity: number; halted: boolean; haltReason: string;
}

export function updateGuard(g: Partial<Guard>, equity: number, now: Date, r = CONFIG.risk): Guard {
  const out: Guard = { peakEquity: 0, day: "", dayStartEquity: 0, halted: false, haltReason: "", ...g };
  const today = now.toISOString().slice(0, 10);
  if (today !== out.day) { out.day = today; out.dayStartEquity = equity; }
  out.peakEquity = Math.max(out.peakEquity, equity);
  if (!out.halted && out.peakEquity > 0) {
    const dd = 1 - equity / out.peakEquity;
    if (dd >= r.maxDrawdown) {
      out.halted = true;
      out.haltReason = `drawdown ${(dd * 100).toFixed(1)} % >= ${r.maxDrawdown * 100} %`;
    }
  }
  return out;
}

export function canOpen(g: Guard, equity: number, r = CONFIG.risk): [boolean, string] {
  if (g.halted) return [false, `bot arrêté : ${g.haltReason}`];
  if (g.dayStartEquity > 0) {
    const day = equity / g.dayStartEquity - 1;
    if (day <= -r.dailyLossLimit) return [false, `perte du jour ${(day * 100).toFixed(1)} %`];
  }
  return [true, ""];
}
