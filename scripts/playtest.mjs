// Simulated playtests — adaptive throwers with human motor noise, run
// against the real physics. Answers the pre-build question: does the
// reward schedule keep paying, or does the game go dead after N throws?
// All rules imported from lib/game.ts so the playtest and the shipped
// game can't drift.
// Run: node --experimental-strip-types scripts/playtest.mjs
import { dailySeed, makeLake, mulberry32, simulate } from "../lib/physics.ts";
import { score, beats, makePlayer, safeDefault, computePar } from "../lib/game.ts";

const lake = makeLake(dailySeed("2026-07-08"));

function session(name, throws, skill, seed = 1) {
  const rng = mulberry32(seed);
  const player = makePlayer(rng, skill);
  let best = null;
  let plunks = 0;
  let nearMisses = 0; // finished within 5% of PB distance but didn't beat it
  const pbEvents = []; // throw index of each new PB

  for (let i = 1; i <= throws; i++) {
    const { p, a } = player.nextThrow();
    const r = simulate(lake, p, a);
    if (r.plunk) plunks++;
    else if (beats(r, best)) {
      best = r;
      player.bestParams = { p, a };
      pbEvents.push(i);
    } else if (r.distance > best.distance * 0.95) nearMisses++;
  }

  const gaps = pbEvents.map((t, i) => t - (pbEvents[i - 1] ?? 0));
  const phase = (from, to) => pbEvents.filter((t) => t > from && t <= to).length;

  console.log(`\n— ${name} (${throws} throws) —`);
  console.log(`  final: ${best.skips} skips · ${best.distance.toFixed(1)}m`);
  console.log(`  plunk rate: ${((plunks / throws) * 100).toFixed(0)}%`);
  console.log(`  near-misses: ${nearMisses} (so-close fuel)`);
  console.log(`  PB events: ${pbEvents.length} at throws [${pbEvents.slice(0, 12).join(", ")}${pbEvents.length > 12 ? ", …" : ""}]`);
  if (throws >= 200)
    console.log(
      `  PB pacing: ${phase(0, 25)} in first 25, ${phase(25, 100)} in 26-100, ${phase(100, throws)} in 101-${throws}`,
    );
  if (gaps.length > 1) console.log(`  longest dry spell between PBs: ${Math.max(...gaps)} throws`);
  return best;
}

// --- the archetypes ---
session("First-timer (10 throws, sloppy)", 10, { sigmaP: 2.5, sigmaA: 4, explore: 0.3 });
session("Casual (40 throws)", 40, { sigmaP: 1.5, sigmaA: 2.5, explore: 0.2 });
const grinderBest = session("Grinder (300 throws, precise)", 300, { sigmaP: 0.8, sigmaA: 1.2, explore: 0.15 });

// --- par calibration ---
const par = computePar(lake);
console.log(`\n— PAR (deterministic 400-throw search) — ${par.skips} skips · ${par.distance.toFixed(1)}m`);
console.log(`  grinder best: ${((score(grinderBest) / score(par)) * 100).toFixed(0)}% of par`);

let beatPar = 0;
for (let s = 100; s < 120; s++) {
  const rng = mulberry32(s);
  const player = makePlayer(rng, { sigmaP: 1.5, sigmaA: 2.5, explore: 0.2 });
  let best = null;
  for (let i = 0; i < 40; i++) {
    const { p, a } = player.nextThrow();
    const r = simulate(lake, p, a);
    if (beats(r, best)) {
      best = r;
      player.bestParams = { p, a };
    }
  }
  if (score(best) > score(par)) beatPar++;
}
console.log(`  casual sessions that beat par: ${beatPar}/20`);

// --- flag war: friend B chases A's decent flag. Beatable in a sitting? ---
console.log("\n— Flag war: chasing a 6-skip friend flag at 14m, 5 different players —");
const target = { skips: 6, distance: 14, plunk: false, contacts: [] };
for (let s = 10; s < 15; s++) {
  const rng = mulberry32(s);
  const player = makePlayer(rng, { sigmaP: 1.5, sigmaA: 2.5, explore: 0.2 });
  let best = null;
  let won = -1;
  for (let i = 1; i <= 150; i++) {
    const { p, a } = player.nextThrow();
    const r = simulate(lake, p, a);
    if (beats(r, best)) { best = r; player.bestParams = { p, a }; }
    if (score(r) > score(target)) { won = i; break; }
  }
  console.log(`  player ${s - 9}: ${won > 0 ? `beat the flag on throw ${won}` : `NEVER beat it in 150 throws (stuck at ${best.skips} · ${best.distance.toFixed(1)}m)`}`);
}

// --- first-throw guarantee across a year of lakes ---
let worst = Infinity;
let failures = 0;
for (let day = 0; day < 365; day++) {
  const d = new Date(Date.UTC(2026, 6, 8 + day)).toISOString().slice(0, 10);
  const dayLake = makeLake(dailySeed(d));
  const def = safeDefault(dayLake);
  const r = simulate(dayLake, def.p, def.a);
  if (r.skips < worst) worst = r.skips;
  if (r.skips < 3) failures++;
}
console.log(`\n— Computed safe default across 365 lakes — worst day: ${worst} skips, days below 3: ${failures}`);
