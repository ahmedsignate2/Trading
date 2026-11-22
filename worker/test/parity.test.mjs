// Vérifie que les signaux TypeScript sont identiques à ceux de Python (bot/strategy.py).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSync } from "esbuild";

const code = buildSync({ entryPoints: ["src/strategy.ts"], bundle: true, format: "esm", write: false }).outputFiles[0].text;
const { lastSignal, positionSizeUsd, updateGuard, canOpen } =
  await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
const fixture = JSON.parse(readFileSync(new URL("./fixture.json", import.meta.url)));

const close = (a, b) => (a === null ? Number.isNaN(b) : Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a)));

for (const [product, cases] of Object.entries(fixture)) {
  test(`parité Python/TypeScript ${product}`, () => {
    let entries = 0;
    for (const { candles, expected } of cases) {
      const s = lastSignal(candles.map(([time, open, high, low, close]) => ({ time, open, high, low, close })));
      assert.ok(close(expected.ema_fast, s.emaFast), `ema_fast ${expected.ema_fast} vs ${s.emaFast}`);
      assert.ok(close(expected.ema_slow, s.emaSlow), `ema_slow ${expected.ema_slow} vs ${s.emaSlow}`);
      assert.ok(close(expected.atr, s.atr), `atr ${expected.atr} vs ${s.atr}`);
      assert.ok(close(expected.channel_high, s.channelHigh), "channel_high");
      assert.equal(s.entry, expected.entry);
      assert.equal(s.regimeExit, expected.regime_exit);
      entries += s.entry;
    }
  });
}

test("taille de position et coupe-circuits identiques à Python", () => {
  assert.ok(Math.abs(positionSizeUsd(10000, 10000, 0, 100, 90) - 500) < 1e-9); // plafond 500 $ par ordre
  assert.equal(positionSizeUsd(10000, 10000, 0, 100, 101), 0);
  let g = updateGuard({}, 10000, new Date("2024-01-01T10:00:00Z"));
  assert.equal(canOpen(g, 9600)[0], false);
  g = updateGuard(g, 7900, new Date("2024-01-03T10:00:00Z"));
  assert.equal(g.halted, true);
});
