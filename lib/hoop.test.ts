import { test } from "node:test";
import assert from "node:assert";
import {
  LEVELS,
  MIN_POWER,
  MAX_POWER,
  simulateShot,
  type Level,
} from "./hoop.ts";

function sweep(level: Level) {
  const out = [];
  for (let a = 20; a <= 80; a += 2) {
    for (let p = MIN_POWER; p <= MAX_POWER + 1e-9; p += 0.25) {
      out.push(simulateShot(level, p, a));
    }
  }
  return out;
}

test("deterministic: same shot, same result — never dice", () => {
  const a = simulateShot(LEVELS[1], 9.3, 67);
  const b = simulateShot(LEVELS[1], 9.3, 67);
  assert.deepStrictEqual(a, b);
});

test("the ladder is six levels, ids in order", () => {
  assert.strictEqual(LEVELS.length, 6);
  LEVELS.forEach((l, i) => assert.strictEqual(l.id, i + 1));
});

test("every level is solvable — makes exist in the sweep", () => {
  for (const lv of LEVELS) {
    const makes = sweep(lv).filter((r) => r.made);
    assert.ok(makes.length >= 5, `level ${lv.id} (${lv.name}): only ${makes.length} makes`);
  }
});

test("every level is hard but findable — make region bounded", () => {
  for (const lv of LEVELS) {
    const all = sweep(lv);
    const rate = all.filter((r) => r.made).length / all.length;
    const cap = lv.id === 1 ? 0.15 : 0.08; // the layup is the handshake
    assert.ok(rate < cap, `level ${lv.id}: ${(rate * 100).toFixed(1)}% too generous`);
    assert.ok(rate > 0.003, `level ${lv.id}: ${(rate * 100).toFixed(1)}% unfindable`);
  }
});

test("no level's answer sits on the power cap — full-power isn't the meta", () => {
  for (const lv of LEVELS) {
    const found = sweep(lv).some((r) => r.made);
    assert.ok(found);
    let below = false;
    for (let a = 20; a <= 80 && !below; a += 1) {
      for (let p = MIN_POWER; p <= MAX_POWER - 1 && !below; p += 0.25) {
        if (simulateShot(lv, p, a).made) below = true;
      }
    }
    assert.ok(below, `level ${lv.id}: only makeable near max power`);
  }
});

test("the agony zone exists — rim touches that still miss", () => {
  const rimOuts = sweep(LEVELS[1]).filter(
    (r) => !r.made && r.touches.some((t) => t.kind === "rim"),
  );
  assert.ok(rimOuts.length > 50, `only ${rimOuts.length} rim-outs`);
});

test("bank shots work — makes off the glass", () => {
  const banks = sweep(LEVELS[1]).filter(
    (r) => r.made && r.touches.some((t) => t.kind === "board" && t.t < r.madeAt),
  );
  assert.ok(banks.length > 0, "no bank makes — the glass is dead");
});

test("every shot on every level terminates", () => {
  for (const lv of LEVELS) {
    for (const r of sweep(lv)) assert.ok(r.t < 12, `level ${lv.id}: shot ran ${r.t}s`);
  }
});

test("a ball landing on a ledge dies fast — no 12s waits", () => {
  // lob onto a horizontal ledge: the bounces decay, and the slow last
  // touch must kill the shot instead of letting it rest until the clock
  const ledged: Level = {
    ...LEVELS[0],
    walls: [{ x1: 2, y1: 2, x2: 4, y2: 2 }],
  };
  const r = simulateShot(ledged, 5.5, 70);
  assert.ok(r.touches.some((t) => t.kind === "wall"), "never touched the ledge");
  assert.ok(!r.made);
  assert.ok(r.t < 3, `dead ball took ${r.t.toFixed(2)}s`);
});

test("walls reflect the ball — a solid wall can't be shot through", () => {
  const walled: Level = {
    ...LEVELS[0],
    walls: [{ x1: 3, y1: 0, x2: 3, y2: 5 }],
  };
  const r = simulateShot(walled, 10, 20);
  assert.ok(
    r.touches.some((t) => t.kind === "wall"),
    "never touched the wall",
  );
  assert.ok(!r.made, "made it through a solid wall");
});
