// Game rules on top of the raw physics: what counts as a score, the safe
// default aim, and the daily par. All deterministic — everything here was
// calibrated in scripts/playtest.mjs against simulated players before the
// UI existed; keep the playtest importing from this file so the two can't
// drift.

import {
  type Lake,
  type ThrowResult,
  mulberry32,
  simulate,
} from "./physics.ts";

/** Distance is the score. A plunk scores zero — the stone must skip to
 *  keep its meters, so you can't cannon it. */
export const score = (r: ThrowResult): number => (r.plunk ? 0 : r.distance);

export const beats = (r: ThrowResult, best: ThrowResult | null): boolean =>
  best === null || score(r) > score(best);

export interface Aim {
  p: number; // power, m/s
  a: number; // angle, degrees above horizontal
}

/** The pre-loaded aim. A new player's first tap must skip — verified
 *  across 365 seeds in physics.test.ts (worst day: 4 skips). */
export function safeDefault(lake: Lake): Aim {
  for (const p of [12, 13, 11, 14, 10])
    for (const a of [4, 2, 6, 0, 8]) {
      if (simulate(lake, p, a).skips >= 3) return { p, a };
    }
  return { p: 12, a: 4 };
}

// --- the simulated player ---
// Remembers the best throw's inputs, explores around them with human
// motor noise. Also models the aim readout turning orange past 12°:
// players see the warning pre-release and mostly re-draw.

export interface PlayerSkill {
  sigmaP: number;
  sigmaA: number;
  explore: number;
}

export function makePlayer(rng: () => number, skill: PlayerSkill) {
  const { sigmaP, sigmaA, explore } = skill;
  return {
    bestParams: { p: 12, a: 4 } as Aim,
    gauss() {
      const u = 1 - rng();
      const v = rng();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    nextThrow(): Aim {
      const wild = rng() < explore ? 3 : 1;
      let a = this.bestParams.a + this.gauss() * sigmaA * wild;
      if (a > 12 && rng() < 0.8) a = this.bestParams.a + this.gauss() * sigmaA;
      return {
        p: Math.min(20, Math.max(6, this.bestParams.p + this.gauss() * sigmaP * wild)),
        a,
      };
    },
  };
}

/** Golf-style par: a fixed-seed 400-throw search — the same strong-but-
 *  beatable target for everyone, computed at load (sub-100ms). Calibrated:
 *  0/20 casual sessions beat it, a 300-throw grinder reaches ~87%. */
export function computePar(lake: Lake, budget = 400): ThrowResult {
  const rng = mulberry32(777); // fixed seed: par is part of the day, not luck
  const player = makePlayer(rng, { sigmaP: 1.2, sigmaA: 1.8, explore: 0.25 });
  let best: ThrowResult | null = null;
  for (let i = 0; i < budget; i++) {
    const { p, a } = player.nextThrow();
    const r = simulate(lake, p, a);
    if (beats(r, best)) {
      best = r;
      player.bestParams = { p, a };
    }
  }
  return best!;
}
