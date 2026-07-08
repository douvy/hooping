// HOOP tuning harness. Sweeps the whole input space (angle × power) for a
// level and prints an ASCII map of outcomes — the make-region's shape and
// the drama around its edges, visible before any canvas exists.
//
//   #  clean make        R  rattle make (rim first, then in)
//   B  bank make (glass) o  rim-out / glass-out (touched iron, missed)
//   ·  miss
//
// usage: node --experimental-strip-types scripts/hoopsim.mjs [levelIndex]

import { LEVELS, MIN_POWER, MAX_POWER, simulateShot } from "../lib/hoop.ts";

const level = LEVELS[Number(process.argv[2] ?? 0)] ?? LEVELS[0];

function classify(r) {
  const before = r.touches.filter((t) => !r.made || t.t < r.madeAt);
  const rim = before.some((t) => t.kind === "rim");
  const board = before.some((t) => t.kind === "board" || t.kind === "wall");
  if (r.made) return board ? "B" : rim ? "R" : "#";
  return rim || board ? "o" : "·";
}

const A_STEP = 2;
const P_STEP = 0.25;
const counts = { "#": 0, R: 0, B: 0, o: 0, "·": 0 };
let total = 0;

console.log(`level ${level.id} — ${level.name}`);
console.log(
  `launch (${level.launch.x}, ${level.launch.y}) → rim (${level.rim.x}, ${level.rim.y})\n`,
);
console.log(
  "        power " +
    MIN_POWER +
    " ".repeat(Math.round((MAX_POWER - MIN_POWER) / P_STEP) - 4) +
    MAX_POWER,
);
for (let a = 80; a >= 20; a -= A_STEP) {
  let row = "";
  for (let p = MIN_POWER; p <= MAX_POWER + 1e-9; p += P_STEP) {
    const c = classify(simulateShot(level, p, a));
    counts[c]++;
    total++;
    row += c;
  }
  console.log(String(a).padStart(5) + "°  " + row);
}

console.log();
const pct = (n) => ((100 * n) / total).toFixed(1) + "%";
console.log(`clean makes   ${pct(counts["#"])}`);
console.log(`rattle makes  ${pct(counts.R)}   (rim first — the good ones)`);
console.log(`bank makes    ${pct(counts.B)}   (off the glass)`);
console.log(`rim/glass-out ${pct(counts.o)}   (the agony zone)`);
console.log(`all makes     ${pct(counts["#"] + counts.R + counts.B)}`);

// a sample rattle — how long does the drama last?
outer: for (let a = 80; a >= 20; a -= 1) {
  for (let p = MIN_POWER; p <= MAX_POWER; p += 0.1) {
    const r = simulateShot(level, p, a);
    const rims = r.touches.filter((t) => t.kind === "rim");
    if (r.made && rims.length >= 3) {
      console.log(
        `\nsample rattle: ${p.toFixed(1)} m/s @ ${a}° — ${rims.length} rim touches over ${(r.madeAt - rims[0].t).toFixed(2)}s, then in`,
      );
      break outer;
    }
  }
}
