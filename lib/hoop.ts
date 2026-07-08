// HOOP core physics. Deterministic and pure: same shot → same result,
// no RNG anywhere. The rim is two steel points and the ball is a circle;
// everything dramatic about basketball — rattles, rim-outs, banks — falls
// out of circle-vs-point collisions with real dimensions. Ball Ø24cm,
// rim Ø45cm: only 10.5cm of grace per side. Tuned in scripts/hoopsim.mjs.

export interface Vec {
  x: number;
  y: number;
}

/** An obstacle segment the ball bounces off — walls, ramps, ledges. */
export interface Wall {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Level {
  id: number;
  name: string;
  /** court size in meters — the whole level is visible, no camera */
  w: number;
  h: number;
  launch: Vec;
  /** FRONT rim point; the mouth spans rim.x .. rim.x + RIM_GAP */
  rim: Vec;
  board: boolean;
  walls: Wall[];
}

export const BALL_R = 0.12; // regulation-ish basketball
export const RIM_GAP = 0.45; // 18" rim
export const RIM_TUBE = 0.02; // the steel itself
export const BOARD_OFF = 0.1; // glass sits just behind the back rim
export const BOARD_H = 0.9;
export const G = 9.8;
export const E_RIM = 0.6; // steel is lively — this is the rattle knob
export const E_BOARD = 0.65;
export const E_FLOOR = 0.6;
export const E_WALL = 0.6;
export const MIN_POWER = 4;
export const MAX_POWER = 13;

const DT = 1 / 240;
const MAX_TIME = 12;
const SETTLE_SPEED = 1.0; // a floor hit slower than this is a dead ball
const NET_DRAG = 0.45; // the swish grabs the ball on the way through

// The ladder. One shot per level, miss = level 1 — so each level's answer
// must be learnable (deterministic) and its make-band fat enough that a
// practiced hand hits ~55-70% (verified in scripts/gauntlet.mjs; the
// solvability and difficulty bounds are locked in hoop.test.ts).
export const LEVELS: Level[] = [
  {
    id: 1,
    name: "layup",
    w: 6,
    h: 5,
    launch: { x: 1, y: 1 },
    rim: { x: 3.6, y: 2.4 },
    board: true,
    walls: [],
  },
  {
    id: 2,
    name: "the arc",
    w: 8,
    h: 5,
    launch: { x: 1, y: 1 },
    rim: { x: 5.4, y: 3.05 },
    board: true,
    walls: [],
  },
  {
    id: 3,
    name: "deep",
    w: 9.5,
    h: 5,
    launch: { x: 1, y: 1 },
    rim: { x: 7.0, y: 3.05 },
    board: true,
    walls: [],
  },
  {
    id: 4,
    name: "over the wall",
    w: 8,
    h: 5,
    launch: { x: 1, y: 1 },
    rim: { x: 5.4, y: 3.05 },
    board: true,
    walls: [{ x1: 3.4, y1: 0, x2: 3.4, y2: 2.6 }],
  },
  {
    id: 5,
    name: "the window",
    w: 8,
    h: 5,
    launch: { x: 1, y: 1 },
    rim: { x: 5.4, y: 3.05 },
    board: true,
    walls: [{ x1: 2.6, y1: 4.4, x2: 6.4, y2: 4.4 }],
  },
  {
    id: 6,
    name: "keyhole",
    w: 8.5,
    h: 5,
    launch: { x: 1, y: 1 },
    rim: { x: 5.6, y: 3.05 },
    board: true,
    walls: [
      { x1: 3.6, y1: 0, x2: 3.6, y2: 2.8 },
      { x1: 2.6, y1: 4.5, x2: 6.6, y2: 4.5 },
    ],
  },
];

export type TouchKind = "rim" | "board" | "floor" | "wall";

export interface Touch {
  x: number;
  y: number;
  kind: TouchKind;
  /** impact speed — drives clank volume */
  speed: number;
  t: number;
}

export interface ShotState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  t: number;
  touches: Touch[];
  made: boolean;
  madeAt: number;
  done: boolean;
}

export interface Shooter {
  state: ShotState;
  /** Advance the simulation by dt seconds (internally substepped). */
  step(dt: number): void;
}

export function createShot(
  level: Level,
  speedMps: number,
  angleDeg: number,
): Shooter {
  const a = (angleDeg * Math.PI) / 180;
  const state: ShotState = {
    x: level.launch.x,
    y: level.launch.y,
    vx: speedMps * Math.cos(a),
    vy: speedMps * Math.sin(a),
    t: 0,
    touches: [],
    made: false,
    madeAt: 0,
    done: false,
  };

  const rimPts: Vec[] = [
    level.rim,
    { x: level.rim.x + RIM_GAP, y: level.rim.y },
  ];
  const boardX = level.rim.x + RIM_GAP + BOARD_OFF;

  function touch(kind: TouchKind, speed: number) {
    state.touches.push({ x: state.x, y: state.y, kind, speed, t: state.t });
  }

  // circle vs point — the rim tube. Push out, reflect the approaching
  // component. This tiny function IS the drama: every rattle, every
  // rim-out, every ball that sits on the iron deciding.
  function hitRim(p: Vec) {
    const s = state;
    const R = BALL_R + RIM_TUBE;
    const dx = s.x - p.x;
    const dy = s.y - p.y;
    const d = Math.hypot(dx, dy);
    if (d >= R || d === 0) return;
    const nx = dx / d;
    const ny = dy / d;
    s.x = p.x + nx * R;
    s.y = p.y + ny * R;
    const vn = s.vx * nx + s.vy * ny;
    if (vn < 0) {
      s.vx -= (1 + E_RIM) * vn * nx;
      s.vy -= (1 + E_RIM) * vn * ny;
      touch("rim", -vn);
    }
  }

  // circle vs segment — obstacles. Closest-point clamp handles ends.
  function hitWall(w: Wall) {
    const s = state;
    const ex = w.x2 - w.x1;
    const ey = w.y2 - w.y1;
    const len2 = ex * ex + ey * ey;
    const u = Math.max(
      0,
      Math.min(1, ((s.x - w.x1) * ex + (s.y - w.y1) * ey) / len2),
    );
    const px = w.x1 + u * ex;
    const py = w.y1 + u * ey;
    const dx = s.x - px;
    const dy = s.y - py;
    const d = Math.hypot(dx, dy);
    if (d >= BALL_R || d === 0) return;
    const nx = dx / d;
    const ny = dy / d;
    s.x = px + nx * BALL_R;
    s.y = py + ny * BALL_R;
    const vn = s.vx * nx + s.vy * ny;
    if (vn < 0) {
      s.vx -= (1 + E_WALL) * vn * nx;
      s.vy -= (1 + E_WALL) * vn * ny;
      touch("wall", -vn);
    }
  }

  function substep() {
    const s = state;
    const prevY = s.y;
    s.vy -= G * DT;
    s.x += s.vx * DT;
    s.y += s.vy * DT;
    s.t += DT;

    // score: falling through the mouth. Checked before collisions so a
    // graze on the way through still counts ("in off the rim").
    if (!s.made && s.vy < 0 && prevY > level.rim.y && s.y <= level.rim.y) {
      const f = (prevY - level.rim.y) / (prevY - s.y);
      const xc = s.x - s.vx * DT * (1 - f);
      if (xc > level.rim.x && xc < level.rim.x + RIM_GAP) {
        s.made = true;
        s.madeAt = s.t;
        // the net takes some sting out
        s.vx *= NET_DRAG;
        s.vy *= 1 - NET_DRAG;
      }
    }

    hitRim(rimPts[0]);
    hitRim(rimPts[1]);

    // backboard — the left face of the glass
    if (
      level.board &&
      s.vx > 0 &&
      s.x + BALL_R > boardX &&
      s.x < boardX &&
      s.y > level.rim.y - 0.05 &&
      s.y < level.rim.y + BOARD_H
    ) {
      s.x = boardX - BALL_R;
      touch("board", s.vx);
      s.vx = -s.vx * E_BOARD;
    }

    for (const w of level.walls) hitWall(w);

    // floor
    if (s.y - BALL_R < 0 && s.vy < 0) {
      const vin = -s.vy;
      s.y = BALL_R;
      if (vin < SETTLE_SPEED) {
        s.done = true; // dead ball
        return;
      }
      s.vy = vin * E_FLOOR;
      s.vx *= 0.8;
      touch("floor", vin);
    }

    // shot over: made and dropped through, rolled off court, or clock
    if (
      (s.made && s.t > s.madeAt + 0.9) ||
      s.x < -1 ||
      s.x > level.w + 2 ||
      s.t >= MAX_TIME
    ) {
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

export interface ShotResult {
  made: boolean;
  touches: Touch[];
  madeAt: number;
  t: number;
}

/** Run a shot to completion — tests, tuning, solvability scans. */
export function simulateShot(
  level: Level,
  speedMps: number,
  angleDeg: number,
): ShotResult {
  const sh = createShot(level, speedMps, angleDeg);
  while (!sh.state.done) sh.step(1);
  const s = sh.state;
  return { made: s.made, touches: s.touches, madeAt: s.madeAt, t: s.t };
}
