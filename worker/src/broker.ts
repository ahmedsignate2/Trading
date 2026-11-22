// Exécution des ordres : PaperBroker (argent fictif, dans D1) ou LiveBroker (Coinbase réel).
import type { Env } from "./bot";
import { buildJwt } from "./coinbaseAuth";
import { CONFIG } from "./strategy";

export interface Fill { qty: number; fill: number; usd: number }

export interface Broker {
  mode: "paper" | "live";
  cash(): Promise<number>;
  buy(product: string, usd: number, price: number): Promise<Fill>;
  sell(product: string, qty: number, price: number): Promise<Fill>;
}

export class PaperBroker implements Broker {
  mode = "paper" as const;
  constructor(private db: D1Database) {}

  async cash(): Promise<number> {
    const r = await this.db.prepare("SELECT cash FROM account WHERE id = 1").first<{ cash: number }>();
    return r?.cash ?? 0;
  }

  async buy(_product: string, usd: number, price: number): Promise<Fill> {
    const fill = price * (1 + CONFIG.costs.slippage);
    await this.db.prepare("UPDATE account SET cash = cash - ? WHERE id = 1").bind(usd).run();
    return { qty: usd * (1 - CONFIG.costs.fee) / fill, fill, usd };
  }

  async sell(_product: string, qty: number, price: number): Promise<Fill> {
    const fill = price * (1 - CONFIG.costs.slippage);
    const usd = qty * fill * (1 - CONFIG.costs.fee);
    await this.db.prepare("UPDATE account SET cash = cash + ? WHERE id = 1").bind(usd).run();
    return { qty, fill, usd };
  }
}

const API = "https://api.coinbase.com";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class LiveBroker implements Broker {
  mode = "live" as const;
  constructor(private env: Env, private quote: string) {}

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    const jwt = await buildJwt(this.env.COINBASE_API_KEY!, this.env.COINBASE_API_SECRET!, method, path.split("?")[0]);
    const r = await fetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Coinbase ${r.status} ${method} ${path.split("?")[0]} : ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  }

  async balances(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    let cursor = "";
    for (let page = 0; page < 10; page++) {
      const d = await this.call("GET", `/api/v3/brokerage/accounts?limit=250${cursor ? `&cursor=${cursor}` : ""}`);
      for (const a of d.accounts ?? []) {
        out[a.currency] = (out[a.currency] ?? 0) + parseFloat(a.available_balance?.value ?? "0");
      }
      if (!d.has_next) break;
      cursor = d.cursor;
    }
    return out;
  }

  async cash(): Promise<number> {
    return (await this.balances())[this.quote] ?? 0;
  }

  private async waitFill(orderId: string): Promise<{ qty: number; fill: number; usd: number }> {
    let o: any = {};
    for (let i = 0; i < 8; i++) {
      o = (await this.call("GET", `/api/v3/brokerage/orders/historical/${orderId}`)).order ?? {};
      if (["FILLED", "CANCELLED", "EXPIRED", "FAILED"].includes(o.status)) break;
      await sleep(750);
    }
    const qty = parseFloat(o.filled_size ?? "0");
    if (!(qty > 0)) throw new Error(`Ordre ${orderId} non exécuté (statut ${o.status ?? "inconnu"})`);
    return { qty, fill: parseFloat(o.average_filled_price), usd: parseFloat(o.filled_value ?? "0") };
  }

  private async order(product: string, side: "BUY" | "SELL", config: object): Promise<Fill> {
    const d = await this.call("POST", "/api/v3/brokerage/orders", {
      client_order_id: crypto.randomUUID(), product_id: product, side,
      order_configuration: { market_market_ioc: config },
    });
    if (!d.success) {
      const e = d.error_response ?? {};
      throw new Error(`Ordre ${side} ${product} refusé : ${e.message ?? e.error ?? JSON.stringify(d).slice(0, 200)}`);
    }
    return this.waitFill(d.success_response.order_id);
  }

  async buy(product: string, usd: number): Promise<Fill> {
    return this.order(product, "BUY", { quote_size: usd.toFixed(2) });
  }

  async sell(product: string, qty: number): Promise<Fill> {
    // On ne vend jamais plus que ce qui est réellement disponible sur le compte.
    const base = product.split("-")[0];
    const available = (await this.balances())[base] ?? 0;
    const p = await (await fetch(`${API}/api/v3/brokerage/market/products/${product}`)).json<any>();
    const inc = parseFloat(p.base_increment);
    const decimals = Math.max(0, Math.round(-Math.log10(inc)));
    const size = Math.floor(Math.min(qty, available) / inc) * inc;
    if (size <= 0) throw new Error(`Rien à vendre sur ${product} (disponible : ${available})`);
    return this.order(product, "SELL", { base_size: size.toFixed(decimals) });
  }
}
