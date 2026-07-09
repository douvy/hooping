// ONE SHOT gauntlet sim. Question: with one shot per level and miss =
// back to level 1, does run depth feel like skill or like dice?
//
// Player model: practiced — they've learned each level's answer. They aim
// at the most ROBUST make (the aim whose noisy neighborhood makes most
// often — the fat part of the band, which is what practice finds), then
// execute with gaussian finger noise. Deterministic physics means the
// only randomness in the whole game is the player's own hands.
//
// Finger noise, from gesture-space: ~4px of pull error on a good day.
//   pull/16 mapping → sigma 0.25 m/s;  pull/24 → 0.17 m/s (finer control)
//
// usage: node --experimental-strip-types scripts/gauntlet.mjs

import { LEVELS, simulateShot } from "../lib/hoop.ts";

// hoop.ts is RNG-free by design — the sim brings its own dice
// (the player's hands, not the game's)
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(1234);
function gaussian() {
  return Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
}

// the ladder now lives in lib/hoop.ts — this sim verifies the real thing
const LADDER = LEVELS;

const P_MIN = 4, P_MAX = 13;

// find the most robust make: scan fine grid, score each make by how often
// its noisy neighborhood also makes, pick the fattest spot
function practicedAim(level, sigP, sigA) {
  const makes = [];
  for (let a = 15; a <= 85; a += 1) {
    for (let p = P_MIN; p <= P_MAX + 1e-9; p += 0.1) {
      if (simulateShot(level, p, a).made) makes.push({ p, a });
    }
  }
  if (makes.length === 0) return null;
  let best = null;
  let bestScore = -1;
  // robustness sampling is the expensive bit — thin the candidate list
  const step = Math.max(1, Math.floor(makes.length / 120));
  for (let i = 0; i < makes.length; i += step) {
    const m = makes[i];
    let hit = 0;
    for (let s = 0; s < 60; s++) {
      if (simulateShot(level, m.p + gaussian() * sigP, m.a + gaussian() * sigA).made) hit++;
    }
    if (hit > bestScore) {
      bestScore = hit;
      best = m;
    }
  }
  return best;
}

function makeProb(level, aim, sigP, sigA, n = 500) {
  let hit = 0;
  for (let i = 0; i < n; i++) {
    if (simulateShot(level, aim.p + gaussian() * sigP, aim.a + gaussian() * sigA).made) hit++;
  }
  return hit / n;
}

// --- per-level make probability, practiced player ---
console.log("per-level make probability (practiced player, aiming at the fat part of the band)\n");
console.log("level            pull/16 (σ .25 m/s, 1.2°)   pull/24 (σ .17 m/s, 0.8°)");

const aims = [];
const probs16 = [];
const probs24 = [];
for (const lv of LADDER) {
  const aim = practicedAim(lv, 0.25, 1.2);
  aims.push(aim);
  if (!aim) {
    console.log(`${String(lv.id).padStart(2)} ${lv.name.padEnd(14)} UNSOLVABLE`);
    probs16.push(0);
    probs24.push(0);
    continue;
  }
  const p16 = makeProb(lv, aim, 0.25, 1.2);
  const p24 = makeProb(lv, aim, 0.17, 0.8);
  probs16.push(p16);
  probs24.push(p24);
  console.log(
    `${String(lv.id).padStart(2)} ${lv.name.padEnd(14)} ${(p16 * 100).toFixed(0).padStart(6)}%` +
    ` @ ${aim.p.toFixed(1)}m/s ${aim.a}°` +
    `        ${(p24 * 100).toFixed(0).padStart(6)}%`,
  );
}

// --- full runs: one shot per level, miss = level 1 ---
function simRuns(probs, nRuns) {
  const deaths = new Array(LADDER.length + 1).fill(0); // index = depth reached
  let beat = 0;
  for (let r = 0; r < nRuns; r++) {
    let depth = 0;
    for (let i = 0; i < probs.length; i++) {
      if (rng() < probs[i]) depth++;
      else break;
    }
    if (depth === probs.length) beat++;
    deaths[depth]++;
  }
  return { deaths, beat };
}

for (const [label, probs] of [["pull/16", probs16], ["pull/24", probs24]]) {
  const N = 4000;
  const { deaths, beat } = simRuns(probs, N);
  console.log(`\nrun-depth distribution, ${label} — ${N} runs (death at level d+1):`);
  for (let d = 0; d <= LADDER.length; d++) {
    const bar = "#".repeat(Math.round((deaths[d] / N) * 80));
    const tag = d === LADDER.length ? "BEAT IT" : `died L${d + 1}`;
    console.log(`  depth ${d}  ${tag.padEnd(8)} ${String(deaths[d]).padStart(5)}  ${bar}`);
  }
  console.log(`  cleared all ${LADDER.length}: ${((beat / N) * 100).toFixed(2)}% of runs`);
}

// first-timer sanity: sloppy hands on level 1 only
const sloppy = makeProb(LADDER[0], aims[0], 0.5, 2.5);
console.log(`\nfirst-timer on level 1 (σ .5 m/s, 2.5°): ${(sloppy * 100).toFixed(0)}% per shot`);
console.log(`→ expected shots to first clear: ~${(1 / sloppy).toFixed(1)}`);
