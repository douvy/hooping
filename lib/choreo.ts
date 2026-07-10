// The death card's choreography as pure math — beat times derived from
// how deep the run went, kept out of the component so node --test can
// hold the timeline. The clock and the DOM work live in
// components/VerdictCard.tsx: every element derives its style from one
// t (seconds since the card mounted), a skip clamps t to Infinity, and
// prefers-reduced-motion mounts there.

export interface DeathBeats {
  /** the death word stamps in */
  stamp: number;
  /** the empty rack (dots, pennant) fades in before the run refills it */
  frame: number;
  /** each made dot, left to right — one tick apiece */
  fills: number[];
  /** the ✗ hits its dot and the row shakes */
  strike: number;
  /** after the shake and a beat of stillness, the stakes line lands */
  stakes: number;
  /** the run-it-back button arrives (== stakes when there are none) */
  cta: number;
  /** the career line reveals; the +N roll starts shortly after */
  career: number;
  /** ghost buttons and the tap-anywhere line */
  footer: number;
  /** choreography complete — presses advance, the breath loop begins */
  end: number;
}

/** Beats scale with run depth: each make replays on its own 120ms step,
 * so a deep death earns a longer funeral. Median (1-2 makes) runs
 * ~1.2s from the stamp to the stakes. */
export function deathBeats(makes: number, hasStakes: boolean): DeathBeats {
  const stamp = 0.35; // just behind the panel's own entrance
  const frame = 0.7;
  const fills = Array.from({ length: makes }, (_, i) => 0.85 + i * 0.12);
  const strike = 0.85 + makes * 0.12 + 0.1;
  const stakes = strike + 0.5; // the shake, then a held breath
  const cta = stakes + (hasStakes ? 0.3 : 0);
  return {
    stamp,
    frame,
    fills,
    strike,
    stakes,
    cta,
    career: cta + 0.12,
    footer: cta + 0.22,
    end: cta + 0.45,
  };
}

/** Integer odometer: the first step lands at t0, one more every stepS.
 * Clamped both ends, so t = Infinity reads `to`. */
export function countAt(
  t: number,
  from: number,
  to: number,
  t0: number,
  stepS: number,
): number {
  if (to <= from || t < t0) return Math.min(from, to);
  return Math.min(to, from + 1 + Math.floor((t - t0) / stepS));
}
