import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeMiss,
  isBucketMilestone,
  localDay,
  nextBucketMilestone,
  parseRun,
  showGestureHint,
} from "./run.ts";

const DAY = "2026-7-10";

test("parseRun: fresh player on empty or garbage", () => {
  const fresh = {
    run: 1,
    bestDepth: 0,
    buckets: 0,
    wins: 0,
    closest: [],
    todayDepth: 0,
    todayDate: DAY,
  };
  assert.deepEqual(parseRun(null, DAY), fresh);
  assert.deepEqual(parseRun("not json", DAY), fresh);
  assert.deepEqual(parseRun('{"run":0}', DAY), fresh);
});

test("parseRun: backfills pre-buckets payloads with a bounded estimate", () => {
  // what hoop-run-v1 looked like before career buckets existed:
  // 135 finished games at ~1.5 makes per game
  assert.deepEqual(parseRun('{"run":136,"bestDepth":4}', DAY), {
    run: 136,
    bestDepth: 4,
    buckets: 203,
    wins: 0,
    closest: [],
    todayDepth: 0,
    todayDate: DAY,
  });
  // never cleared anything → provably zero career makes
  assert.equal(parseRun('{"run":10,"bestDepth":0}', DAY).buckets, 0);
  // best 1 caps the deposit at one per game — estimate can't exceed it
  assert.equal(parseRun('{"run":21,"bestDepth":1}', DAY).buckets, 20);
  // fresh payload, nothing to backfill
  assert.equal(parseRun('{"run":1,"bestDepth":0}', DAY).buckets, 0);
});

test("parseRun: backfills pre-wins payloads — bestDepth 6 proves a clear", () => {
  assert.equal(parseRun('{"run":40,"bestDepth":6,"buckets":90}', DAY).wins, 1);
  assert.equal(parseRun('{"run":40,"bestDepth":5,"buckets":90}', DAY).wins, 0);
});

test("parseRun: round-trips a current payload", () => {
  const s = {
    run: 12,
    bestDepth: 6,
    buckets: 214,
    wins: 3,
    // level 2 never missed; level 4's record miss was 9cm out
    closest: [0.31, null, 0.02, 0.09, null, null],
    todayDepth: 3,
    todayDate: DAY,
  };
  assert.deepEqual(parseRun(JSON.stringify(s), DAY), s);
});

test("parseRun: today's best survives the day and resets overnight", () => {
  const stored = JSON.stringify({
    run: 12,
    bestDepth: 4,
    buckets: 50,
    wins: 0,
    closest: [],
    todayDepth: 3,
    todayDate: DAY,
  });
  // same day — the morning's depth is still on the board
  assert.equal(parseRun(stored, DAY).todayDepth, 3);
  // next day — fresh chase, the date rolls forward
  const next = parseRun(stored, "2026-7-11");
  assert.equal(next.todayDepth, 0);
  assert.equal(next.todayDate, "2026-7-11");
  // pre-today payloads have no daily record
  assert.equal(parseRun('{"run":5,"bestDepth":2,"buckets":3}', DAY).todayDepth, 0);
});

test("localDay: local calendar date, no zero-padding", () => {
  assert.equal(localDay(new Date(2026, 6, 10)), "2026-7-10");
  assert.equal(localDay(new Date(2026, 0, 3)), "2026-1-3");
});

test("parseRun: closest survives sparse holes and rejects garbage entries", () => {
  // JSON.stringify turns array holes into null — both must parse
  assert.deepEqual(
    parseRun('{"run":3,"bestDepth":2,"buckets":4,"wins":0,"closest":[null,0.1]}', DAY)
      .closest,
    [null, 0.1],
  );
  assert.deepEqual(
    parseRun('{"run":3,"bestDepth":2,"buckets":4,"wins":0,"closest":["x",0.1]}', DAY)
      .closest,
    [null, 0.1],
  );
  assert.deepEqual(
    parseRun('{"run":3,"bestDepth":2,"buckets":4,"wins":0,"closest":"junk"}', DAY)
      .closest,
    [],
  );
});

test("describeMiss: named in ball-widths, silent past three balls", () => {
  const D = 0.22; // ball diameter
  assert.equal(describeMiss(0, "short"), "off by a hair");
  assert.equal(describeMiss(0.05 * D, "long"), "off by a hair");
  assert.equal(describeMiss(0.3 * D, "short"), "short by half a ball");
  assert.equal(describeMiss(1.1 * D, "long"), "long by one ball");
  assert.equal(describeMiss(1.5 * D, "short"), "short by a ball and a half");
  assert.equal(describeMiss(2.9 * D, "long"), "long by three balls");
  assert.equal(describeMiss(3.5 * D, "short"), null); // the silent brick
  assert.equal(describeMiss(Infinity, "short"), null); // never got airborne near it
});

test("showGestureHint: first-timers always on L1, veterans once per session", () => {
  // first-timer keeps the hint on level 1 even after missed shots
  assert.equal(showGestureHint(0, false, 0), true);
  assert.equal(showGestureHint(0, true, 0), true);
  // veteran's fresh session: re-taught until the first shot, then gone
  assert.equal(showGestureHint(4, false, 0), true);
  assert.equal(showGestureHint(4, true, 0), false);
  // never shows past level 1
  assert.equal(showGestureHint(0, false, 2), false);
  assert.equal(showGestureHint(4, false, 3), false);
});

test("isBucketMilestone: dense early rungs, spacing out with the career", () => {
  for (const n of [10, 25, 50, 100, 150, 200, 250, 450, 500, 750, 1000, 2000, 5000]) {
    assert.equal(isBucketMilestone(n), true, `${n}`);
  }
  for (const n of [0, 1, 9, 11, 26, 49, 51, 525, 999, 1001, 1500]) {
    assert.equal(isBucketMilestone(n), false, `${n}`);
  }
});

test("nextBucketMilestone: always the next rung strictly above", () => {
  assert.equal(nextBucketMilestone(0), 10);
  assert.equal(nextBucketMilestone(10), 25);
  assert.equal(nextBucketMilestone(24), 25);
  assert.equal(nextBucketMilestone(25), 50);
  assert.equal(nextBucketMilestone(50), 100);
  assert.equal(nextBucketMilestone(149), 150);
  assert.equal(nextBucketMilestone(500), 750);
  assert.equal(nextBucketMilestone(800), 1000);
  assert.equal(nextBucketMilestone(1000), 2000);
  assert.equal(nextBucketMilestone(2600), 3000);
  // every next rung is itself a milestone
  for (let n = 0; n <= 3000; n += 7) {
    assert.equal(isBucketMilestone(nextBucketMilestone(n)), true, `${n}`);
  }
});
