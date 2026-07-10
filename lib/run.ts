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
  /** deepest level cleared today — the record that resets overnight.
   * A plateaued career best goes quiet; this one is beatable again
   * every morning. */
  todayDepth: number;
  /** the localDay() key todayDepth belongs to */
  todayDate: string;
}

const FRESH: RunState = {
  run: 1,
  bestDepth: 0,
  buckets: 0,
  wins: 0,
  closest: [],
  todayDepth: 0,
  todayDate: "",
};

/** The calendar key for today's best — local time, because "today" means
 * the player's day, not UTC's. */
export function localDay(d = new Date()): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** Parse a stored run. Old payloads predate buckets/wins/today; garbage
 * means a fresh player. `today` rolls the daily record: a stored depth
 * from any other day resets to 0. */
export function parseRun(raw: string | null, today: string): RunState {
  if (!raw) return { ...FRESH, todayDate: today };
  try {
    const s = JSON.parse(raw) as Partial<RunState>;
    if (typeof s.run !== "number" || s.run < 1)
      return { ...FRESH, todayDate: today };
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
      todayDepth:
        s.todayDate === today && typeof s.todayDepth === "number"
          ? s.todayDepth
          : 0,
      todayDate: today,
    };
  } catch {
    return { ...FRESH, todayDate: today };
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

/** Career-bucket milestones. Dense where players actually live: 10 and
 * 25 land in a first session, every 50 through 500 keeps the ~1.5
 * makes-per-game grind inside ~30 games of the next rung, then the
 * rungs space out. */
export function isBucketMilestone(n: number): boolean {
  if (n === 10 || n === 25) return true;
  if (n <= 0) return false;
  if (n <= 500) return n % 50 === 0;
  if (n <= 1000) return n % 250 === 0;
  return n % 1000 === 0;
}

/** The next rung up — feeds the death card's "12 TO 150" countdown. */
export function nextBucketMilestone(n: number): number {
  if (n < 10) return 10;
  if (n < 25) return 25;
  if (n < 500) return (Math.floor(n / 50) + 1) * 50;
  if (n < 1000) return (Math.floor(n / 250) + 1) * 250;
  return (Math.floor(n / 1000) + 1) * 1000;
}

/** The gesture hint ("drag back anywhere") shows on level 1 to anyone
 * who's never cleared a level, and to everyone until their session's
 * first shot — the "anywhere" is the part veterans forget: they anchor
 * on the ball at the screen edge and run out of thumb room. */
export function showGestureHint(
  bestDepth: number,
  shotThisSession: boolean,
  levelIdx: number,
): boolean {
  return (bestDepth === 0 || !shotThisSession) && levelIdx === 0;
}

/** The one stakes line a share can carry, strongest claim first — the
 * same ladder the death card climbs, worded in first person because the
 * artifact speaks as the player. Falls back to the scoreboard when the
 * run made no news. */
export function shareStakes(opts: {
  frontier: boolean;
  todayFrontier: boolean;
  tiesBest: boolean;
  closestYet: boolean;
  bestDepth: number;
  total: number;
  /** 1-based level the run died on */
  level: number;
}): string {
  if (opts.frontier) return "one make from my best";
  if (opts.todayFrontier)
    return opts.tiesBest ? "one make ties my best" : "one make from today's best";
  if (opts.closestYet) return "my closest yet";
  if (opts.bestDepth > 0) return `best ${opts.bestDepth}/${opts.total}`;
  return `level ${opts.level}`;
}

/** The share text — the wordle move in one line: the run as emoji pips,
 * the stakes, the link. A death row ends at the ❌ (no trailing empties;
 * the cut is the story), a win runs the full rack. */
export function shareArtifact(opts: {
  beat: boolean;
  total: number;
  makes: number;
  stakes: string;
}): string {
  const row = opts.beat
    ? "🟠".repeat(opts.total)
    : "🟠".repeat(opts.makes) + "❌";
  return `${row} · ${opts.beat ? "no misses" : opts.stakes} · hooping.io`;
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
