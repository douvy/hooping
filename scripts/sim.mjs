// Tuning harness for lib/physics.ts — run with `pnpm sim [YYYY-MM-DD]`.
// This is where the constants were calibrated before any canvas existed;
// rerun it after touching physics to eyeball the score distribution.
import {
  dailySeed,
  dayNumber,
  makeLake,
  mulberry32,
  simulate,
  shareString,
  MAX_POWER,
  todayStr,
} from "../lib/physics.ts";

const dateStr = process.argv[2] ?? todayStr();
const lake = makeLake(dailySeed(dateStr));
console.log(`lake for ${dateStr}\n`);

// 1. sweep: does a sweet spot exist?
console.log("skips by angle (rows) x power (cols):");
const powers = [8, 10, 12, 14, 16, 18, 20];
console.log("        " + powers.map((p) => String(p).padStart(4)).join("") + "  m/s");
for (let angle = -2; angle <= 20; angle += 2) {
  const row = powers
    .map((p) => String(simulate(lake, p, angle).skips).padStart(4))
    .join("");
  console.log(`${String(angle).padStart(4)}°  ${row}`);
}

// 2. does the daily seed matter? same throw, 5 different days
console.log("\nsame throw (16 m/s, 6°) across days:");
for (const d of ["2026-07-08", "2026-07-09", "2026-07-10", "2026-07-11", "2026-07-12"]) {
  const r = simulate(makeLake(dailySeed(d)), 16, 6);
  console.log(`  ${d}: ${r.skips} skips, ${r.distance.toFixed(1)}m`);
}

// 3. score distribution over random human-ish throws
const rand = mulberry32(42);
const hist = {};
for (let i = 0; i < 2000; i++) {
  const r = simulate(lake, 8 + rand() * (MAX_POWER - 8), -2 + rand() * 24);
  const k = r.plunk ? "plunk" : r.skips >= 10 ? "10+" : String(r.skips);
  hist[k] = (hist[k] ?? 0) + 1;
}
console.log("\n2000 random throws:");
for (const k of ["plunk", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10+"]) {
  if (hist[k]) console.log(`  ${k.padStart(5)}: ${"#".repeat(Math.round(hist[k] / 25))} ${hist[k]}`);
}

// 4. the day's best throw, on a coarse grid — and its share string
let best = { skips: -1 };
for (let p = 8; p <= MAX_POWER; p += 0.5)
  for (let a = -2; a <= 20; a += 1) {
    const r = simulate(lake, p, a);
    if (r.skips > best.skips) best = r;
  }
console.log("\nsample share:\n" + shareString(dayNumber(dateStr), best));
