import { test } from "node:test";
import assert from "node:assert/strict";
import { createSpring, presets } from "./spring.ts";

const overshoots = (s: { at(t: number): number }) => {
  for (let t = 0; t < 5; t += 0.005) if (s.at(t) < -1e-9) return true;
  return false;
};

test("starts at x0 and settles to 0", () => {
  const s = createSpring({ stiffness: 170, damping: 26, mass: 1 });
  assert.ok(Math.abs(s.at(0) - 1) < 1e-9);
  assert.ok(Math.abs(s.at(3)) < 1e-4);
});

test("underdamped overshoots, critical and overdamped never do", () => {
  assert.equal(overshoots(createSpring({ stiffness: 170, damping: 10, mass: 1 })), true);
  const crit = 2 * Math.sqrt(170);
  assert.equal(overshoots(createSpring({ stiffness: 170, damping: crit, mass: 1 })), false);
  assert.equal(overshoots(createSpring({ stiffness: 170, damping: 40, mass: 1 })), false);
});

test("value() interpolates from → to", () => {
  const s = createSpring(presets.snappy);
  assert.ok(Math.abs(s.value(100, 300, 0) - 100) < 1e-6);
  assert.ok(Math.abs(s.value(100, 300, 3) - 300) < 0.1);
});

test("settleTime is consistent with at()", () => {
  for (const config of Object.values(presets)) {
    const s = createSpring(config);
    const ts = s.settleTime(0.001);
    assert.ok(ts > 0 && ts < 5, `settle in (0,5)s, got ${ts}`);
    assert.ok(Math.abs(s.at(ts + 0.05)) < 0.002);
  }
});

test("initial velocity is respected (drag release)", () => {
  const still = createSpring(presets.snappy, 1, 0);
  const thrown = createSpring(presets.snappy, 1, 20);
  assert.ok(thrown.at(0.05) > still.at(0.05));
});
