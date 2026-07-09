import { test } from "node:test";
import assert from "node:assert/strict";
import { isBucketMilestone, parseRun } from "./run.ts";

test("parseRun: fresh player on empty or garbage", () => {
  assert.deepEqual(parseRun(null), { run: 1, bestDepth: 0, buckets: 0 });
  assert.deepEqual(parseRun("not json"), { run: 1, bestDepth: 0, buckets: 0 });
  assert.deepEqual(parseRun('{"run":0}'), { run: 1, bestDepth: 0, buckets: 0 });
});

test("parseRun: backfills pre-buckets payloads with a bounded estimate", () => {
  // what hoop-run-v1 looked like before career buckets existed:
  // 135 finished games at ~1.5 makes per game
  assert.deepEqual(parseRun('{"run":136,"bestDepth":4}'), {
    run: 136,
    bestDepth: 4,
    buckets: 203,
  });
  // never cleared anything → provably zero career makes
  assert.equal(parseRun('{"run":10,"bestDepth":0}').buckets, 0);
  // best 1 caps the deposit at one per game — estimate can't exceed it
  assert.equal(parseRun('{"run":21,"bestDepth":1}').buckets, 20);
  // fresh payload, nothing to backfill
  assert.equal(parseRun('{"run":1,"bestDepth":0}').buckets, 0);
});

test("parseRun: round-trips a current payload", () => {
  const s = { run: 12, bestDepth: 5, buckets: 214 };
  assert.deepEqual(parseRun(JSON.stringify(s)), s);
});

test("isBucketMilestone: sparse rungs then every thousand", () => {
  for (const n of [50, 100, 250, 500, 1000, 2000, 5000]) {
    assert.equal(isBucketMilestone(n), true, `${n}`);
  }
  for (const n of [1, 49, 51, 200, 750, 999, 1001, 1500]) {
    assert.equal(isBucketMilestone(n), false, `${n}`);
  }
});
