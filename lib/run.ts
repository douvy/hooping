// The run's paper trail — pure parse/format logic kept out of the
// component so node --test can reach it. localStorage stays in Hoop.tsx.

export interface RunState {
  run: number;
  bestDepth: number; // deepest level ever cleared
  buckets: number; // career makes, every run deposits
}

const FRESH: RunState = { run: 1, bestDepth: 0, buckets: 0 };

/** Parse a stored run. Old payloads predate buckets; garbage means a
 * fresh player. */
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
