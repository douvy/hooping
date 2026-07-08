// SKIP core physics. Deterministic: same date → same lake for everyone,
// same throw → same result. Tuned in scripts/sim.mjs before any canvas
// existed — the constants below are the ones that produced a Wordle-shaped
// score distribution (mode 5-6, 9 rare, ~27% plunks).

// --- deterministic daily seed ---

export function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function dailySeed(dateStr: string): number {
  let h = 0;
  for (const c of dateStr) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
  return h;
}

/** Local date as YYYY-MM-DD — the daily boundary is the player's midnight. */
export function todayStr(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const EPOCH = Date.UTC(2026, 6, 8); // lake #1

export function dayNumber(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Math.floor((Date.UTC(y, m - 1, d) - EPOCH) / 86400000) + 1;
}

// --- the lake: sum of a few sines, params from seed ---

export interface Lake {
  height(x: number): number;
  slope(x: number): number;
}

export function makeLake(seed: number): Lake {
  const rand = mulberry32(seed);
  const waves = Array.from({ length: 3 }, () => ({
    amp: 0.02 + rand() * 0.04, // meters — perturbs the throw, doesn't decide it
    len: 3 + rand() * 6, // wavelength meters
    phase: rand() * Math.PI * 2,
  }));
  return {
    height(x) {
      return waves.reduce(
        (y, w) => y + w.amp * Math.sin((x / w.len) * 2 * Math.PI + w.phase),
        0,
      );
    },
    slope(x) {
      const d = 0.01;
      return (this.height(x + d) - this.height(x - d)) / (2 * d);
    },
  };
}

// --- throw simulation ---

export const G = 9.8;
export const CRITICAL_ANGLE = 22 * (Math.PI / 180); // magic skipping angle (real-world ~20°)
export const RESTITUTION = 0.55; // vertical energy kept per skip
export const MIN_SPEED = 5.0; // below this the stone just sinks
export const MIN_POWER = 6;
export const MAX_POWER = 20; // the drag gesture caps here — no max-power dominance
export const RELEASE_HEIGHT = 0.5; // released low, like a real skipper's crouch

const DT = 1 / 240;
const MAX_TIME = 30;

export type ContactKind = "skip" | "plunk" | "sink";

export interface Contact {
  x: number;
  kind: ContactKind;
  /** 0 = perfect graze, 1 = barely survived (or died). Drives slow-mo. */
  quality: number;
  /** effective contact angle in degrees — the plunk autopsy. */
  impactDeg: number;
}

export interface ThrowState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  t: number;
  skips: number;
  contacts: Contact[];
  done: boolean;
  /** true when the throw ended with zero skips */
  plunk: boolean;
}

export interface Thrower {
  state: ThrowState;
  /** Advance the simulation by dt seconds (internally substepped). */
  step(dt: number): void;
}

export function createThrow(
  lake: Lake,
  speedMps: number,
  angleDeg: number,
): Thrower {
  const a = angleDeg * (Math.PI / 180);
  const state: ThrowState = {
    x: 0,
    y: RELEASE_HEIGHT,
    vx: speedMps * Math.cos(a),
    vy: speedMps * Math.sin(a), // + is up
    t: 0,
    skips: 0,
    contacts: [],
    done: false,
    plunk: false,
  };

  function substep() {
    const s = state;
    s.vy -= G * DT;
    s.x += s.vx * DT;
    s.y += s.vy * DT;
    s.t += DT;

    if (s.t >= MAX_TIME) {
      s.done = true;
      return;
    }
    if (s.y > lake.height(s.x)) return;

    // impact angle relative to the local water surface
    const impact = Math.atan2(-s.vy, s.vx); // angle below horizontal
    const surface = Math.atan(lake.slope(s.x)); // local wave tilt
    const effective = impact + surface;
    const speed = Math.hypot(s.vx, s.vy);

    const impactDeg = (effective * 180) / Math.PI;
    if (effective < CRITICAL_ANGLE && speed > MIN_SPEED) {
      s.skips++;
      // graded friction: grazing contact keeps speed, near-critical contact
      // survives but bleeds it — throw quality sets the decay rate
      const quality = Math.max(0, effective) / CRITICAL_ANGLE;
      s.contacts.push({ x: s.x, kind: "skip", quality, impactDeg });
      s.vy = -s.vy * RESTITUTION;
      s.vx *= 0.88 - 0.15 * quality;
      s.y = lake.height(s.x) + 0.001;
    } else {
      s.contacts.push({
        x: s.x,
        kind: s.skips === 0 ? "plunk" : "sink",
        quality: 1,
        impactDeg,
      });
      s.plunk = s.skips === 0;
      s.done = true;
    }
  }

  return {
    state,
    step(dt: number) {
      let remaining = dt;
      while (remaining > 0 && !state.done) {
        substep();
        remaining -= DT;
      }
    },
  };
}

export interface ThrowResult {
  skips: number;
  distance: number;
  contacts: Contact[];
  plunk: boolean;
}

/** Run a throw to completion — tests, tuning, and the best-throw scan. */
export function simulate(
  lake: Lake,
  speedMps: number,
  angleDeg: number,
): ThrowResult {
  const t = createThrow(lake, speedMps, angleDeg);
  while (!t.state.done) t.step(1);
  const s = t.state;
  return { skips: s.skips, distance: s.x, contacts: s.contacts, plunk: s.plunk };
}

// --- share string ---
// Distance is the score; the trail shows how it was earned. Throw count
// is honesty ("throw 3" is a flex, "throw 214" is a confession — both
// get screenshotted).

export function shareString(
  day: number,
  r: ThrowResult,
  throwNum?: number,
  parDistance?: number,
): string {
  const throwPart = throwNum ? ` · throw ${throwNum}` : "";
  if (r.plunk) return `SKIP #${day}\n🪨⚓ plunk\n0m${throwPart}`;
  let s = "🪨";
  let prev = 0;
  for (const c of r.contacts) {
    const gap = Math.max(1, Math.min(6, Math.round((c.x - prev) / 2)));
    s += "·".repeat(gap) + (c.kind === "skip" ? "💦" : "⚓");
    prev = c.x;
  }
  // a stone that never sank (ran out the clock) still ends its trail
  if (r.contacts[r.contacts.length - 1]?.kind === "skip") s += "⚓";
  const par =
    parDistance !== undefined && r.distance > parDistance ? " · beat par" : "";
  return `SKIP #${day}\n${s}\n${r.distance.toFixed(1)}m · ${r.skips} skips${throwPart}${par}`;
}
