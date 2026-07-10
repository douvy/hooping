import { test } from "node:test";
import assert from "node:assert/strict";
import { countAt, deathBeats } from "./choreo.ts";

test("deathBeats: strictly ordered, one fill per make", () => {
  const b = deathBeats(3, true);
  assert.equal(b.fills.length, 3);
  const order = [
    b.stamp,
    b.frame,
    ...b.fills,
    b.strike,
    b.stakes,
    b.cta,
    b.career,
    b.footer,
    b.end,
  ];
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i] > order[i - 1], `beat ${i} out of order`);
  }
});

test("deathBeats: the funeral scales with run depth", () => {
  const shallow = deathBeats(0, false);
  const deep = deathBeats(6, false);
  assert.equal(shallow.fills.length, 0);
  // six extra makes = six extra 120ms steps, everywhere downstream
  assert.ok(Math.abs(deep.strike - shallow.strike - 0.72) < 1e-9);
  assert.ok(Math.abs(deep.end - shallow.end - 0.72) < 1e-9);
});

test("deathBeats: no stakes line means no stakes pause", () => {
  assert.equal(deathBeats(2, false).cta, deathBeats(2, false).stakes);
  assert.ok(deathBeats(2, true).cta > deathBeats(2, true).stakes);
});

test("deathBeats: median death lands the stakes ~1.2s after the stamp", () => {
  const b = deathBeats(1, true);
  assert.ok(b.stakes - b.stamp > 1.0 && b.stakes - b.stamp < 1.5);
});

test("countAt: steps from t0, clamps both ends, Infinity reads `to`", () => {
  assert.equal(countAt(0, 5, 8, 1, 0.1), 5); // before t0
  assert.equal(countAt(1, 5, 8, 1, 0.1), 6); // first step at t0
  assert.equal(countAt(1.15, 5, 8, 1, 0.1), 7);
  assert.equal(countAt(9, 5, 8, 1, 0.1), 8); // clamped at to
  assert.equal(countAt(Infinity, 5, 8, 1, 0.1), 8);
  assert.equal(countAt(50, 5, 5, 1, 0.1), 5); // nothing to count
});
