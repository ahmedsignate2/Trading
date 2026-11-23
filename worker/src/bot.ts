// Cœur du bot : état dans D1, exécution (simulée ou réelle), stops, signaux journaliers.
import { Broker, LiveBroker, PaperBroker } from "./broker";
import { lastPrice, recentCandles } from "./coinbase";
import {
  CONFIG, Guard, canOpen, initialStop, lastSignal, positionSizeUsd, trailStop, updateGuard,
} from "./strategy";
import SCHEMA from "../schema.sql";
import { analyzeAsset, correlation, emaSeries, riskMetrics } from "./market";

// Cache par instance du Worker : évite de retélécharger les bougies à chaque rafraîchissement.
const candleCache = new Map<string, { at: number; data: Awaited<ReturnType<typeof recentCandles>> }>();
async function dailyCandles(product: string) {
  const hit = candleCache.get(product);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.data;
  const data = await recentCandles(product, CONFIG.granularity, CONFIG.granularitySeconds, 600);
  candleCache.set(product, { at: Date.now(), data });
  return data;
}

export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  DASHBOARD_PASSWORD?: string;
  PUBLIC_URL?: string;
  MODE?: string;               // "live" = argent réel, sinon simulation
  COINBASE_API_KEY?: string;
  COINBASE_API_SECRET?: string;
  MAX_ORDER?: string;          // plafond par ordre, en devise de cotation (défaut 50)
  QUOTE?: string;              // devise de cotation : USD, EUR, USDC… (défaut USD)
}

export interface Account {
  cash: number; paused: number; guard: Guard; last_bar: Record<string, number>;
  prices: Record<string, number>; last_step: string | null; last_error: string; webhook_key: string;
}

export interface Position {
  product: string; qty: number; entry_price: number; stop: number; highest_close: number; entry_time: string;
}

const EQUITY_SNAPSHOT_MS = 15 * 60 * 1000;
const nowIso = () => new Date().toISOString().slice(0, 19) + "Z";
const fmt = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 2 });
const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)} %`;

export class Bot {
  mode: "paper" | "live";
  missingKeys: boolean;
  quote: string;
  products: string[];
  maxOrder: number;
  broker: Broker;

  constructor(public env: Env, public notify: (msg: string) => Promise<void> = async () => {}) {
    const wantsLive = env.MODE === "live";
    const hasKeys = !!(env.COINBASE_API_KEY && env.COINBASE_API_SECRET);
    this.mode = wantsLive && hasKeys ? "live" : "paper";
    this.missingKeys = wantsLive && !hasKeys;
    this.quote = (env.QUOTE || "USD").toUpperCase();
    this.products = ["BTC", "ETH", "SOL"].map(b => `${b}-${this.quote}`);
    this.maxOrder = parseFloat(env.MAX_ORDER || "") || 50;
    this.broker = this.mode === "live" ? new LiveBroker(env, this.quote) : new PaperBroker(env.DB);
  }

  private get limits() {
    return { ...CONFIG.risk, maxOrderUsd: this.maxOrder };
  }

  // --- base de données -------------------------------------------------------
  async init(): Promise<void> {
    const stmts = SCHEMA.split(";")
      .map(s => s.split("\n").filter(l => !l.trim().startsWith("--")).join("\n").trim())
      .filter(Boolean);
    await this.env.DB.batch(stmts.map(s => this.env.DB.prepare(s)));
    await this.env.DB.prepare("INSERT OR IGNORE INTO account (id, cash) VALUES (1, ?)")
      .bind(CONFIG.initialCash).run();
  }

  async account(): Promise<Account> {
    let r: any = null;
    try {
      r = await this.env.DB.prepare("SELECT * FROM account WHERE id = 1").first<any>();
    } catch (e) {
      if (!String(e).includes("no such table")) throw e;
    }
    if (!r) { await this.init(); return this.account(); }
    return { ...r, guard: JSON.parse(r.guard), last_bar: JSON.parse(r.last_bar), prices: JSON.parse(r.prices) };
  }

  async positions(): Promise<Position[]> {
    return (await this.env.DB.prepare("SELECT * FROM positions ORDER BY product").all<Position>()).results;
  }

  async say(message: string, level = "info"): Promise<void> {
    console.log(message);
    await this.env.DB.prepare("INSERT INTO events (time, level, message) VALUES (?, ?, ?)")
      .bind(nowIso(), level, message).run();
    await this.notify(message);
  }

  private async saveAccount(fields: Partial<Record<string, unknown>>): Promise<void> {
    const keys = Object.keys(fields);
    const values = keys.map(k => typeof fields[k] === "object" && fields[k] !== null ? JSON.stringify(fields[k]) : fields[k]);
    await this.env.DB.prepare(`UPDATE account SET ${keys.map(k => `${k} = ?`).join(", ")} WHERE id = 1`)
      .bind(...values).run();
  }

  // --- ordres -------------------------------------------------------------------
  /** Vend une position. Le DELETE ... RETURNING garantit qu'elle n'est vendue qu'une fois. */
  async sell(product: string, price: number, reason: string): Promise<boolean> {
    const pos = await this.env.DB.prepare("DELETE FROM positions WHERE product = ? RETURNING *")
      .bind(product).first<Position>();
    if (!pos) return false;
    let f;
    try {
      f = await this.broker.sell(product, pos.qty, price);
    } catch (e) {
      // L'ordre a échoué : on remet la position pour que le stop reste surveillé.
      await this.env.DB.prepare("INSERT OR IGNORE INTO positions VALUES (?,?,?,?,?,?)")
        .bind(pos.product, pos.qty, pos.entry_price, pos.stop, pos.highest_close, pos.entry_time).run();
      throw e;
    }
    const pnl = f.fill / pos.entry_price - 1;
    await this.env.DB.prepare("INSERT INTO trades (time, product, side, qty, price, usd, reason, pnl_pct, mode) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(nowIso(), product, "sell", f.qty, f.fill, f.usd, reason, pnl, this.mode).run();
    await this.say(`🔴 VENTE ${product} ${f.qty.toFixed(6)} @ ${fmt(f.fill)} (${reason}) | variation ${pct(pnl)}`);
    return true;
  }

  async buy(product: string, usd: number, price: number, stop: number, close: number): Promise<void> {
    if ((await this.positions()).some(p => p.product === product)) return;
    const f = await this.broker.buy(product, usd, price);
    await this.env.DB.batch([
      this.env.DB.prepare("INSERT OR REPLACE INTO positions VALUES (?,?,?,?,?,?)")
        .bind(product, f.qty, f.fill, stop, close, nowIso()),
      this.env.DB.prepare("INSERT INTO trades (time, product, side, qty, price, usd, reason, pnl_pct, mode) VALUES (?,?,?,?,?,?,?,NULL,?)")
        .bind(nowIso(), product, "buy", f.qty, f.fill, usd, "cassure", this.mode),
    ]);
    const tag = this.mode === "live" ? " [RÉEL]" : "";
    await this.say(`🟢 ACHAT${tag} ${product} ${f.qty.toFixed(6)} @ ${fmt(f.fill)} (${fmt(usd)} ${this.quote}) | stop ${fmt(stop)}`);
  }

  // --- cycle (appelé chaque minute par le déclencheur Cloudflare) -------------
  async step(): Promise<void> {
    if (this.missingKeys) {
      throw new Error("Mode réel demandé mais COINBASE_API_KEY / COINBASE_API_SECRET absents : aucun ordre n'est passé.");
    }
    let acc = await this.account();
    if ((acc.guard as any).mode !== this.mode) await this.switchMode(acc);
    acc = await this.account();
    const prices: Record<string, number> = {};
    for (const p of this.products) prices[p] = await lastPrice(p);
    const positions = await this.positions();
    const cash = await this.broker.cash();
    const equity = cash + positions.reduce((s, p) => s + p.qty * prices[p.product], 0);
    const guard = { ...updateGuard(acc.guard, equity, new Date()), mode: this.mode };
    await this.saveAccount({ prices, guard });

    const last = await this.env.DB.prepare("SELECT max(time) AS t FROM equity").first<{ t: string | null }>();
    if (!last?.t || Date.now() - Date.parse(last.t) >= EQUITY_SNAPSHOT_MS) {
      await this.env.DB.prepare("INSERT OR REPLACE INTO equity VALUES (?, ?, ?)").bind(nowIso(), equity, cash).run();
    }

    if (guard.halted) {
      if (!acc.guard.halted) await this.say(`🛑 Coupe-circuit : ${guard.haltReason}. Liquidation des positions.`, "error");
      for (const p of positions) await this.sell(p.product, prices[p.product], "coupe-circuit");
      await this.saveAccount({ last_step: nowIso() });
      return;
    }

    // Stops au prix courant
    for (const p of positions) {
      if (prices[p.product] <= p.stop) await this.sell(p.product, prices[p.product], "stop");
    }

    // Décisions à chaque nouvelle bougie clôturée
    const sec = CONFIG.granularitySeconds;
    const latestClosed = (Math.floor(Date.now() / 1000 / sec) - 1) * sec;
    const lastBar = { ...acc.last_bar };
    for (const product of this.products) {
      if ((lastBar[product] ?? 0) >= latestClosed) continue;
      const candles = await recentCandles(product, CONFIG.granularity, sec, 600);
      if (!candles.length || candles[candles.length - 1].time < latestClosed) continue;
      await this.onBar(product, candles, prices[product]);
      lastBar[product] = candles[candles.length - 1].time;
    }
    await this.saveAccount({ last_bar: lastBar, last_step: nowIso(), last_error: "" });
  }

  async onBar(product: string, candles: Parameters<typeof lastSignal>[0], price: number): Promise<void> {
    const s = lastSignal(candles);
    const pos = (await this.positions()).find(p => p.product === product);
    if (pos) {
      const highest = Math.max(pos.highest_close, s.close);
      const stop = trailStop(pos.stop, highest, s.atr);
      await this.env.DB.prepare("UPDATE positions SET highest_close = ?, stop = ? WHERE product = ?")
        .bind(highest, stop, product).run();
      if (s.regimeExit) await this.sell(product, price, "tendance");
      return;
    }
    if (!s.entry) return;
    const acc = await this.account();
    if (acc.paused) {
      await this.say(`Signal d'achat ${product} ignoré : bot en pause (/reprendre pour réactiver)`);
      return;
    }
    const positions = await this.positions();
    const exposure = positions.reduce((t, p) => t + p.qty * (acc.prices[p.product] ?? p.entry_price), 0);
    const cash = await this.broker.cash();
    const equity = cash + exposure;
    const [ok, why] = canOpen(acc.guard, equity);
    if (!ok) { await this.say(`Signal d'achat ${product} ignoré : ${why}`, "warning"); return; }
    const stop = initialStop(s.close, s.atr);
    const usd = positionSizeUsd(equity, cash, exposure, price, stop, this.limits);
    if (usd <= 0 && cash < this.limits.minOrderUsd) {
      await this.say(`Signal d'achat ${product} ignoré : solde ${this.quote} insuffisant (${fmt(cash)})`, "warning");
      return;
    }
    if (usd > 0) await this.buy(product, usd, price, stop, s.close);
  }

  // --- commandes ---------------------------------------------------------------
  async snapshot() {
    const acc = await this.account();
    const positions = (await this.positions()).map(p => {
      const price = acc.prices[p.product] ?? p.entry_price;
      return { ...p, price, value: p.qty * price, pnl_pct: price / p.entry_price - 1, stop_dist_pct: p.stop / price - 1 };
    });
    let cash = acc.cash;
    try { cash = await this.broker.cash(); } catch { /* affichage : on garde la dernière valeur */ }
    const equity = cash + positions.reduce((s, p) => s + p.value, 0);
    const g = acc.guard;
    return {
      mode: this.mode, products: this.products, granularity: CONFIG.granularity, quote: this.quote,
      max_order: this.maxOrder, missing_keys: this.missingKeys,
      paused: !!acc.paused, halted: !!g.halted, halt_reason: g.haltReason ?? "",
      equity, cash, initial_cash: CONFIG.initialCash, peak_equity: g.peakEquity ?? equity,
      drawdown: g.peakEquity ? Math.min(0, equity / g.peakEquity - 1) : 0,
      day_pnl: g.dayStartEquity ? equity / g.dayStartEquity - 1 : 0,
      positions, prices: acc.prices, last_step: acc.last_step, last_error: acc.last_error,
    };
  }

  async setPaused(paused: boolean): Promise<void> {
    await this.saveAccount({ paused: paused ? 1 : 0 });
    await this.say(paused ? "⏸️ Bot en pause : plus de nouveaux achats (les stops restent actifs)."
                          : "▶️ Bot réactivé : les nouveaux achats sont autorisés.");
  }

  async closePosition(product: string): Promise<boolean> {
    return this.sell(product, await lastPrice(product), "manuel");
  }

  async resetHalt(): Promise<void> {
    const s = await this.snapshot();
    const acc = await this.account();
    await this.saveAccount({ guard: { ...acc.guard, halted: false, haltReason: "", peakEquity: s.equity } });
    await this.say("🔓 Coupe-circuit réinitialisé manuellement.", "warning");
  }

  /** Vue marché : régime et indicateurs par actif, corrélations, synthèse. */
  async market() {
    const acc = await this.account();
    const all = await Promise.all(this.products.map(p => dailyCandles(p)));
    const assets = this.products.map((p, i) => analyzeAsset(p, all[i], acc.prices[p]));
    const corr: Record<string, number> = {};
    for (let i = 0; i < this.products.length; i++)
      for (let j = i + 1; j < this.products.length; j++)
        corr[`${this.products[i].split("-")[0]}/${this.products[j].split("-")[0]}`] = correlation(all[i], all[j]);
    const bull = assets.filter(a => a.regime === "haussier").length;
    const bear = assets.filter(a => a.regime === "baissier").length;
    const summary = assets.some(a => a.signal === "achat") ? "Signal d'achat actif."
      : bull ? `${bull} actif(s) en tendance haussière : le bot attend une cassure.`
      : bear === assets.length ? "Marché baissier sur tous les actifs : le bot reste à l'écart, c'est voulu."
      : "Pas de tendance nette : aucun avantage, le bot attend.";
    return { assets, correlations: corr, summary, updated: new Date().toISOString() };
  }

  /** Bougies + moyennes mobiles + trades du bot, pour le graphique. */
  async chart(product: string) {
    if (!this.products.includes(product)) throw new Error("Produit inconnu");
    const c = (await dailyCandles(product)).slice(-400);
    const all = await dailyCandles(product);
    const e = emaSeries(all);
    const off = all.length - c.length;
    const { results: trades } = await this.env.DB.prepare(
      "SELECT time, side, price, reason, pnl_pct FROM trades WHERE product = ? ORDER BY id").bind(product).all();
    const pos = (await this.positions()).find(p => p.product === product) ?? null;
    return {
      candles: c.map(b => [b.time, b.open, b.high, b.low, b.close, b.volume ?? 0]),
      emaFast: c.map((b, i) => [b.time, e.fast[off + i]]).filter(x => Number.isFinite(x[1])),
      emaSlow: c.map((b, i) => [b.time, e.slow[off + i]]).filter(x => Number.isFinite(x[1])),
      trades, position: pos,
    };
  }

  /** Risque réel du portefeuille : exposition, perte maximale si tous les stops sont touchés. */
  async riskReport() {
    const s = await this.snapshot();
    const { results } = await this.env.DB.prepare(
      "SELECT time, equity FROM (SELECT * FROM equity ORDER BY time DESC LIMIT 5000) ORDER BY time").all<{ time: string; equity: number }>();
    const exposure = s.positions.reduce((t, p) => t + p.value, 0);
    const atRisk = s.positions.reduce((t, p) => t + Math.max(0, p.qty * (p.price - p.stop)), 0);
    return {
      equity: s.equity, exposure, exposurePct: s.equity ? exposure / s.equity : 0,
      atRisk, atRiskPct: s.equity ? atRisk / s.equity : 0,
      limits: { ...this.limits, maxOrder: this.maxOrder },
      guard: { halted: s.halted, haltReason: s.halt_reason, drawdown: s.drawdown, dayPnl: s.day_pnl },
      live: riskMetrics(results),
    };
  }

  async signalReport() {
    const out = [];
    for (const product of this.products) {
      const s = lastSignal(await recentCandles(product, CONFIG.granularity, CONFIG.granularitySeconds, 600));
      out.push({ product, ...s, toBreakoutPct: s.channelHigh / s.close - 1 });
    }
    return out;
  }

  /** Passage simulation <-> réel : on repart d'un état propre pour ne pas mélanger les deux. */
  async switchMode(acc: Account): Promise<void> {
    const old = await this.positions();
    if (old.length) {
      await this.env.DB.prepare("DELETE FROM positions").run();
      await this.say(`Positions ${(acc.guard as any).mode ?? "simulées"} retirées du suivi : ${old.map(p => p.product).join(", ")}`, "warning");
    }
    // L'historique de capital de l'autre mode n'a pas de sens ici : on repart d'une courbe vierge.
    await this.env.DB.prepare("DELETE FROM equity").run();
    await this.saveAccount({ guard: { mode: this.mode }, last_bar: {} });
    await this.say(this.mode === "live"
      ? `💶 Mode ARGENT RÉEL activé sur Coinbase (${this.products.join(", ")}). Plafond : ${fmt(this.maxOrder)} ${this.quote} par ordre.`
      : "Mode SIMULATION activé.", "warning");
  }

  async recordError(e: unknown): Promise<void> {
    const msg = e instanceof Error ? e.message : String(e);
    const acc = await this.account();
    if (acc.last_error !== msg) await this.say(`⚠️ Erreur : ${msg}`, "error");
    await this.saveAccount({ last_error: msg });
  }
}
