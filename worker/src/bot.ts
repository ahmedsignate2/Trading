// Cœur du bot : état dans D1, exécution simulée (paper), stops, signaux journaliers.
import { lastPrice, recentCandles } from "./coinbase";
import {
  CONFIG, Guard, canOpen, initialStop, lastSignal, positionSizeUsd, trailStop, updateGuard,
} from "./strategy";
import SCHEMA from "../schema.sql";

export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  DASHBOARD_PASSWORD?: string;
  PUBLIC_URL?: string;
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
  constructor(public env: Env, public notify: (msg: string) => Promise<void> = async () => {}) {}

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

  // --- ordres simulés ----------------------------------------------------------
  /** Vend une position. Le DELETE ... RETURNING garantit qu'elle n'est vendue qu'une fois. */
  async sell(product: string, price: number, reason: string): Promise<boolean> {
    const pos = await this.env.DB.prepare("DELETE FROM positions WHERE product = ? RETURNING *")
      .bind(product).first<Position>();
    if (!pos) return false;
    const fill = price * (1 - CONFIG.costs.slippage);
    const proceeds = pos.qty * fill * (1 - CONFIG.costs.fee);
    const pnl = fill / pos.entry_price - 1;
    await this.env.DB.batch([
      this.env.DB.prepare("UPDATE account SET cash = cash + ? WHERE id = 1").bind(proceeds),
      this.env.DB.prepare("INSERT INTO trades (time, product, side, qty, price, usd, reason, pnl_pct, mode) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(nowIso(), product, "sell", pos.qty, fill, pos.qty * fill, reason, pnl, CONFIG.mode),
    ]);
    await this.say(`🔴 VENTE ${product} ${pos.qty.toFixed(6)} @ ${fmt(fill)} (${reason}) | variation ${pct(pnl)}`);
    return true;
  }

  async buy(product: string, usd: number, price: number, stop: number, close: number): Promise<void> {
    const fill = price * (1 + CONFIG.costs.slippage);
    const qty = usd * (1 - CONFIG.costs.fee) / fill;
    // INSERT OR IGNORE : une seule position par crypto, même si deux cycles se chevauchent.
    const ins = await this.env.DB.prepare("INSERT OR IGNORE INTO positions VALUES (?,?,?,?,?,?)")
      .bind(product, qty, fill, stop, close, nowIso()).run();
    if (ins.meta.changes !== 1) return;
    await this.env.DB.batch([
      this.env.DB.prepare("UPDATE account SET cash = cash - ? WHERE id = 1").bind(usd),
      this.env.DB.prepare("INSERT INTO trades (time, product, side, qty, price, usd, reason, pnl_pct, mode) VALUES (?,?,?,?,?,?,?,NULL,?)")
        .bind(nowIso(), product, "buy", qty, fill, usd, "cassure", CONFIG.mode),
    ]);
    await this.say(`🟢 ACHAT ${product} ${qty.toFixed(6)} @ ${fmt(fill)} (${fmt(usd)} $) | stop ${fmt(stop)}`);
  }

  // --- cycle (appelé chaque minute par le déclencheur Cloudflare) -------------
  async step(): Promise<void> {
    const acc = await this.account();
    const prices: Record<string, number> = {};
    for (const p of CONFIG.products) prices[p] = await lastPrice(p);
    let positions = await this.positions();
    const equity = acc.cash + positions.reduce((s, p) => s + p.qty * prices[p.product], 0);
    const guard = updateGuard(acc.guard, equity, new Date());
    await this.saveAccount({ prices, guard });

    const last = await this.env.DB.prepare("SELECT max(time) AS t FROM equity").first<{ t: string | null }>();
    if (!last?.t || Date.now() - Date.parse(last.t) >= EQUITY_SNAPSHOT_MS) {
      await this.env.DB.prepare("INSERT OR REPLACE INTO equity VALUES (?, ?, ?)").bind(nowIso(), equity, acc.cash).run();
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
    for (const product of CONFIG.products) {
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
    const equity = acc.cash + exposure;
    const [ok, why] = canOpen(acc.guard, equity);
    if (!ok) { await this.say(`Signal d'achat ${product} ignoré : ${why}`, "warning"); return; }
    const stop = initialStop(s.close, s.atr);
    const usd = positionSizeUsd(equity, acc.cash, exposure, price, stop);
    if (usd > 0) await this.buy(product, usd, price, stop, s.close);
  }

  // --- commandes ---------------------------------------------------------------
  async snapshot() {
    const acc = await this.account();
    const positions = (await this.positions()).map(p => {
      const price = acc.prices[p.product] ?? p.entry_price;
      return { ...p, price, value: p.qty * price, pnl_pct: price / p.entry_price - 1, stop_dist_pct: p.stop / price - 1 };
    });
    const equity = acc.cash + positions.reduce((s, p) => s + p.value, 0);
    const g = acc.guard;
    return {
      mode: CONFIG.mode, products: CONFIG.products, granularity: CONFIG.granularity,
      paused: !!acc.paused, halted: !!g.halted, halt_reason: g.haltReason ?? "",
      equity, cash: acc.cash, initial_cash: CONFIG.initialCash, peak_equity: g.peakEquity ?? equity,
      drawdown: g.peakEquity ? equity / g.peakEquity - 1 : 0,
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

  async signalReport() {
    const out = [];
    for (const product of CONFIG.products) {
      const s = lastSignal(await recentCandles(product, CONFIG.granularity, CONFIG.granularitySeconds, 600));
      out.push({ product, ...s, toBreakoutPct: s.channelHigh / s.close - 1 });
    }
    return out;
  }

  async recordError(e: unknown): Promise<void> {
    const msg = e instanceof Error ? e.message : String(e);
    const acc = await this.account();
    if (acc.last_error !== msg) await this.say(`⚠️ Erreur : ${msg}`, "error");
    await this.saveAccount({ last_error: msg });
  }
}
