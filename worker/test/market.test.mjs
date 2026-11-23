// Indicateurs de marché comparés à la bibliothèque Python « ta » sur l'historique réel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSync } from "esbuild";

const code = buildSync({ entryPoints: ["src/market.ts"], bundle: true, format: "esm", write: false }).outputFiles[0].text;
const M = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
const fx = JSON.parse(readFileSync(new URL("./market_fixture.json", import.meta.url)));
const toC = rows => rows.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }));

for (const f of fx) {
  test(`RSI et ADX ${f.product} identiques à la bibliothèque ta`, () => {
    const c = toC(f.candles);
    assert.ok(Math.abs(M.rsi(c.map(x => x.close)) - f.rsi) < 0.5, `RSI ${M.rsi(c.map(x => x.close))} vs ${f.rsi}`);
    assert.ok(Math.abs(M.adx(c) - f.adx) < 1.0, `ADX ${M.adx(c)} vs ${f.adx}`);
  });
}

test("régimes, corrélation et métriques de risque", () => {
  assert.equal(M.regimeOf(110, 105, 100, 30), "haussier");
  assert.equal(M.regimeOf(90, 95, 100, 30), "baissier");
  assert.equal(M.regimeOf(110, 105, 100, 15), "range");
  const [btc, eth] = fx.map(f => toC(f.candles));
  const r = M.correlation(btc, eth);
  assert.ok(r > 0.5 && r <= 1, `corrélation BTC/ETH ${r}`);
  assert.ok(Math.abs(M.correlation(btc, btc) - 1) < 1e-9);
  const v = M.analyzeAsset("BTC-USD", btc);
  assert.ok(["achat", "attente", "aucun"].includes(v.signal) && v.atrPct > 0 && v.volumeRatio > 0);
  const risk = M.riskMetrics([{ time: "2026-01-01T00:00", equity: 100 }, { time: "2026-01-02T00:00", equity: 110 }, { time: "2026-01-03T00:00", equity: 99 }]);
  assert.ok(Math.abs(risk.totalReturn + 0.01) < 1e-9 && Math.abs(risk.maxDrawdown + 0.1) < 1e-9);
});
