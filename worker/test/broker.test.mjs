// LiveBroker contre un faux Coinbase : vérifie les ordres envoyés et la lecture des exécutions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { buildSync } from "esbuild";

const code = buildSync({ entryPoints: ["src/broker.ts"], bundle: true, format: "esm", write: false }).outputFiles[0].text;
const { LiveBroker } = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));

const kp = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign"]);
const secret = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", kp.privateKey)).subarray(16).toString("base64");
const env = { COINBASE_API_KEY: "test-key", COINBASE_API_SECRET: secret };

function fakeCoinbase({ balances, fill, reject }) {
  const orders = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const json = obj => new Response(JSON.stringify(obj), { status: 200 });
    if (u.pathname.startsWith("/api/v3/brokerage/market/products/")) return json({ base_increment: "0.00000001" });
    assert.match(init.headers?.Authorization ?? "", /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/, "requête privée sans JWT");
    if (u.pathname === "/api/v3/brokerage/accounts")
      return json({ accounts: Object.entries(balances).map(([currency, v]) => ({ currency, available_balance: { value: String(v) } })), has_next: false });
    if (u.pathname === "/api/v3/brokerage/orders" && init.method === "POST") {
      const body = JSON.parse(init.body);
      orders.push(body);
      if (reject) return json({ success: false, error_response: { message: "INSUFFICIENT_FUND" } });
      return json({ success: true, success_response: { order_id: "o1" } });
    }
    if (u.pathname === "/api/v3/brokerage/orders/historical/o1") return json({ order: { status: "FILLED", ...fill } });
    throw new Error("URL inattendue " + url);
  };
  return orders;
}

test("achat au marché : montant en devise, exécution relue", async () => {
  const orders = fakeCoinbase({ balances: { EUR: 120 }, fill: { filled_size: "0.0008", average_filled_price: "61000", filled_value: "48.8" } });
  const b = new LiveBroker(env, "EUR");
  assert.equal(await b.cash(), 120);
  const f = await b.buy("BTC-EUR", 50, 61000);
  assert.deepEqual(orders[0].order_configuration, { market_market_ioc: { quote_size: "50.00" } });
  assert.equal(orders[0].side, "BUY");
  assert.equal(f.qty, 0.0008);
  assert.equal(f.fill, 61000);
});

test("vente : jamais plus que le solde réel, arrondie à l'incrément", async () => {
  const orders = fakeCoinbase({ balances: { BTC: 0.000799999 }, fill: { filled_size: "0.000799999", average_filled_price: "62000", filled_value: "49.6" } });
  await new LiveBroker(env, "EUR").sell("BTC-EUR", 0.0008123456789, 62000);
  assert.equal(orders[0].order_configuration.market_market_ioc.base_size, "0.00079999");
  assert.equal(orders[0].side, "SELL");
});

test("ordre refusé par Coinbase : erreur claire", async () => {
  fakeCoinbase({ balances: { EUR: 5 }, fill: {}, reject: true });
  await assert.rejects(new LiveBroker(env, "EUR").buy("BTC-EUR", 50, 61000), /INSUFFICIENT_FUND/);
});
