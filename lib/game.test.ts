import { test } from "node:test";
import assert from "node:assert/strict";
import { dailySeed, makeLake, simulate } from "./physics.ts";
import { score, beats, safeDefault, computePar } from "./game.ts";

const lake = makeLake(dailySeed("2026-07-08"));

test("plunks score zero — you can't cannon it", () => {
  const plunk = simulate(lake, 18, 40);
  assert.equal(plunk.plunk, true);
  assert.equal(score(plunk), 0);
  const ok = simulate(lake, 14, 4);
  assert.ok(score(ok) > 0);
  assert.ok(beats(ok, plunk));
});

test("safe default skips ≥3 on every lake for a year", () => {
  // The first-throw guarantee: 10,000 strangers get five seconds each.
  for (let day = 0; day < 365; day++) {
    const d = new Date(Date.UTC(2026, 6, 8 + day)).toISOString().slice(0, 10);
    const dayLake = makeLake(dailySeed(d));
    const { p, a } = safeDefault(dayLake);
    const r = simulate(dayLake, p, a);
    assert.ok(r.skips >= 3, `${d}: default aim got ${r.skips} skips`);
  }
});

test("par is deterministic and strong", () => {
  const a = computePar(lake);
  const b = computePar(lake);
  assert.deepEqual(a, b);
  assert.ok(!a.plunk);
  // strong: better than a plain good throw
  assert.ok(score(a) > score(simulate(lake, 16, 4)));
});
