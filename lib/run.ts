// The run's paper trail — pure parse/format logic kept out of the
// component so node --test can reach it. localStorage stays in Hoop.tsx.

import { BALL_R } from "./hoop.ts";

export interface RunState {
  run: number;
  bestDepth: number; // deepest level ever cleared
  buckets: number; // career makes, every run deposits
  wins: number; // career full clears — each hangs a gold banner
  /** per-level closest miss in meters (index = level - 1); null = never
   * missed there. The record you can break while losing. */
  closest: (number | null)[];
}

const FRESH: RunState = { run: 1, bestDepth: 0, buckets: 0, wins: 0, closest: [] };

/** Parse a stored run. Old payloads predate buckets/wins; garbage means
 * a fresh player. */
export function parseRun(raw: string | null): RunState {
  if (!raw) return FRESH;
  try {
    const s = JSON.parse(raw) as Partial<RunState>;
    if (typeof s.run !== "number" || s.run < 1) return FRESH;
    const bestDepth = s.bestDepth ?? 0;
    return {
      run: s.run,
      bestDepth,
      buckets: s.buckets ?? backfillBuckets(s.run, bestDepth),
      // pre-wins payloads: bestDepth 6 proves at least one full clear —
      // a champion shouldn't come back to bare rafters
      wins: s.wins ?? (bestDepth >= 6 ? 1 : 0),
      // sparse arrays JSON-round-trip as nulls; anything else is garbage
      closest: Array.isArray(s.closest)
        ? s.closest.map((v) => (typeof v === "number" ? v : null))
        : [],
    };
  } catch {
    return FRESH;
  }
}

// Pre-buckets payloads carry a game count but no career makes — showing
// GAME 136 next to 0 BUCKETS reads as broken. Career makes are bounded:
// every finished game deposited at most bestDepth (that's what "best"
// means) and at least the best game itself happened once. Inside those
// bounds, the gauntlet's run-depth distribution says ~1.5 makes per game.
function backfillBuckets(run: number, bestDepth: number): number {
  const games = run - 1;
  return Math.max(
    bestDepth,
    Math.min(Math.round(games * 1.5), games * bestDepth),
  );
}

/** Career-bucket milestones: sparse early rungs, then every thousand. */
export function isBucketMilestone(n: number): boolean {
  return [50, 100, 250, 500].includes(n) || (n >= 1000 && n % 1000 === 0);
}

/** The autopsy line: a miss named in ball-widths, the unit a shooter
 * can feel. Bricks past three balls get silence — a blowout needs no
 * narration, and "off by nine balls" would read as mockery. */
export function describeMiss(
  missBy: number,
  side: "short" | "long",
): string | null {
  const balls = missBy / (2 * BALL_R);
  if (balls < 0.25) return "off by a hair";
  if (balls > 3) return null;
  const q = Math.max(0.5, Math.round(balls * 2) / 2);
  const amount =
    q <= 0.5
      ? "half a ball"
      : q === 1
        ? "one ball"
        : q === 1.5
          ? "a ball and a half"
          : q === 2
            ? "two balls"
            : q === 2.5
              ? "two and a half balls"
              : "three balls";
  return `${side} by ${amount}`;
}
