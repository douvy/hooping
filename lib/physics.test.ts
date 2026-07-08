import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dailySeed,
  dayNumber,
  makeLake,
  mulberry32,
  simulate,
  shareString,
  MAX_POWER,
} from "./physics.ts";

const lake = makeLake(dailySeed("2026-07-08"));

test("same throw is deterministic", () => {
  const a = simulate(lake, 16, 4);
  const b = simulate(lake, 16, 4);
  assert.deepEqual(a, b);
});

test("steep throws plunk", () => {
  const r = simulate(lake, 18, 40);
  assert.equal(r.skips, 0);
  assert.equal(r.plunk, true);
});

test("flat fast throws skip", () => {
  const r = simulate(lake, 18, 2);
  assert.ok(r.skips >= 4, `expected a good run, got ${r.skips}`);
  assert.ok(r.skips <= 12, `expected a capped run, got ${r.skips}`);
});

test("different days give different lakes", () => {
  const seeds = ["2026-07-08", "2026-07-09", "2026-07-10"].map(dailySeed);
  assert.equal(new Set(seeds).size, 3);
  // and the lake surfaces actually differ
  const heights = seeds.map((s) => makeLake(s).height(5).toFixed(6));
  assert.equal(new Set(heights).size, 3);
});

test("score distribution is game-shaped", () => {
  // 500 human-ish throws: plunks common but not dominant, scores spread,
  // nothing runs away. This is the sim.mjs verification, now enforced.
  const rand = mulberry32(42);
  let plunks = 0;
  let max = 0;
  const mid = { count: 0 }; // scores 3-7 — the middle must exist
  for (let i = 0; i < 500; i++) {
    const r = simulate(lake, 8 + rand() * (MAX_POWER - 8), -2 + rand() * 24);
    if (r.plunk) plunks++;
    if (r.skips > max) max = r.skips;
    if (r.skips >= 3 && r.skips <= 7) mid.count++;
  }
  assert.ok(plunks / 500 > 0.1 && plunks / 500 < 0.5, `plunk rate ${plunks / 500}`);
  assert.ok(max <= 12, `max ${max}`);
  assert.ok(mid.count / 500 > 0.3, `middle scores ${mid.count / 500}`);
});

test("day numbering starts at 1 on launch day", () => {
  assert.equal(dayNumber("2026-07-08"), 1);
  assert.equal(dayNumber("2026-07-09"), 2);
});

test("share string carries day, trail, and score", () => {
  const r = simulate(lake, 18, 2);
  const s = shareString(dayNumber("2026-07-08"), r, 23);
  const lines = s.split("\n");
  assert.equal(lines[0], "SKIP #1");
  assert.ok(lines[1].startsWith("🪨"));
  assert.ok(lines[1].endsWith("⚓"));
  assert.equal(lines[2], `${r.distance.toFixed(1)}m · ${r.skips} skips · throw 23`);
});

test("share string marks beating par", () => {
  const r = simulate(lake, 18, 2);
  assert.ok(shareString(1, r, 1, r.distance - 1).endsWith(" · beat par"));
  assert.ok(!shareString(1, r, 1, r.distance + 1).includes("beat par"));
});

test("plunk share string", () => {
  const r = simulate(lake, 18, 40);
  assert.match(shareString(3, r, 4), /SKIP #3\n🪨⚓ plunk\n0m · throw 4/);
});
