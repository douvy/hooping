// Closed-form damped spring solver. All motion in this project goes through
// this module — no CSS easing, no animation libraries.
//
// Physics: x(t) is displacement from rest, x(0)=x0, x'(0)=v0, settling to 0.
// Solved analytically (not integrated), so position is a pure function of t —
// which is what makes the scrubber trivial: state derives from time, both directions.

export interface SpringConfig {
  stiffness: number;
  damping: number;
  mass: number;
}

export interface Spring {
  /** Displacement at time t (seconds). 1 → 0 for defaults x0=1, v0=0. */
  at(t: number): number;
  /** Interpolate from → to along the spring at time t. */
  value(from: number, to: number, t: number): number;
  /** Time (seconds) after which |x| stays below epsilon. */
  settleTime(epsilon?: number): number;
}

export const presets = {
  gentle: { stiffness: 120, damping: 20, mass: 1 },
  snappy: { stiffness: 260, damping: 24, mass: 1 },
} as const satisfies Record<string, SpringConfig>;

export function createSpring(
  config: SpringConfig,
  x0 = 1,
  v0 = 0,
): Spring {
  const { stiffness, damping, mass } = config;
  const w0 = Math.sqrt(stiffness / mass); // natural frequency
  const zeta = damping / (2 * Math.sqrt(stiffness * mass)); // damping ratio

  let at: (t: number) => number;

  if (zeta < 1) {
    // Underdamped: oscillates, decays.
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const A = x0;
    const B = (v0 + zeta * w0 * x0) / wd;
    at = (t) => Math.exp(-zeta * w0 * t) * (A * Math.cos(wd * t) + B * Math.sin(wd * t));
  } else if (zeta === 1) {
    // Critically damped: fastest settle, no overshoot.
    const A = x0;
    const B = v0 + w0 * x0;
    at = (t) => (A + B * t) * Math.exp(-w0 * t);
  } else {
    // Overdamped: slow crawl to rest, no oscillation.
    const s = w0 * Math.sqrt(zeta * zeta - 1);
    const r1 = -zeta * w0 + s;
    const r2 = -zeta * w0 - s;
    const B = (v0 - r1 * x0) / (r2 - r1);
    const A = x0 - B;
    at = (t) => A * Math.exp(r1 * t) + B * Math.exp(r2 * t);
  }

  return {
    at,
    value: (from, to, t) => to + (from - to) * at(t),
    settleTime: (epsilon = 0.001) => {
      // Envelope decays as exp(-zeta*w0*t); solve for |x| < epsilon, then
      // scan forward to be exact (envelope is conservative for underdamped).
      let t = Math.log(Math.max(Math.abs(x0), 1e-9) / epsilon) / (zeta * w0);
      const step = 1 / 240;
      while (t > 0 && Math.abs(at(t - step)) < epsilon) t -= step;
      return Math.max(t, 0);
    },
  };
}
