"use client";

// The run. One shot per level; miss and the run dies back to level 1.
// Deterministic physics means every level has a fixed, learnable answer —
// a run is executing six memorized shots without a motor error, so the
// only dice in the machine are your hands (verified: scripts/gauntlet.mjs).
// The creature narrates: squints while you aim, panics while the ball
// rattles on the iron, hops when it drops, wears the crown when you
// clear all six, and the red ! when the run dies.

import { useCallback, useEffect, useRef, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import {
  BALL_R,
  BOARD_H,
  BOARD_OFF,
  LEVELS,
  MAX_POWER,
  MIN_POWER,
  RIM_GAP,
  createShot,
  type Level,
  type Shooter,
  type Touch,
} from "@/lib/hoop";
import { createSpring } from "@/lib/spring";
import * as sound from "@/lib/sound";
import { SKIES, THEME, darken, withAlpha } from "@/lib/theme";

// Layout is the Doodle Jump deal: one thin readout bar, one thin status
// line, and every other pixel is the game. The hand-touched detail lives
// inside the world — the painted court, the skyline, the creature — not
// in chrome around it. Art direction: flat cartoon, thick warm-dark
// outlines on everything, colors from lib/theme.ts, one sky per level
// running afternoon into night.

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded-[3px] border border-border bg-well px-1 py-px font-mono text-[10px] text-foreground">
      {children}
    </kbd>
  );
}

// The death-panel tease: the court the miss cost you, in miniature.
// Drawn from the real level geometry — floor, iron, glass, walls, and
// the launch spot — so dying on level 3 shows exactly what 4 asks.
function MiniCourt({ level }: { level: Level }) {
  const s = 40 / level.h;
  const W = level.w * s;
  const H = level.h * s;
  const X = (x: number) => x * s;
  const Y = (y: number) => H - y * s;
  const boardX = level.rim.x + RIM_GAP + BOARD_OFF;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden className="overflow-visible">
      <line x1={0} y1={Y(0)} x2={W} y2={Y(0)} stroke={THEME.outline} strokeWidth={2} />
      {level.walls.map((w, i) => (
        <line
          key={i}
          x1={X(w.x1)}
          y1={Y(w.y1)}
          x2={X(w.x2)}
          y2={Y(w.y2)}
          stroke={THEME.outline}
          strokeWidth={3}
          strokeLinecap="round"
        />
      ))}
      {level.board && (
        <line
          x1={X(boardX)}
          y1={Y(level.rim.y - 0.05)}
          x2={X(boardX)}
          y2={Y(level.rim.y + BOARD_H)}
          stroke={THEME.outline}
          strokeWidth={2}
          strokeLinecap="round"
        />
      )}
      <line
        x1={X(level.rim.x)}
        y1={Y(level.rim.y)}
        x2={X(level.rim.x + RIM_GAP)}
        y2={Y(level.rim.y)}
        stroke={THEME.rim}
        strokeWidth={2.5}
        strokeLinecap="round"
      />
      <circle
        cx={X(level.launch.x)}
        cy={Y(level.launch.y)}
        r={3}
        fill={THEME.ball}
        stroke={THEME.outline}
        strokeWidth={1.5}
      />
    </svg>
  );
}

const CANVAS_FONT = "10px ui-monospace, Menlo, monospace";

// how far into night each level is — drives the floodlight, the city's
// windows, and the stars. Levels 1-2 are daylight, 6 is full dark; the
// sky itself comes from SKIES in lib/theme.ts.
const NIGHT = [0, 0, 0.15, 0.45, 0.8, 1];

// deterministic scatter for stars, windows, and dirt — the same world
// every visit, no RNG state to carry
function hash01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

const kickSpring = createSpring({ stiffness: 320, damping: 14, mass: 1 });

interface Aim {
  p: number;
  a: number;
}

// pull back, throw opposite. /24 not /16: a longer pull for the same power
// means finger error is a smaller fraction of the aim — more skill, less
// hand-dice (gauntlet sim: practiced make rate 60% → 68% per level).
function aimFromDrag(d: { sx: number; sy: number; dx: number; dy: number }): Aim {
  const pull = Math.hypot(d.dx - d.sx, d.dy - d.sy);
  const vx = d.sx - d.dx;
  const vy = d.dy - d.sy; // screen y down: pulling down aims up
  const a = (Math.atan2(vy, Math.max(vx, 1)) * 180) / Math.PI;
  return {
    p: Math.min(MAX_POWER, Math.max(MIN_POWER, pull / 24)),
    a: Math.max(5, Math.min(85, a)),
  };
}

interface Spark {
  x: number;
  y: number;
  at: number;
  color: string;
}

// pure celebration pixels — visual only, never touches the physics
interface Confetti {
  x: number;
  y: number;
  vx: number;
  vy: number;
  at: number;
  color: string;
}

// enter = the level-intro card; presses are ignored until it hands off to aim
type Phase = "enter" | "aim" | "flying" | "cleared" | "dead" | "beat";
type Pose = "aim" | "watch" | "panic" | "joy" | "triumph" | "rest";

interface LastShot {
  made: boolean;
  touches: Touch[];
}

// --- the run, persisted ---

interface RunState {
  run: number;
  bestDepth: number; // deepest level ever cleared
}

const RUN_KEY = "hoop-run-v1";
const MUTE_KEY = "hoop-muted-v1";

function loadRun(): RunState {
  try {
    const raw = localStorage.getItem(RUN_KEY);
    if (raw) {
      const s = JSON.parse(raw) as RunState;
      if (s.run >= 1) return s;
    }
  } catch {
    // fresh player
  }
  return { run: 1, bestDepth: 0 };
}

function saveRun(s: RunState) {
  try {
    localStorage.setItem(RUN_KEY, JSON.stringify(s));
  } catch {
    // storage blocked — play on
  }
}

export function Hoop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // rAF-mutable state, no React involvement
  const shotRef = useRef<Shooter | null>(null);
  // id: the one pointer that owns this drag — a second thumb resting on
  // the glass must not steal or smear the aim. coarse: finger vs mouse,
  // for the accidental-swipe threshold.
  const dragRef = useRef<{
    id: number;
    coarse: boolean;
    sx: number;
    sy: number;
    dx: number;
    dy: number;
  } | null>(null);
  const trailRef = useRef<{ x: number; y: number }[]>([]);
  const ballRotRef = useRef(0); // the leather spins in flight
  const sparksRef = useRef<Spark[]>([]);
  const seenTouchesRef = useRef(0);
  const lastRimAtRef = useRef(-Infinity); // panic window
  const madeRef = useRef(false);
  const bestDepthRef = useRef(0); // gates the new-deepest fanfare
  const eventAtRef = useRef(-Infinity); // joy hop clock
  const leanAtRef = useRef(-Infinity); // rim-approach slow-mo clock
  const inMouthRef = useRef(false); // edge-detects entry into rim airspace
  const kickAtRef = useRef(-Infinity);
  const phaseRef = useRef<Phase>("aim");
  const levelIdxRef = useRef(0);
  const lastAimRef = useRef<Aim | null>(null);
  const phaseAtRef = useRef(0); // when the current phase began — drives fades
  const runRef = useRef(1); // run number, readable inside the rAF loop
  const confettiRef = useRef<Confetti[]>([]);
  const popRef = useRef<{ text: string; at: number; color: string } | null>(null);
  const newBestRef = useRef(false); // this make went deeper than ever

  // HUD state
  const [phase, setPhase] = useState<Phase>("aim");
  const [levelIdx, setLevelIdx] = useState(0);
  const [runState, setRunState] = useState<RunState | null>(null);
  const [last, setLast] = useState<LastShot | null>(null);
  const [sndOn, setSndOn] = useState(true);
  const [copied, setCopied] = useState(false);

  const setPhaseBoth = useCallback((p: Phase) => {
    phaseRef.current = p;
    phaseAtRef.current = performance.now() / 1000;
    setPhase(p);
  }, []);

  // mount: load run, palette, mute (localStorage is client-only, defer past paint)
  useEffect(() => {
    const t = setTimeout(() => {
      const s = loadRun();
      bestDepthRef.current = s.bestDepth;
      runRef.current = s.run;
      setRunState(s);
      const m = localStorage.getItem(MUTE_KEY) === "1";
      sound.setMuted(m);
      setSndOn(!m);
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const resetForAim = () => {
    shotRef.current = null;
    trailRef.current = [];
    ballRotRef.current = 0;
    sparksRef.current = [];
    confettiRef.current = [];
    popRef.current = null;
    seenTouchesRef.current = 0;
    lastRimAtRef.current = -Infinity;
    madeRef.current = false;
    newBestRef.current = false;
    leanAtRef.current = -Infinity;
    inMouthRef.current = false;
  };

  const shoot = useCallback(
    (aim: Aim) => {
      if (phaseRef.current !== "aim") return;
      resetForAim();
      shotRef.current = createShot(LEVELS[levelIdxRef.current], aim.p, aim.a);
      lastAimRef.current = aim;
      setPhaseBoth("flying");
    },
    [setPhaseBoth],
  );

  // a press after a verdict moves the run along: next level, or run it back.
  // Never straight to aim — the enter card announces where you are first.
  const advance = useCallback(() => {
    const ph = phaseRef.current;
    if (ph === "cleared") {
      const ni = levelIdxRef.current + 1;
      levelIdxRef.current = ni;
      setLevelIdx(ni);
    } else if (ph === "dead" || ph === "beat") {
      setRunState((prev) => {
        if (!prev) return prev;
        const next = { ...prev, run: prev.run + 1 };
        saveRun(next);
        runRef.current = next.run;
        return next;
      });
      levelIdxRef.current = 0;
      setLevelIdx(0);
    } else {
      return;
    }
    resetForAim();
    setPhaseBoth("enter");
  }, [setPhaseBoth]);

  const finishShot = useCallback(() => {
    const s = shotRef.current!.state;
    setLast({ made: s.made, touches: [...s.touches] });
    if (s.made) {
      const depth = levelIdxRef.current + 1;
      setRunState((prev) => {
        if (!prev) return prev;
        const next = { ...prev, bestDepth: Math.max(prev.bestDepth, depth) };
        saveRun(next);
        return next;
      });
      setPhaseBoth(depth === LEVELS.length ? "beat" : "cleared");
    } else {
      // the near-miss gets named too — a rattle-out hurts more than an
      // airball, and the game should say so
      const rims = s.touches.filter((t) => t.kind === "rim").length;
      if (rims > 0) {
        popRef.current = {
          text: rims >= 2 ? "RATTLED OUT" : "RIM OUT",
          at: performance.now() / 1000,
          color: THEME.ball,
        };
      }
      sound.plunk(); // the run dies with a low dead thud
      navigator.vibrate?.(60);
      eventAtRef.current = performance.now() / 1000;
      setPhaseBoth("dead");
    }
  }, [setPhaseBoth]);

  // --- the creature — flat cartoon: outlined head under dark spiky
  // hair, light face. k is his unit size; he stands ~15k tall.
  const drawCreature = (
    ctx: CanvasRenderingContext2D,
    feetX: number,
    floorY: number,
    k: number,
    pose: Pose,
    now: number,
  ) => {
    const { outline: OUTLINE, paper: PAPER, gold: YELLOW, fur: FUR, hair: HAIR, face: FACE, headband: HEADBAND } = THEME;
    const age = now - eventAtRef.current;
    let dy = 0;
    let dx = 0;
    // he's even-keeled: beating the game gets the double hop, a make
    // gets one modest hop, a miss doesn't move him
    if (pose === "triumph") dy = age < 0.64 ? [-1, 0, -1, 0][Math.floor(age / 0.16)] : 0;
    else if (pose === "joy") dy = age < 0.16 ? -1 : 0;
    else if (pose === "aim" && dragRef.current) dy = 1; // crouch into the pull
    else dy = Math.floor(now / 0.82) % 2 ? 1 : 0; // idle bob
    if (pose === "panic") dx = Math.floor(now / 0.09) % 2 ? 1 : -1; // tremble

    const cx = feetX + dx * k;
    const foot = floorY + dy * k;
    // Construction: one chunky rounded-square head, tiny stoic features
    // low on the face, a white hoodie bunched off the left shoulder,
    // jointed arms. Few shapes, all wearing the same line — less plush
    // toy, more point guard.
    const headW = 10.4 * k;
    const headH = 8.6 * k;
    const headY = foot - 14.6 * k;
    const headR = headH / 2; // the marks above hang off this
    const headTop = headY - headR;
    const lw = Math.max(1.5, k * 0.9); // his cartoon line scales with him

    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = lw;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    // legs — longer than a plush toy's, still chunky
    for (const lx of [-1.8, 1.8]) {
      ctx.beginPath();
      ctx.moveTo(cx + lx * k, foot - 4.4 * k);
      ctx.lineTo(cx + lx * k, foot - 1.2 * k);
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 1.5 * k + lw * 1.6;
      ctx.stroke();
      ctx.strokeStyle = FUR;
      ctx.lineWidth = 1.5 * k;
      ctx.stroke();
    }
    // shoes — little white outlined sneakers
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = lw;
    ctx.fillStyle = PAPER;
    for (const fx of [-2.0, 2.0]) {
      ctx.beginPath();
      ctx.ellipse(cx + fx * k, foot - 0.85 * k, 1.75 * k, 1.0 * k, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    // the hood — bunched off to one side (his left; he faces the hoop),
    // drawn behind the body so only the outer bulge shows: one wide
    // puffy lobe sitting at the shoulder, its top level with the top of
    // the hoodie. Nothing on the right.
    ctx.beginPath();
    ctx.ellipse(cx - 5.3 * k, foot - 9.0 * k, 3.5 * k, 2.2 * k, 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // the hoodie — one paper-white shape over the hood
    ctx.beginPath();
    ctx.roundRect(cx - 3.2 * k, foot - 10.2 * k, 6.4 * k, 6.6 * k, 1.7 * k);
    ctx.fill();
    ctx.stroke();
    // the hood's edge — two ink lines starting on the lobe, curving in
    // toward the head, passing under the chin and wrapping around to
    // the other side. The fabric is the same white as the body; a
    // filled shape here reads as a plate, so only the folds are drawn.
    ctx.lineWidth = Math.max(1, lw * 0.8);
    ctx.beginPath();
    ctx.moveTo(cx - 6.4 * k, foot - 10.2 * k);
    ctx.quadraticCurveTo(cx - 4.6 * k, foot - 11.0 * k, cx - 2.0 * k, foot - 10.6 * k);
    ctx.quadraticCurveTo(cx + 1.8 * k, foot - 10.4 * k, cx + 3.2 * k, foot - 8.8 * k);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 5.4 * k, foot - 8.4 * k);
    ctx.quadraticCurveTo(cx - 3.0 * k, foot - 9.4 * k, cx - 0.8 * k, foot - 9.2 * k);
    ctx.quadraticCurveTo(cx + 1.6 * k, foot - 9.0 * k, cx + 2.8 * k, foot - 7.6 * k);
    ctx.stroke();
    // a fold in the fabric, low on the torso
    ctx.lineWidth = Math.max(1, lw * 0.7);
    ctx.beginPath();
    ctx.arc(cx - 0.6 * k, foot - 5.2 * k, 1.6 * k, Math.PI * 0.15, Math.PI * 0.6);
    ctx.stroke();
    ctx.lineWidth = lw;
    // arms — shoulder, elbow, hand: jointed, so poses read athletic.
    // Drawn before the head so raised mittens sit against it.
    const flail = Math.floor(now / 0.14) % 2 === 0;
    // [elbowX, elbowY, handX, handY] per side, in k units off the feet
    const arms: readonly (readonly [number, number, number, number])[] =
      pose === "triumph"
        ? [
            [-5.0, -12.5, -6.4, -17.5],
            [5.0, -12.5, 6.4, -17.5],
          ] // the V — beating the whole game earns it
        : pose === "joy"
          ? [
              [-3.9, -7.9, -4.4, -5.6],
              [5.0, -12.5, 6.2, -16.8],
            ] // one fist up, off arm easy — a made shot is the job
          : pose === "panic"
            ? [
                [-5.0, -8.6, -7.4, flail ? -9.4 : -7.4],
                [5.0, -8.6, 7.4, flail ? -7.4 : -9.4],
              ] // flailing
            : pose === "rest"
              ? [
                  [-3.9, -7.9, -4.4, -5.6],
                  [3.9, -7.9, 4.4, -5.6],
                ] // arms easy at his sides — he takes the L quietly
              : pose === "watch"
                ? [
                    [-4.6, -9.6, -5.6, -11.5],
                    [5.6, -12.0, 7.4, -16.5],
                  ] // the follow-through, held — off hand low, shooting hand high
                : [
                    [-4.6, -13.6, -1.9, -18.3],
                    [5.2, -13.2, 2.6, -18.1],
                  ]; // aim: both hands up over his head, under the ball — proper form
    for (const [ex2, ey2, hx, hy] of arms) {
      const ax = cx + Math.sign(hx) * 3.0 * k; // the shoulder
      const ay = foot - 8.8 * k;
      const elX = cx + ex2 * k;
      const elY = foot + ey2 * k;
      const handX = cx + hx * k;
      const handY = foot + hy * k;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(elX, elY);
      ctx.lineTo(handX, handY);
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 1.5 * k + lw * 1.6;
      ctx.stroke();
      ctx.strokeStyle = PAPER; // sleeves
      ctx.lineWidth = 1.5 * k;
      ctx.stroke();
      // the wristband — a blue tick across the forearm
      const flen = Math.hypot(handX - elX, handY - elY) || 1;
      const wx = elX + (handX - elX) * 0.7;
      const wy = elY + (handY - elY) * 0.7;
      ctx.strokeStyle = HEADBAND;
      ctx.lineWidth = 0.8 * k;
      ctx.beginPath();
      ctx.moveTo(wx - ((handY - elY) / flen) * 0.75 * k, wy + ((handX - elX) / flen) * 0.75 * k);
      ctx.lineTo(wx + ((handY - elY) / flen) * 0.75 * k, wy - ((handX - elX) / flen) * 0.75 * k);
      ctx.stroke();
      // the mitten
      ctx.fillStyle = FACE;
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.arc(handX, handY, 1.05 * k, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    // ears — little side nubs, peeking past the silhouette
    ctx.fillStyle = FACE;
    for (const ex of [-5.5, 5.5]) {
      ctx.beginPath();
      ctx.arc(cx + ex * k, foot - 13.2 * k, 0.95 * k, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    // the head — one chunky rounded square, most of him, filled with
    // hair: the dark mop wraps the sides, the face patch below is the
    // only skin showing
    ctx.fillStyle = HAIR;
    ctx.beginPath();
    ctx.roundRect(cx - headW / 2, headTop, headW, headH, 3.6 * k);
    ctx.fill();
    ctx.stroke();
    // tufts — small rounded lobes running along the head's contour,
    // swept sideways (left lobes lean left, right lean right) with one
    // little one straight up at the crown. Each is one quadratic from
    // base to base whose control is pushed out so the curve peaks at
    // the tip. Bases sit inside the head; only the curve is stroked,
    // so no seam where tuft meets head.
    // [baseX1, baseY1, tipX, tipY, baseX2, baseY2] in k units off the feet
    const tufts: readonly (readonly [number, number, number, number, number, number])[] = [
      [-4.9, -15.4, -6.0, -16.0, -4.6, -16.8],
      [-4.4, -16.8, -5.2, -18.0, -3.6, -18.2],
      [-2.8, -18.3, -2.2, -19.7, -1.0, -18.7],
      [-0.4, -18.8, 0.1, -19.9, 0.6, -18.8],
      [1.4, -18.6, 2.9, -19.6, 2.4, -18.2],
      [3.5, -17.9, 5.0, -18.1, 4.2, -16.9],
      [4.6, -16.6, 5.9, -15.9, 4.9, -15.2],
    ];
    ctx.fillStyle = HAIR;
    for (const [bx1, by1, tx, ty, bx2, by2] of tufts) {
      // control point so the quadratic's midpoint lands on the tip
      const qx = 2 * tx - (bx1 + bx2) / 2;
      const qy = 2 * ty - (by1 + by2) / 2;
      ctx.beginPath();
      ctx.moveTo(cx + bx1 * k, foot + by1 * k);
      ctx.quadraticCurveTo(cx + qx * k, foot + qy * k, cx + bx2 * k, foot + by2 * k);
      ctx.fill();
      ctx.stroke();
    }
    // face — a light patch low on the head, no outline: hairline, not
    // a seam
    ctx.fillStyle = FACE;
    ctx.beginPath();
    ctx.roundRect(cx - 4.0 * k, foot - 15.2 * k, 8.0 * k, 4.8 * k, 2.4 * k);
    ctx.fill();
    // the bangs — a jagged fringe hanging over the forehead, tips
    // stopping just above the eyes. Filled first, then only the zigzag
    // edge is inked; the top tucks into the hair mass unseen.
    const zig: readonly (readonly [number, number])[] = [
      [-4.6, -15.4],
      [-3.2, -14.0],
      [-2.2, -15.0],
      [-1.1, -13.8],
      [0.0, -15.0],
      [1.1, -13.9],
      [2.2, -15.0],
      [3.3, -14.0],
      [4.6, -15.4],
    ];
    ctx.fillStyle = HAIR;
    ctx.beginPath();
    for (const [zx, zy] of zig) ctx.lineTo(cx + zx * k, foot + zy * k);
    ctx.lineTo(cx + 4.6 * k, foot - 16.4 * k);
    ctx.lineTo(cx - 4.6 * k, foot - 16.4 * k);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = Math.max(1, lw * 0.8);
    ctx.beginPath();
    for (const [zx, zy] of zig) ctx.lineTo(cx + zx * k, foot + zy * k);
    ctx.stroke();
    ctx.lineWidth = lw;

    // the face — stoic half-lids by default, dot eyes under determined
    // brows when he's locked in. Features stay small; the head does the
    // talking.
    const eyeY = foot - 13.2 * k;
    const feat = Math.max(1, k * 0.55); // feature line weight
    ctx.fillStyle = OUTLINE;
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = feat;
    ctx.lineCap = "round";
    if (pose === "panic") {
      // wide whites, pinprick pupils, small open mouth
      ctx.fillStyle = PAPER;
      for (const ex of [-1.9, 1.9]) {
        ctx.beginPath();
        ctx.arc(cx + ex * k, eyeY, 1.0 * k, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = OUTLINE;
      for (const ex of [-1.9, 1.9]) {
        ctx.beginPath();
        ctx.arc(cx + ex * k, eyeY, 0.35 * k, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.ellipse(cx, foot - 11.4 * k, 0.55 * k, 0.75 * k, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (pose === "triumph") {
      // ^ ^ eyes and a round grin — the one time he lets it show
      for (const ex of [-1.9, 1.9]) {
        ctx.beginPath();
        ctx.arc(cx + ex * k, eyeY + 0.3 * k, 0.75 * k, Math.PI, Math.PI * 2);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(cx, foot - 11.6 * k, 0.9 * k, 0, Math.PI);
      ctx.closePath();
      ctx.fill();
    } else if (pose === "joy") {
      // half-lids and a small smile — buckets are expected
      ctx.beginPath();
      ctx.moveTo(cx - 2.6 * k, eyeY);
      ctx.lineTo(cx - 1.0 * k, eyeY);
      ctx.moveTo(cx + 1.0 * k, eyeY);
      ctx.lineTo(cx + 2.6 * k, eyeY);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, foot - 12.1 * k, 0.8 * k, Math.PI * 0.2, Math.PI * 0.8);
      ctx.stroke();
    } else if ((pose === "aim" && dragRef.current) || pose === "watch") {
      // locked in — dot eyes track the ball, brows angled down
      const look = pose === "watch" ? 0.5 * k : 0;
      for (const ex of [-1.9, 1.9]) {
        ctx.beginPath();
        ctx.arc(cx + ex * k + look, eyeY, 0.5 * k, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.moveTo(cx - 2.5 * k, eyeY - 1.6 * k);
      ctx.lineTo(cx - 1.1 * k, eyeY - 1.1 * k);
      ctx.moveTo(cx + 2.5 * k, eyeY - 1.6 * k);
      ctx.lineTo(cx + 1.1 * k, eyeY - 1.1 * k);
      ctx.stroke();
      if (pose === "watch") {
        // the little o — he can't believe it either
        ctx.beginPath();
        ctx.arc(cx + 0.5 * k, foot - 11.5 * k, 0.45 * k, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(cx - 0.5 * k, foot - 11.8 * k);
        ctx.lineTo(cx + 0.5 * k, foot - 11.8 * k);
        ctx.stroke();
      }
    } else {
      // stoic half-lids and a flat mouth — he's done this before
      ctx.beginPath();
      ctx.moveTo(cx - 2.6 * k, eyeY);
      ctx.lineTo(cx - 1.0 * k, eyeY);
      ctx.moveTo(cx + 1.0 * k, eyeY);
      ctx.lineTo(cx + 2.6 * k, eyeY);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - 0.5 * k, foot - 11.8 * k);
      ctx.lineTo(cx + 0.5 * k, foot - 11.8 * k);
      ctx.stroke();
    }
    // marks above the head
    const markX = cx + 4.5 * k;
    const markY = headY - headR - 1.6 * k;
    if (pose === "panic") {
      // sweat, flung side to side
      const sxm = flail ? cx - 4.5 * k : markX;
      ctx.fillStyle = HEADBAND;
      ctx.beginPath();
      ctx.ellipse(sxm, markY, 0.6 * k, 0.9 * k, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    if (pose === "triumph") {
      // plus-star sparkles, alternating beats — saved for the full run
      const tw = Math.floor(now / 0.55) % 2 === 0;
      const px2 = tw ? cx - 4.5 * k : markX;
      const py2 = tw ? markY + k : markY - k;
      ctx.strokeStyle = YELLOW;
      ctx.lineWidth = Math.max(1.5, k * 0.7);
      ctx.beginPath();
      ctx.moveTo(px2 - k, py2);
      ctx.lineTo(px2 + k, py2);
      ctx.moveTo(px2, py2 - k);
      ctx.lineTo(px2, py2 + k);
      ctx.stroke();
    }
    if (pose === "triumph") {
      // the crown — all six, one ball
      const cy = headY - headR + 0.4 * k;
      ctx.fillStyle = YELLOW;
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = Math.max(1.5, k * 0.7);
      ctx.beginPath();
      ctx.moveTo(cx - 2.2 * k, cy);
      ctx.lineTo(cx - 2.2 * k, cy - 2.4 * k);
      ctx.lineTo(cx - 0.9 * k, cy - 1.2 * k);
      ctx.lineTo(cx, cy - 2.9 * k);
      ctx.lineTo(cx + 0.9 * k, cy - 1.2 * k);
      ctx.lineTo(cx + 2.2 * k, cy - 2.4 * k);
      ctx.lineTo(cx + 2.2 * k, cy);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.lineWidth = 1;
    ctx.lineCap = "butt";
    ctx.lineJoin = "miter";
  };

  // --- the rAF loop ---
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d")!;
    // the display face for canvas shout text — next/font hashes the
    // family name, so read it off the CSS var it publishes
    const DISPLAY =
      getComputedStyle(document.body).getPropertyValue("--font-plex-serif").trim() ||
      "ui-monospace, Menlo, monospace";

    let raf = 0;
    let lastT = performance.now() / 1000;
    const dpr = Math.min(devicePixelRatio || 1, 2);

    // the canvas fills whatever the flex column gives it — the game IS
    // the screen, chrome is two thin bars
    const resize = () => {
      const { width, height } = wrap.getBoundingClientRect();
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const frame = () => {
      raf = requestAnimationFrame(frame);
      const { outline: OUTLINE, paper: PAPER, ball: MUSTARD, gold: YELLOW } = THEME;
      const SKY = SKIES[levelIdxRef.current] ?? SKIES[SKIES.length - 1];
      const night = NIGHT[levelIdxRef.current] ?? 1;
      const now = performance.now() / 1000;
      const dt = Math.min(now - lastT, 0.05);
      lastT = now;

      // the intro card hands off to aim on its own — no press needed
      if (phaseRef.current === "enter" && now - phaseAtRef.current > 0.5) {
        setPhaseBoth("aim");
      }
      // a make rolls into the next level on its own — keep the momentum.
      // only death asks for a press.
      if (phaseRef.current === "cleared" && now - phaseAtRef.current > 1.0) {
        advance();
      }

      const level = LEVELS[levelIdxRef.current];
      const W = canvas.width / dpr;
      const H = canvas.height / dpr;
      // fit the court by both axes and center it — tall phones and wide
      // desktops both give the game everything they have. Zoomed past a
      // strict fit: crop a sliver of side margin and the empty sky above
      // 4.7m (ceilings live at 4.4-4.5). The rim is the protagonist —
      // high arcs already leave the frame, and that's drama, not a bug.
      const scale = Math.min(W / (level.w * 0.93), (H - 20) / 4.7);
      const ox = (W - level.w * scale) / 2;
      // wide screens pin the floor near the bottom — leaving room for the
      // 16px asphalt cap plus a band of grass; tall screens center the
      // court so sky and floor split the leftover instead of the hoop
      // sinking to the bottom of a portrait phone
      const floorY = Math.min(H - 32, (H + level.h * scale) / 2);
      const sx = (x: number) => ox + x * scale;
      const sy = (y: number) => floorY - y * scale;

      // step the sim
      const shot = shotRef.current;
      if (phaseRef.current === "flying" && shot) {
        // brief slow-mo as the ball drops through — let the moment land.
        // the lean fires on every rim approach, so rim-outs get the same
        // held breath as makes — that's the whole slot machine.
        const slow =
          (madeRef.current && now - eventAtRef.current < 0.5) ||
          now - leanAtRef.current < 0.3;
        const eff = slow ? dt * 0.35 : dt;
        shot.step(eff);
        const s = shot.state;
        // backspin reads as touch; the spin follows the ball's speed
        ballRotRef.current += (Math.abs(s.vx) + 2) * eff * 1.6;
        // edge-detect the ball falling into the rim's airspace; a rattle
        // re-triggers on every downward pass, stretching the agony
        const inMouth =
          !s.done &&
          s.vy < 0 &&
          s.y > level.rim.y &&
          s.y < level.rim.y + 0.7 &&
          s.x > level.rim.x - 0.3 &&
          s.x < level.rim.x + RIM_GAP + 0.3;
        if (inMouth && !inMouthRef.current) leanAtRef.current = now;
        inMouthRef.current = inMouth;
        trailRef.current.push({ x: s.x, y: s.y });
        if (trailRef.current.length > 70) trailRef.current.shift();

        // new touches → sound + sparks
        while (seenTouchesRef.current < s.touches.length) {
          const t = s.touches[seenTouchesRef.current++];
          if (t.kind === "rim") {
            sound.clank(t.speed);
            navigator.vibrate?.(12);
            lastRimAtRef.current = now;
            sparksRef.current.push({ x: t.x, y: t.y, at: now, color: MUSTARD });
          } else if (t.kind === "board" || t.kind === "wall") {
            sound.board(t.speed);
            // ink sparks — paper ones would vanish against the paper board
            sparksRef.current.push({ x: t.x, y: t.y, at: now, color: OUTLINE });
          } else if (t.kind === "floor") {
            sound.bounce(t.speed);
          }
        }
        // the swish — fires mid-flight, the moment the ball drops through
        if (s.made && !madeRef.current) {
          madeRef.current = true;
          eventAtRef.current = now;
          kickAtRef.current = now;
          sound.swish();
          navigator.vibrate?.([20, 30, 40]);
          const depth = levelIdxRef.current + 1;
          const firstEver = bestDepthRef.current === 0; // the conversion moment
          if (depth > bestDepthRef.current) {
            bestDepthRef.current = depth;
            newBestRef.current = true;
            sound.fanfare(); // deeper than ever before
          }
          // name the shot
          const walled = s.touches.some((t) => t.kind === "wall");
          const banked = s.touches.some((t) => t.kind === "board");
          const rims = s.touches.filter((t) => t.kind === "rim").length;
          popRef.current = {
            text:
              depth === LEVELS.length
                ? "GAME WINNER"
                : firstEver
                  ? "FIRST BUCKET"
                  : walled
                    ? "OFF THE WALL"
                    : rims >= 2
                      ? "RATTLED IN"
                      : banked
                        ? "BANK!"
                        : "SWISH",
            at: now,
            color: depth === LEVELS.length || newBestRef.current ? YELLOW : PAPER,
          };
          // confetti from the rim — the first bucket ever gets a parade
          const ccx = level.rim.x + RIM_GAP / 2;
          const n = depth === LEVELS.length ? 80 : firstEver ? 60 : 36;
          for (let i = 0; i < n; i++) {
            confettiRef.current.push({
              x: ccx,
              y: level.rim.y,
              vx: (Math.random() - 0.5) * 5,
              vy: 1 + Math.random() * 3.5,
              at: now,
              color: [MUSTARD, PAPER, YELLOW][i % 3],
            });
          }
        }
        if (s.done) finishShot();
      }

      // --- draw ---
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.font = CANVAS_FONT;

      // screen kick on the swish
      const kt = now - kickAtRef.current;
      if (kt < 0.5) ctx.translate(0, 4 * kickSpring.at(kt));

      // the sky — this level's hour, flat like a painted backdrop
      ctx.fillStyle = SKY;
      ctx.fillRect(0, 0, W, floorY);

      // stars — only once the sky is dark enough to hold them
      if (night > 0.5) {
        const nStars = Math.round(44 * night);
        ctx.fillStyle = PAPER;
        for (let i = 0; i < nStars; i++) {
          const stx = hash01(i * 2 + 1) * W;
          const sty = hash01(i * 2 + 2) * floorY * 0.55;
          ctx.globalAlpha =
            (night - 0.5) * 2 * (0.3 + 0.5 * Math.abs(Math.sin(now * 0.8 + i * 2.4)));
          ctx.fillRect(stx, sty, 2, 2);
        }
        ctx.globalAlpha = 1;
      }

      // clouds — flat paper blobs drifting by, gone after dark
      if (night < 0.8) {
        ctx.fillStyle = PAPER;
        ctx.globalAlpha = 0.9 * (1 - night);
        for (let i = 0; i < 4; i++) {
          const cw = 46 + hash01(i * 9 + 2) * 50;
          const cy = 20 + hash01(i * 9 + 3) * floorY * 0.35;
          const cx = ((hash01(i * 9 + 4) * W + now * (4 + i * 2)) % (W + cw * 2)) - cw;
          ctx.beginPath();
          ctx.ellipse(cx, cy, cw * 0.55, cw * 0.2, 0, 0, Math.PI * 2);
          ctx.ellipse(cx - cw * 0.32, cy + cw * 0.06, cw * 0.3, cw * 0.14, 0, 0, Math.PI * 2);
          ctx.ellipse(cx + cw * 0.32, cy + cw * 0.06, cw * 0.32, cw * 0.15, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      // the city — two flat skyline layers cut from the sky's own color,
      // back layer tall and pale, front layer low and deep. Windows warm
      // up as the day goes. This is a playground, and the town is home.
      for (const [f, hMin, hMax, seed] of [
        [0.86, 34, 88, 700], // back
        [0.72, 16, 48, 900], // front
      ] as const) {
        const bc = darken(SKY, f);
        ctx.fillStyle = bc;
        for (let bx = -12 - seed * 0.01, bi = 0; bx < W; bi++) {
          const bw = 30 + hash01(seed + bi * 3 + 1) * 48;
          const bh = hMin + hash01(seed + bi * 3 + 2) * (hMax - hMin);
          const roof = hash01(seed + bi * 3 + 3);
          ctx.beginPath();
          if (roof < 0.25) {
            // rounded top
            ctx.moveTo(bx, floorY);
            ctx.lineTo(bx, floorY - bh + bw * 0.25);
            ctx.arc(bx + bw / 2, floorY - bh + bw * 0.25, bw / 2, Math.PI, 0);
            ctx.lineTo(bx + bw, floorY);
          } else {
            ctx.rect(bx, floorY - bh, bw, bh);
            if (roof > 0.72) {
              // antenna
              ctx.rect(bx + bw * 0.42, floorY - bh - 9, 2, 9);
            }
          }
          ctx.fill();
          if (night > 0.2) {
            // lit windows — sparse, warm
            ctx.fillStyle = THEME.lamp;
            ctx.globalAlpha = 0.6 * night;
            for (let wi = 0; wi < 6; wi++) {
              if (hash01(seed + bi * 97 + wi * 13) > 0.3) continue;
              const wx = bx + 5 + hash01(seed + bi * 31 + wi * 7) * (bw - 11);
              const wy = floorY - bh + 8 + hash01(seed + bi * 53 + wi * 11) * (bh - 16);
              ctx.fillRect(wx, wy, 3, 4);
            }
            ctx.globalAlpha = 1;
            ctx.fillStyle = bc;
          }
          bx += bw + 3;
        }
      }

      // the rafters — one pennant per level you've ever cleared, strung
      // on a sagging rope top-right like a small gym's banner wall. The
      // trophy case is the world, not a stat readout.
      const nBest = bestDepthRef.current;
      if (nBest > 0) {
        const ropeR = W - 12;
        const ropeL = ropeR - nBest * 22 - 10;
        const sag = 4;
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = 1.5;
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(ropeL, 0);
        ctx.quadraticCurveTo((ropeL + ropeR) / 2, sag * 2, ropeR, 0);
        ctx.stroke();
        // each level flies its own color, left to right — six is the gold
        const flags = [THEME.rim, THEME.headband, MUSTARD, THEME.grass, PAPER, YELLOW];
        for (let i = 0; i < nBest; i++) {
          const px2 = ropeL + 16 + i * 22;
          // where the rope hangs at this x — quadratic from ends at y=0
          const t = (px2 - ropeL) / (ropeR - ropeL);
          const py2 = 4 * sag * t * (1 - t);
          const len = 13 + hash01(i * 7 + 70) * 5; // hung by hand, not machine
          ctx.fillStyle = flags[i % flags.length];
          ctx.beginPath();
          ctx.moveTo(px2 - 5, py2);
          ctx.lineTo(px2 + 5, py2);
          ctx.lineTo(px2, py2 + len);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }
        ctx.lineWidth = 1;
      }

      // the ground — an asphalt court cap set in bright grass, everything
      // wearing the outline
      ctx.fillStyle = THEME.grass;
      ctx.fillRect(0, floorY, W, H - floorY);
      // the asphalt cap the game is played on
      ctx.fillStyle = THEME.asphalt;
      ctx.fillRect(0, floorY, W, 16);
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(0, floorY);
      ctx.lineTo(W, floorY);
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, floorY + 16);
      ctx.lineTo(W, floorY + 16);
      ctx.stroke();
      // grass tufts — little sprigs poking up over the court's bottom seam,
      // fixed constellation
      {
        const tuftY = floorY + 16;
        ctx.fillStyle = THEME.grass;
        ctx.lineWidth = 2.5;
        for (let i = 0; i < 8; i++) {
          const blades = 2 + (i % 2);
          let bx = (i + hash01(i * 3 + 40)) * (W / 8);
          ctx.beginPath();
          ctx.moveTo(bx, tuftY);
          for (let b = 0; b < blades; b++) {
            // each blade is a semicircle bump; arcs chain along the baseline
            const r = 2.5 + hash01(i * 9 + b * 2 + 41) * 2;
            ctx.arc(bx + r, tuftY, r, Math.PI, 0);
            bx += r * 2;
          }
          ctx.fill();
          ctx.stroke();
        }
        ctx.lineWidth = 1;
      }
      // painted baseline along the court, and the level number at center
      ctx.strokeStyle = PAPER;
      ctx.globalAlpha = 0.65;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(sx(0), floorY + 9);
      ctx.lineTo(sx(level.w * 0.44), floorY + 9);
      ctx.moveTo(sx(level.w * 0.56), floorY + 9);
      ctx.lineTo(sx(level.w), floorY + 9);
      ctx.stroke();
      ctx.fillStyle = PAPER;
      ctx.font = `700 13px ${DISPLAY}`;
      ctx.textAlign = "center";
      ctx.fillText(String(level.id), sx(level.w / 2), floorY + 13);
      ctx.textAlign = "left";
      ctx.font = CANVAS_FONT;
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;

      // the hoop: glass, mount, iron, net
      const rimY = sy(level.rim.y);
      const frontX = sx(level.rim.x);
      const backX = sx(level.rim.x + RIM_GAP);
      const boardX = sx(level.rim.x + RIM_GAP + BOARD_OFF);
      // the beacon — a soft glow behind the rim after dark, and a bloom
      // the instant a make drops through (day or night)
      {
        const mouthX = (frontX + backX) / 2;
        const bt = madeRef.current ? now - eventAtRef.current : Infinity;
        const bloom = bt < 0.45 ? 1 - bt / 0.45 : 0;
        const glowA = (0.07 + 0.02 * Math.sin(now * 2.2)) * night + bloom * 0.22;
        if (glowA > 0.005) {
          const gr = scale * (0.9 + bloom * 0.8);
          const glow = ctx.createRadialGradient(mouthX, rimY, 0, mouthX, rimY, gr);
          glow.addColorStop(0, MUSTARD);
          glow.addColorStop(1, withAlpha(MUSTARD, "00"));
          ctx.globalAlpha = glowA;
          ctx.fillStyle = glow;
          ctx.fillRect(mouthX - gr, rimY - gr, gr * 2, gr * 2);
          ctx.globalAlpha = 1;
        }
      }
      if (level.board) {
        const bTop = sy(level.rim.y + BOARD_H);
        const bBot = sy(level.rim.y - 0.05);
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        // the pole — solid ink, a signpost holding a sign
        const poleX = boardX + 5;
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = 7;
        ctx.beginPath();
        ctx.moveTo(poleX, bTop + 8);
        ctx.lineTo(poleX, floorY + 4);
        ctx.stroke();
        // the floodlight — asleep all afternoon, burning after dark
        const lampY = bTop - 16;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(poleX, bTop + 8);
        ctx.lineTo(poleX, lampY);
        ctx.lineTo(poleX - 12, lampY - 5);
        ctx.stroke();
        // the head
        ctx.fillStyle = night > 0.2 ? THEME.lamp : PAPER;
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.rect(poleX - 21, lampY - 10, 11, 6);
        ctx.fill();
        ctx.stroke();
        if (night > 0.2) {
          // the beam — a soft cone falling across the hoop to the court
          const beam = ctx.createLinearGradient(0, lampY, 0, floorY);
          beam.addColorStop(0, withAlpha(THEME.lamp, "30"));
          beam.addColorStop(1, withAlpha(THEME.lamp, "08"));
          ctx.fillStyle = beam;
          ctx.globalAlpha = night;
          ctx.beginPath();
          ctx.moveTo(poleX - 21, lampY - 4);
          ctx.lineTo(poleX - 15 - scale * 2.4, floorY);
          ctx.lineTo(poleX + scale * 0.5, floorY);
          ctx.lineTo(poleX - 10, lampY - 4);
          ctx.closePath();
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        // the board — built like the reference's wooden sign: ink line,
        // light wood bevel, darker face inset
        const bw2 = 11;
        ctx.fillStyle = darken(THEME.wood, 1.14);
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.roundRect(boardX, bTop, bw2, bBot - bTop, 3);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = THEME.wood;
        ctx.beginPath();
        ctx.roundRect(boardX + 3, bTop + 3, bw2 - 6, bBot - bTop - 6, 2);
        ctx.fill();
        // mount
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.moveTo(backX, rimY);
        ctx.lineTo(boardX, rimY);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
      // the net — outlined strands and rings, and a make punches it: the
      // whole mesh kicks down and rings back like nylon
      {
        const nt = madeRef.current ? now - eventAtRef.current : Infinity;
        const kick = nt < 0.6 ? Math.exp(-nt * 7) * Math.cos(nt * 20) * 7 : 0;
        const topW = backX - frontX;
        const netLen = scale * 0.38 + kick;
        const botW = topW * 0.55;
        const midX = (frontX + backX) / 2;
        const netB = rimY + netLen;
        ctx.lineCap = "round";
        ctx.beginPath();
        for (const tt of [0, 1 / 3, 2 / 3, 1] as const) {
          ctx.moveTo(frontX + topW * tt, rimY);
          ctx.lineTo(midX - botW / 2 + botW * tt, netB);
        }
        for (const rr of [0.45, 0.82] as const) {
          const w = topW + (botW - topW) * rr;
          const y = rimY + netLen * rr;
          ctx.moveTo(midX - w / 2, y);
          ctx.lineTo(midX + w / 2, y);
        }
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = 3.5;
        ctx.stroke();
        ctx.strokeStyle = PAPER;
        ctx.lineWidth = 1.8;
        ctx.stroke();
      }
      // the iron — redder than the ball so contact reads, flashing gold
      // the instant a make drops through. Drawn over the net's top edge.
      const ironC =
        madeRef.current && now - eventAtRef.current < 0.25 ? YELLOW : THEME.rim;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(frontX, rimY);
      ctx.lineTo(backX, rimY);
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 8;
      ctx.stroke();
      ctx.strokeStyle = ironC;
      ctx.lineWidth = 4.5;
      ctx.stroke();
      ctx.lineWidth = 1;

      // obstacle slabs — concrete in the cartoon line
      for (const wl of level.walls) {
        ctx.beginPath();
        ctx.moveTo(sx(wl.x1), sy(wl.y1));
        ctx.lineTo(sx(wl.x2), sy(wl.y2));
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = 12;
        ctx.stroke();
        ctx.strokeStyle = THEME.concrete;
        ctx.lineWidth = 7;
        ctx.stroke();
      }
      ctx.lineWidth = 1;
      ctx.lineCap = "butt";

      // sparks — impact bursts on iron and glass
      const aliveSparks: Spark[] = [];
      for (const sp of sparksRef.current) {
        const a = now - sp.at;
        if (a > 0.3) continue;
        aliveSparks.push(sp);
        const r = 3 + a * 24;
        ctx.strokeStyle = sp.color;
        ctx.globalAlpha = 1 - a / 0.3;
        for (const ang of [0.6, 2.2, 3.9, 5.4]) {
          ctx.beginPath();
          ctx.moveTo(sx(sp.x) + Math.cos(ang) * 2, sy(sp.y) - Math.sin(ang) * 2);
          ctx.lineTo(sx(sp.x) + Math.cos(ang) * r, sy(sp.y) - Math.sin(ang) * r);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      sparksRef.current = aliveSparks;

      // confetti — pixel rain from the rim on every make
      const aliveConf: Confetti[] = [];
      for (const c of confettiRef.current) {
        const a = now - c.at;
        if (a > 1.4) continue;
        c.vy -= 9.8 * dt * 0.6; // floaty
        c.x += c.vx * dt;
        c.y += c.vy * dt;
        aliveConf.push(c);
        ctx.fillStyle = c.color;
        ctx.globalAlpha = a < 0.9 ? 1 : 1 - (a - 0.9) / 0.5;
        ctx.fillRect(sx(c.x) - 1.5, sy(c.y) - 1.5, 3, 3);
      }
      ctx.globalAlpha = 1;
      confettiRef.current = aliveConf;

      const ph = phaseRef.current;

      // ball trail — the comet, fading toward its tail. Streaks show off,
      // NBA Jam rules: two makes deep the run is heating up (gold), four
      // deep the ball is on fire (red edge, gold core). A miss resets the
      // run, so the fire goes out by definition.
      const heat = levelIdxRef.current; // consecutive makes this run
      const tr = trailRef.current;
      if (tr.length > 1 && ph !== "aim") {
        ctx.lineCap = "round";
        const layers: readonly (readonly [string, number])[] =
          heat >= 4
            ? [
                [THEME.rim, 7],
                [YELLOW, 3],
              ]
            : heat >= 2
              ? [
                  [YELLOW, 5.5],
                  [MUSTARD, 3],
                ]
              : [[MUSTARD, 3]];
        for (const [col, lw] of layers) {
          ctx.strokeStyle = col;
          ctx.lineWidth = lw;
          for (let i = 1; i < tr.length; i++) {
            ctx.globalAlpha = (i / tr.length) * 0.45;
            ctx.beginPath();
            ctx.moveTo(sx(tr[i - 1].x), sy(tr[i - 1].y));
            ctx.lineTo(sx(tr[i].x), sy(tr[i].y));
            ctx.stroke();
          }
        }
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1;
        ctx.lineCap = "butt";
      }

      // the ball — flat mustard leather in a thick outline, thin dark
      // seams spinning with the flight, reference-style: no shading.
      // Drawn at true physics size so rim reads honest.
      const drawBall = (bx: number, by: number) => {
        const r = Math.max(5, BALL_R * scale);
        ctx.save();
        ctx.translate(bx, by);
        ctx.fillStyle = MUSTARD;
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.clip();
        // seams — a gently bowed cross and two side arcs, spinning
        // inside the clip. Thin against the outline, like the reference.
        ctx.rotate(-ballRotRef.current);
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = Math.max(1, r * 0.09);
        ctx.beginPath();
        ctx.moveTo(-r, 0);
        ctx.quadraticCurveTo(0, r * 0.35, r, 0);
        ctx.moveTo(0, -r);
        ctx.quadraticCurveTo(r * 0.35, 0, 0, r);
        ctx.stroke();
        for (const side of [-1.5, 1.5] as const) {
          ctx.beginPath();
          ctx.arc(side * r, 0, r * 1.05, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
        // re-ink the leather over the clipped edges
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = Math.max(1.5, r * 0.2);
        ctx.beginPath();
        ctx.arc(bx, by, r, 0, Math.PI * 2);
        ctx.stroke();
      };

      // the creature — drawn before the ball, so the ball he's holding
      // sits on top of his face, not behind his hair.
      // pose derived, never stored
      const pose: Pose =
        ph === "beat"
          ? "triumph"
          : madeRef.current
            ? "joy"
            : ph === "dead"
              ? "rest"
              : ph === "aim" || ph === "enter"
                ? "aim"
                : now - lastRimAtRef.current < 0.9
                  ? "panic"
                  : "watch";
      // small on purpose — he's a little guy on a big court (~0.65m tall)
      const k = Math.max(2, Math.round((scale * 0.65) / 14));
      drawCreature(ctx, sx(level.launch.x), floorY, k, pose, now);

      if (ph === "flying" && shot && !shot.state.done) {
        const bx2 = sx(shot.state.x);
        const by2 = sy(shot.state.y);
        if (heat >= 2) {
          // the heater — a flickering halo on the streaking ball
          const hc = heat >= 4 ? THEME.rim : YELLOW;
          const hr = Math.max(5, BALL_R * scale) * (1.8 + 0.2 * Math.sin(now * 24));
          const halo = ctx.createRadialGradient(bx2, by2, 0, bx2, by2, hr);
          halo.addColorStop(0, withAlpha(hc, "55"));
          halo.addColorStop(1, withAlpha(hc, "00"));
          ctx.fillStyle = halo;
          ctx.fillRect(bx2 - hr, by2 - hr, hr * 2, hr * 2);
        }
        drawBall(bx2, by2);
      } else if (ph === "enter") {
        drawBall(sx(level.launch.x), sy(level.launch.y)); // ball in hand, waiting
      } else if (ph === "dead" && shot) {
        // the dead ball lies where it stopped
        drawBall(sx(shot.state.x), sy(Math.max(shot.state.y, BALL_R)));
      }

      // aiming — ball in his raised hands, the pull, the readout
      if (ph === "aim") {
        let bx = sx(level.launch.x);
        let by = sy(level.launch.y);
        const drag = dragRef.current;
        const aim = drag ? aimFromDrag(drag) : null;
        if (aim) {
          // drawn-bowstring tremble past 60% power
          const p01 = (aim.p - MIN_POWER) / (MAX_POWER - MIN_POWER);
          if (p01 > 0.6) {
            const j = (p01 - 0.6) * 4;
            bx += (Math.random() - 0.5) * 2 * j;
            by += (Math.random() - 0.5) * 2 * j;
          }
        }
        drawBall(bx, by);
        if (aim) {
          const p01 = (aim.p - MIN_POWER) / (MAX_POWER - MIN_POWER);
          const rad = (aim.a * Math.PI) / 180;
          const len = 14 + p01 * 52;
          // the arrow heats up with power — ink by default, red when hot
          const aimC = p01 > 0.6 ? THEME.rim : OUTLINE;
          const tipX = bx + Math.cos(rad) * len;
          const tipY = by - Math.sin(rad) * len;
          ctx.strokeStyle = aimC;
          ctx.lineWidth = 2.5;
          ctx.lineCap = "round";
          ctx.setLineDash([4, 5]);
          ctx.beginPath();
          ctx.moveTo(bx, by);
          ctx.lineTo(tipX, tipY);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.lineCap = "butt";
          // arrowhead — the aim is a vector, not a string
          ctx.fillStyle = aimC;
          ctx.beginPath();
          ctx.moveTo(tipX + Math.cos(rad) * 8, tipY - Math.sin(rad) * 8);
          ctx.lineTo(tipX + Math.cos(rad + 2.5) * 6, tipY - Math.sin(rad + 2.5) * 6);
          ctx.lineTo(tipX + Math.cos(rad - 2.5) * 6, tipY - Math.sin(rad - 2.5) * 6);
          ctx.closePath();
          ctx.fill();
          // power bar — an outlined paper pill, no units, just how hard
          ctx.fillStyle = PAPER;
          ctx.strokeStyle = OUTLINE;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.rect(bx - 17, by + 14, 34, 7);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = p01 >= 0.999 ? YELLOW : MUSTARD;
          ctx.fillRect(bx - 15.5, by + 15.5, 31 * p01, 4);
          ctx.lineWidth = 1;
          // training wheels: until the first-ever bucket, level 1 shows
          // the opening beat of the true arc — deterministic physics keeps
          // it honest. Gone forever after the first make.
          if (bestDepthRef.current === 0 && levelIdxRef.current === 0) {
            const ghost = createShot(level, aim.p, aim.a);
            ctx.fillStyle = OUTLINE;
            ctx.globalAlpha = 0.35;
            for (let i = 0; i < 6; i++) {
              ghost.step(0.055);
              ctx.fillRect(sx(ghost.state.x) - 1.5, sy(ghost.state.y) - 1.5, 3, 3);
            }
            ctx.globalAlpha = 1;
          }
        } else if (bestDepthRef.current === 0 && levelIdxRef.current === 0) {
          // first-timer: nothing on screen explains the gesture — this
          // does. 12px, and clamped so it can't run off a narrow phone.
          const hint = "drag back anywhere — let go to shoot";
          ctx.font = `12px ui-monospace, Menlo, monospace`;
          const hx = Math.min(bx + 16, W - ctx.measureText(hint).width - 8);
          ctx.fillStyle = OUTLINE;
          ctx.globalAlpha = 0.6 + 0.3 * Math.sin(now * 3);
          ctx.fillText(hint, hx, by - 16);
          ctx.globalAlpha = 1;
          ctx.font = CANVAS_FONT;
        }
      }

      // the shot-name pop — SWISH / BANK! / RATTLED IN / OFF THE WALL
      const pop = popRef.current;
      if (pop) {
        const a = now - pop.at;
        if (a > 0.95) popRef.current = null;
        else {
          const size = Math.round(46 - 12 * Math.min(a / 0.12, 1)); // slams in
          const px2 = sx(level.rim.x + RIM_GAP / 2);
          const py2 = sy(level.rim.y + 0.7) - a * 18;
          ctx.font = `700 ${size}px ${DISPLAY}`;
          ctx.textAlign = "center";
          ctx.lineJoin = "round";
          ctx.globalAlpha = a < 0.55 ? 1 : 1 - (a - 0.55) / 0.4;
          // sticker lettering: the outline first, the color on top
          ctx.strokeStyle = OUTLINE;
          ctx.lineWidth = Math.max(5, size * 0.18);
          ctx.strokeText(pop.text, px2, py2);
          ctx.fillStyle = pop.color;
          ctx.fillText(pop.text, px2, py2);
          ctx.globalAlpha = 1;
          ctx.lineWidth = 1;
          ctx.lineJoin = "miter";
          ctx.textAlign = "left";
          ctx.font = CANVAS_FONT;
        }
      }

      // --- overlay cards: verdicts and the level intro, faded not cut ---
      const tp = now - phaseAtRef.current;
      if (ph === "enter" && tp < 0.25) {
        // the new level fades up from its own sky — no hard cut
        ctx.fillStyle = SKY;
        ctx.globalAlpha = 1 - tp / 0.25;
        ctx.fillRect(0, 0, W, H);
        ctx.globalAlpha = 1;
      }
      if (ph === "dead" && tp < 0.25) {
        // the sting — one orange blink when the run dies
        ctx.fillStyle = MUSTARD;
        ctx.globalAlpha = 0.12 * (1 - tp / 0.25);
        ctx.fillRect(0, 0, W, H);
        ctx.globalAlpha = 1;
      }
      // a make warms the whole gym for a beat, not just the iron
      const mt = madeRef.current ? now - eventAtRef.current : Infinity;
      if (mt < 0.3) {
        ctx.fillStyle = MUSTARD;
        ctx.globalAlpha = 0.07 * (1 - mt / 0.3);
        ctx.fillRect(0, 0, W, H);
        ctx.globalAlpha = 1;
      }
      const card = (main: string, sub: string, color: string) => {
        const f = Math.min(1, tp / 0.18);
        const cy = H * 0.3 - (1 - f) * 8; // drifts up as it fades in
        ctx.globalAlpha = f;
        ctx.textAlign = "center";
        ctx.lineJoin = "round";
        ctx.font = `700 26px ${DISPLAY}`;
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = 5;
        ctx.strokeText(main, W / 2, cy);
        ctx.fillStyle = color;
        ctx.fillText(main, W / 2, cy);
        ctx.font = CANVAS_FONT;
        // the sub line in ink by day, paper by night
        ctx.fillStyle = night > 0.5 ? PAPER : OUTLINE;
        ctx.fillText(sub, W / 2, cy + 20);
        ctx.textAlign = "left";
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1;
        ctx.lineJoin = "miter";
      };
      const run = runRef.current;
      if (ph === "cleared") {
        const nx = LEVELS[levelIdxRef.current + 1];
        card(
          newBestRef.current ? `LEVEL ${level.id} — NEW BEST` : `LEVEL ${level.id} CLEARED`,
          `next: level ${nx.id}`,
          newBestRef.current ? YELLOW : PAPER,
        );
      } else if (ph === "enter") {
        // level 6 is match point — it should feel like it. Deep runs get
        // their streak named on the way in.
        const lastOne = level.id === LEVELS.length;
        card(
          lastOne ? "THE LAST SHOT" : `LEVEL ${level.id}`,
          lastOne
            ? `level ${level.id} — game ${run}`
            : heat >= 4
              ? `game ${run} — on fire`
              : heat >= 2
                ? `game ${run} — heating up`
                : `game ${run}`,
          lastOne ? YELLOW : PAPER,
        );
      }
    };

    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [finishShot, setPhaseBoth, advance]);

  // --- gesture: pull back, release ---
  // A verdict press is consumed by advance() — it never doubles as the start
  // of a drag, so the level can't teleport under your finger mid-press.
  const onPointerDown = (e: React.PointerEvent) => {
    sound.unlock();
    const ph = phaseRef.current;
    if (ph === "flying" || ph === "enter") return;
    if (ph !== "aim") {
      advance(); // cleared → next level, dead/beat → run it back
      return;
    }
    if (dragRef.current) return; // one finger owns the aim
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      id: e.pointerId,
      coarse: e.pointerType !== "mouse",
      sx: e.clientX,
      sy: e.clientY,
      dx: e.clientX,
      dy: e.clientY,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.id) return;
    d.dx = e.clientX;
    d.dy = e.clientY;
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.id) return;
    dragRef.current = null;
    if (phaseRef.current !== "aim") return;
    const pull = Math.hypot(d.dx - d.sx, d.dy - d.sy);
    // no free throws — a tap is not a shot. Fingers get a fatter dead
    // zone than mice: a 15px stray brush must not spend the run's one
    // ball (min power lives at 96px of pull, so nothing real is lost)
    if (pull < (d.coarse ? 25 : 10)) return;
    shoot(aimFromDrag(d));
  };

  // Space = the exact same pull again. Deterministic physics makes this an
  // instant replay of the aim — the proof there's no dice in the machine.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Escape") {
        dragRef.current = null; // bail out of a bad pull
        return;
      }
      if (e.code !== "Space" || e.repeat) return;
      e.preventDefault();
      sound.unlock();
      const ph = phaseRef.current;
      if (ph === "flying" || ph === "enter") return;
      if (ph !== "aim") {
        advance();
        return;
      }
      if (lastAimRef.current) shoot(lastAimRef.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shoot, advance]);

  // --- the miss autopsy ---
  const autopsy = (l: LastShot): string => {
    const rims = l.touches.filter((t) => t.kind === "rim").length;
    if (rims >= 3) return `${rims} rattles and out`;
    if (rims > 0) return "off the iron";
    if (l.touches.some((t) => t.kind === "board" || t.kind === "wall"))
      return "off the glass";
    return "airball";
  };

  const toggleSound = () => {
    const next = !sndOn;
    setSndOn(next);
    sound.setMuted(!next);
    try {
      localStorage.setItem(MUTE_KEY, next ? "0" : "1");
    } catch {
      // storage blocked — session-only mute
    }
  };

  const run = runState?.run ?? 1;
  const bestDepth = runState?.bestDepth ?? 0;
  // what the miss cost you — no tease when you die on the last rung
  const nextLevel = levelIdx + 1 < LEVELS.length ? LEVELS[levelIdx + 1] : null;

  // the wordle move: a game collapses to one pasteable line
  const shareRun = async () => {
    const made = phase === "beat" ? LEVELS.length : levelIdx;
    const trail = "🏀".repeat(made) + (phase === "beat" ? "" : "✗");
    const text =
      phase === "beat"
        ? `HOOPING game ${run}\n${trail} all ${LEVELS.length} levels, one ball\nhooping.io`
        : `HOOPING game ${run}\n${trail} died on level ${levelIdx + 1}\nhooping.io`;
    // phones get the native share sheet; desktop copies. share() rejects
    // when the user dismisses the sheet — that's a no-op, not a fallback.
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
      try {
        await navigator.share({ text });
      } catch {
        // sheet dismissed
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked — nothing to do
    }
  };

  return (
    <div className="relative flex h-dvh flex-col">
      {/* readout bar — the only chrome above the game: a deep slate blue,
          darker than every sky */}
      <div
        className="flex items-center justify-between border-b pb-2.5 pt-[calc(0.625rem+env(safe-area-inset-top))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]"
        style={{ backgroundColor: "#4a5f7d", borderColor: darken("#4a5f7d", 0.8) }}
      >
        <div className="flex items-baseline gap-4">
          <h1 className="font-display text-base font-semibold text-[#fdfaf2]">Hooping</h1>
          {/* the ladder — made levels in ink, the live one in ball orange */}
          <span className="flex items-center gap-[5px]" aria-hidden>
            {LEVELS.map((l, i) => {
              const made = i < levelIdx || phase === "beat";
              const current = i === levelIdx && phase !== "beat";
              return (
                <span
                  key={l.id}
                  className={`h-3 w-1 rounded-full ${
                    made ? "bg-accent" : current ? "bg-accent-negative" : "bg-[#fdfaf2]/40"
                  }`}
                />
              );
            })}
          </span>
          <span className="font-mono text-xs text-[#fdfaf2]/70 max-sm:hidden">
            {levelIdx + 1} / {LEVELS.length}
          </span>
        </div>
        <div className="flex items-center gap-4 font-mono text-xs text-[#fdfaf2]/70">
          <span>BEST {bestDepth > 0 ? `${bestDepth}/${LEVELS.length}` : "—"}</span>
          <button
            onClick={toggleSound}
            className="flex items-center hover:text-[#fdfaf2]"
            aria-pressed={sndOn}
            aria-label="sound"
          >
            {sndOn ? <Volume2 size={13} aria-hidden /> : <VolumeX size={13} aria-hidden />}
          </button>
        </div>
      </div>


      {/* the game — every remaining pixel. touch-none so Safari can't
          scroll mid-pull; absolute canvas so flex can't fight resize. */}
      <div ref={wrapRef} className="relative min-h-0 flex-1">
        <canvas
          ref={canvasRef}
          style={{ backgroundColor: SKIES[levelIdx] ?? SKIES[SKIES.length - 1] }}
          className="absolute inset-0 h-full w-full cursor-crosshair touch-none select-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={(e) => {
            if (dragRef.current?.id === e.pointerId) dragRef.current = null;
          }}
        />

        {/* the verdict — a real panel, not canvas text. Tap anywhere
            (including the panel) starts the next game; the share button
            stops the tap from advancing. */}
        {(phase === "dead" || phase === "beat") && (
          <div
            className="absolute inset-0 z-10 flex touch-none items-center justify-center bg-[#312d28]/40 animate-[fade-in_0.2s_ease-out_0.1s_both]"
            onPointerDown={advance}
          >
            <div className="flex w-72 max-w-[85%] flex-col items-center gap-4 rounded-2xl border-[3px] border-foreground bg-background px-8 py-7 text-center font-mono shadow-[5px_5px_0_rgba(49,45,40,0.55)] animate-[verdict-in_0.3s_ease-out_0.15s_both]">
              {phase === "dead" ? (
                <>
                  <h2 className="font-display text-3xl font-bold text-accent-negative">
                    Game Over
                  </h2>
                  <p className="text-xs text-muted">
                    died on level {levelIdx + 1}
                    {last ? ` — ${autopsy(last)}` : ""}
                  </p>
                  {nextLevel && (
                    <div className="flex w-full flex-col items-center gap-2 rounded-lg border border-border bg-well px-3 pb-2 pt-3">
                      <p className="label">next up — level {nextLevel.id}</p>
                      <MiniCourt level={nextLevel} />
                      <p className="font-display text-sm font-semibold uppercase tracking-wide">
                        {nextLevel.name}
                      </p>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <h2 className="font-display text-3xl font-bold text-warning">
                    You Beat It
                  </h2>
                  <p className="text-xs text-muted">
                    all {LEVELS.length} levels, one ball, no misses
                  </p>
                </>
              )}
              <p className="text-xs text-muted">
                GAME {run} · BEST {bestDepth}/{LEVELS.length}
              </p>
              <button
                onClick={shareRun}
                onPointerDown={(e) => e.stopPropagation()}
                className="rounded-lg border-2 border-foreground bg-well px-4 py-2 text-xs font-bold text-foreground hover:bg-hover-bg"
              >
                {copied ? "copied" : "share result"}
              </button>
              <p className="animate-pulse text-[11px] text-muted">
                tap anywhere to play again
              </p>
            </div>
          </div>
        )}
      </div>

      {/* status line — sits on the grass, continuing the canvas ground to
          the viewport bottom, so everything on it reads in white */}
      <div
        className="flex min-h-10 items-center justify-between gap-4 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] font-mono text-xs text-[#fdfaf2]"
        style={{ backgroundColor: THEME.grass }}
      >
        {phase === "cleared" ? (
          <span>level {levelIdx + 1} down</span>
        ) : phase === "beat" ? (
          <span>all {LEVELS.length} cleared, one ball</span>
        ) : phase === "dead" && last ? (
          <span>{autopsy(last)}</span>
        ) : phase === "flying" ? (
          <span>…</span>
        ) : (
          // the drag lesson lives on the canvas, next to the ball —
          // this line states the stakes instead of repeating it
          <span>one shot per level. a miss ends the game.</span>
        )}
        <span className="flex shrink-0 items-center gap-3 max-sm:hidden">
          <span>
            <Kbd>drag</Kbd> shoot
          </span>
          <span>
            <Kbd>space</Kbd> replay
          </span>
        </span>
      </div>
    </div>
  );
}

