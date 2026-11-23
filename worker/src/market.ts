// Intelligence de marché : régime, indicateurs, corrélations. Calculs purs, testables.
import { Candle, CONFIG, atr, ema, lastSignal } from "./strategy";

/** RSI de Wilder. */
export function rsi(closes: number[], n = 14): number {
  if (closes.length <= n) return NaN;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= n; loss /= n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
  }
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}

/** ADX de Wilder : force de la tendance (> 25 = tendance nette, < 20 = marché sans direction). */
export function adx(c: Candle[], n = 14): number {
  if (c.length < 2 * n + 1) return NaN;
  let trS = 0, pS = 0, mS = 0;
  const dx: number[] = [];
  for (let i = 1; i < c.length; i++) {
    const up = c[i].high - c[i - 1].high, down = c[i - 1].low - c[i].low;
    const pdm = up > down && up > 0 ? up : 0, mdm = down > up && down > 0 ? down : 0;
    const tr = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
    if (i <= n) { trS += tr; pS += pdm; mS += mdm; if (i < n) continue; }
    else { trS = trS - trS / n + tr; pS = pS - pS / n + pdm; mS = mS - mS / n + mdm; }
    const pdi = trS ? 100 * pS / trS : 0, mdi = trS ? 100 * mS / trS : 0;
    dx.push(pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0);
  }
  if (dx.length < n) return NaN;
  let a = dx.slice(0, n).reduce((s, v) => s + v, 0) / n;
  for (let i = n; i < dx.length; i++) a = (a * (n - 1) + dx[i]) / n;
  return a;
}

export type Regime = "haussier" | "baissier" | "range";

export function regimeOf(close: number, emaFast: number, emaSlow: number, adxValue: number): Regime {
  if (adxValue < 20) return "range";
  if (close > emaSlow && emaFast > emaSlow) return "haussier";
  if (close < emaSlow && emaFast < emaSlow) return "baissier";
  return "range";
}

const pctChange = (closes: number[], k: number) =>
  closes.length > k ? closes[closes.length - 1] / closes[closes.length - 1 - k] - 1 : NaN;

export interface AssetView {
  product: string; price: number; change1d: number; change7d: number; change30d: number;
  regime: Regime; adx: number; rsi: number; atrPct: number; volumeRatio: number;
  emaFast: number; emaSlow: number; channelHigh: number; toBreakoutPct: number;
  signal: "achat" | "attente" | "aucun"; reason: string;
}

/** Vue complète d'un actif à partir de ses bougies journalières clôturées et du prix courant. */
export function analyzeAsset(product: string, c: Candle[], livePrice?: number): AssetView {
  const closes = c.map(b => b.close);
  const s = lastSignal(c);
  const a = adx(c);
  const r = rsi(closes);
  const atrLast = atr(c, CONFIG.strategy.atrPeriod)[c.length - 1];
  const vols = c.map(b => b.volume ?? 0);
  const avgVol = vols.slice(-21, -1).reduce((x, y) => x + y, 0) / 20;
  const regime = regimeOf(s.close, s.emaFast, s.emaSlow, a);
  const price = livePrice ?? s.close;
  let signal: AssetView["signal"], reason: string;
  if (s.entry) { signal = "achat"; reason = "Cassure du plus haut 20 jours en tendance haussière"; }
  else if (s.trendUp) { signal = "attente"; reason = `Tendance haussière : achat si clôture > ${s.channelHigh.toFixed(2)}`; }
  else { signal = "aucun"; reason = s.close < s.emaSlow ? "Prix sous la moyenne 200 jours" : "Moyenne 50 jours sous la 200 jours"; }
  return {
    product, price,
    change1d: livePrice ? livePrice / closes[closes.length - 1] - 1 : pctChange(closes, 1),
    change7d: pctChange(closes, 7), change30d: pctChange(closes, 30),
    regime, adx: a, rsi: r, atrPct: atrLast / s.close,
    volumeRatio: avgVol ? vols[vols.length - 1] / avgVol : NaN,
    emaFast: s.emaFast, emaSlow: s.emaSlow, channelHigh: s.channelHigh,
    toBreakoutPct: s.channelHigh / price - 1, signal, reason,
  };
}

/** Corrélation de Pearson des rendements journaliers sur les `days` derniers jours. */
export function correlation(a: Candle[], b: Candle[], days = 90): number {
  const mb = new Map(b.map(x => [x.time, x.close]));
  const pairs: [number, number][] = [];
  for (let i = 1; i < a.length; i++) {
    const p0 = mb.get(a[i - 1].time), p1 = mb.get(a[i].time);
    if (p0 && p1) pairs.push([a[i].close / a[i - 1].close - 1, p1 / p0 - 1]);
  }
  const xs = pairs.slice(-days);
  const n = xs.length;
  if (n < 10) return NaN;
  const mx = xs.reduce((s, p) => s + p[0], 0) / n, my = xs.reduce((s, p) => s + p[1], 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of xs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy);
}

/** Séries EMA pour les graphiques. */
export function emaSeries(c: Candle[]) {
  const closes = c.map(b => b.close);
  return { fast: ema(closes, CONFIG.strategy.emaFast), slow: ema(closes, CONFIG.strategy.emaSlow) };
}

/** Métriques de risque à partir des points de capital (un point toutes les ~15 min). */
export function riskMetrics(points: { time: string; equity: number }[]) {
  if (points.length < 2) return null;
  const byDay = new Map<string, number>();
  for (const p of points) byDay.set(p.time.slice(0, 10), p.equity);
  const daily = [...byDay.values()];
  const rets = daily.slice(1).map((v, i) => v / daily[i] - 1).filter(Number.isFinite);
  let peak = -Infinity, maxDd = 0;
  for (const p of points) { peak = Math.max(peak, p.equity); maxDd = Math.min(maxDd, p.equity / peak - 1); }
  const mean = rets.length ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  const sd = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)) : 0;
  const neg = rets.filter(r => r < 0);
  const dsd = neg.length > 1 ? Math.sqrt(neg.reduce((s, r) => s + r * r, 0) / neg.length) : 0;
  return {
    days: daily.length, totalReturn: points[points.length - 1].equity / points[0].equity - 1, maxDrawdown: maxDd,
    sharpe: rets.length >= 20 && sd ? mean / sd * Math.sqrt(365) : null,
    sortino: rets.length >= 20 && dsd ? mean / dsd * Math.sqrt(365) : null,
  };
}
