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
  type Shooter,
  type Touch,
} from "@/lib/hoop";
import { createSpring } from "@/lib/spring";
import * as sound from "@/lib/sound";

// Layout is the Doodle Jump deal: one thin readout bar, one thin status
// line, and every other pixel is the game. The hand-touched detail lives
// inside the world — the notebook-grid gym floor, the level number
// painted at center court, the pixel creature — not in chrome around it.

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded-[3px] border border-border bg-well px-1 py-px font-mono text-[10px] text-foreground">
      {children}
    </kbd>
  );
}

const PAPER = "#eceae0";
const ORANGE = "#d45a2b";
const YELLOW = "#ffffc9";
const MUTED = "#7b7e8a";
// the creature's own colors travel with him
const BODY = "#3a3f4a";
const PATCH = "#555b68";
const FACE = "#9aa0ab"; // light face on dark fur — the two-tone is the charm
const HEADBAND = "#418ecd";
const EYES = "#30343c"; // dark features on the light face, like the reference

const CANVAS_FONT = "10px ui-monospace, Menlo, monospace";

// the creature, 13×14 — taller than wide, like the reference: a round
// furry head with jagged cheek tufts, then a narrower body bean, tiny
// feet. # = fur, f = face. Expressions overlaid per-pose in drawCreature.
const CREATURE_PIX = [
  "....#####....",
  "..#########..",
  ".###########.",
  ".###fffff###.",
  "###fffffff###",
  ".##fffffff##.",
  "###fffffff###",
  ".###fffff###.",
  "..##fffff##..",
  "...#######...",
  "...#######...",
  "...#######...",
  "....#####....",
  "....##.##....",
];

// the ball, 9×9: o = leather, S = seam (vertical + horizontal + side arcs)
const BALL_PIX = [
  "..ooSoo..",
  ".oooSooo.",
  "ooSoSoSoo",
  "oSooSooSo",
  "SSSSSSSSS",
  "oSooSooSo",
  "ooSoSoSoo",
  ".oooSooo.",
  "..ooSoo..",
];

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
type Pose = "aim" | "watch" | "panic" | "joy" | "triumph" | "sad";

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
  const dragRef = useRef<{ sx: number; sy: number; dx: number; dy: number } | null>(null);
  const trailRef = useRef<{ x: number; y: number }[]>([]);
  const sparksRef = useRef<Spark[]>([]);
  const seenTouchesRef = useRef(0);
  const lastRimAtRef = useRef(-Infinity); // panic window
  const madeRef = useRef(false);
  const bestDepthRef = useRef(0); // gates the new-deepest fanfare
  const eventAtRef = useRef(-Infinity); // joy hop / sad flinch clock
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

  // mount: load the run (localStorage is client-only, defer past paint)
  useEffect(() => {
    const t = setTimeout(() => {
      const s = loadRun();
      bestDepthRef.current = s.bestDepth;
      runRef.current = s.run;
      setRunState(s);
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const resetForAim = () => {
    shotRef.current = null;
    trailRef.current = [];
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
          color: ORANGE,
        };
      }
      sound.plunk(); // the run dies with a low dead thud
      navigator.vibrate?.(60);
      eventAtRef.current = performance.now() / 1000;
      setPhaseBoth("dead");
    }
  }, [setPhaseBoth]);

  // --- the creature — drawn from CREATURE_PIX, expressions overlaid ---
  const drawCreature = (
    ctx: CanvasRenderingContext2D,
    feetX: number,
    floorY: number,
    k: number,
    pose: Pose,
    now: number,
  ) => {
    const joyish = pose === "joy" || pose === "triumph";
    const age = now - eventAtRef.current;
    let dy = 0;
    let dx = 0;
    if (joyish) dy = age < 0.64 ? [-1, 0, -1, 0][Math.floor(age / 0.16)] : 0;
    else if (pose === "sad") dy = age < 0.24 ? 1 : 0;
    else if (pose === "aim" && dragRef.current) dy = 1; // crouch into the pull
    else dy = Math.floor(now / 0.82) % 2 ? 1 : 0; // idle bob
    if (pose === "panic") dx = Math.floor(now / 0.09) % 2 ? 1 : -1; // tremble

    // integer origin — fractional coords leave antialiasing seams between
    // the cells that read as thin lines through the sprite
    const ox = Math.round(feetX - 6.5 * k) + dx * k;
    const oy = Math.round(floorY - 14 * k) + dy * k;
    const px = (x: number, y: number, w: number, h: number, c: string) => {
      ctx.fillStyle = c;
      ctx.fillRect(ox + x * k, oy + y * k, w * k, h * k);
    };

    const flail = Math.floor(now / 0.14) % 2 === 0;
    const blink = (now * 1000) % 3800 > 3560;

    // marks above the head
    if (pose === "sad") {
      px(11, -3, 1, 2, ORANGE); // the !
      px(11, 0, 1, 1, ORANGE);
    }
    if (pose === "panic") {
      if (flail) px(1, -1, 1, 1, PAPER);
      else px(11, -2, 1, 1, PAPER); // sweat
    }
    if (joyish) {
      // plus-star sparkles, alternating beats
      const tw = Math.floor(now / 0.55) % 2 === 0;
      const star = (x: number, y: number) => {
        px(x, y - 1, 1, 1, PAPER);
        px(x - 1, y, 3, 1, PAPER);
        px(x, y + 1, 1, 1, PAPER);
      };
      if (tw) star(1, -2);
      else star(11, -3);
    }
    if (pose === "triumph") {
      // the crown — all six, one ball
      px(5, -2, 1, 1, YELLOW);
      px(7, -2, 1, 1, YELLOW);
      px(5, -1, 3, 1, YELLOW);
    }

    // the body — fur around the light face
    for (let row = 0; row < CREATURE_PIX.length; row++) {
      const line = CREATURE_PIX[row];
      for (let col = 0; col < line.length; col++) {
        const c = line[col];
        if (c === ".") continue;
        px(col, row, 1, 1, c === "f" ? FACE : BODY);
      }
    }
    px(3, 1, 7, 1, HEADBAND); // the headband — he came to hoop

    // eyes — small and dark, a clear row above the mouth
    if (pose === "panic") {
      px(3, 4, 2, 2, EYES); // wide
      px(8, 4, 2, 2, EYES);
    } else if (pose === "sad") {
      px(4, 4, 1, 1, ORANGE);
      px(8, 4, 1, 1, ORANGE);
    } else if (!blink) {
      const look = pose === "watch" ? 1 : 0; // eyes on the ball
      px(4 + look, 4, 1, 1, EYES);
      px(8 + look, 4, 1, 1, EYES);
    }
    // mouth — he smiles by default
    if (joyish) {
      px(4, 6, 1, 1, EYES);
      px(8, 6, 1, 1, EYES);
      px(5, 7, 3, 1, EYES); // the big open grin
    } else if (pose === "sad") {
      px(6, 6, 1, 1, EYES);
      px(5, 7, 1, 1, EYES);
      px(7, 7, 1, 1, EYES); // upside-down
    } else if (pose === "panic") {
      px(6, 6, 1, 2, EYES); // mouth open
    } else {
      // the smirk — off-center toward the hoop, one corner up. locked in.
      px(5, 7, 2, 1, EYES);
      px(7, 6, 1, 1, EYES);
    }
  };

  // --- the rAF loop ---
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d")!;

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
      // desktops both give the game everything they have
      const scale = Math.min(W / level.w, (H - 24) / level.h);
      const ox = (W - level.w * scale) / 2;
      // wide screens pin the floor near the bottom; tall screens center
      // the court so sky and floor split the leftover instead of the
      // hoop sinking to the bottom of a portrait phone
      const floorY = Math.min(H - 10, (H + level.h * scale) / 2);
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
        shot.step(slow ? dt * 0.35 : dt);
        const s = shot.state;
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
            sparksRef.current.push({ x: t.x, y: t.y, at: now, color: ORANGE });
          } else if (t.kind === "board" || t.kind === "wall") {
            sound.board(t.speed);
            sparksRef.current.push({ x: t.x, y: t.y, at: now, color: PAPER });
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
              color: [ORANGE, PAPER, YELLOW][i % 3],
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

      // the rafters — one pennant per level you've ever cleared, hung
      // top-right like a small gym's banner wall. The trophy case is the
      // world, not a stat readout.
      for (let i = 0; i < bestDepthRef.current; i++) {
        const fx = W - 26 - i * 22;
        ctx.strokeStyle = "#2a2d35";
        ctx.beginPath();
        ctx.moveTo(fx, 0);
        ctx.lineTo(fx, 7);
        ctx.stroke();
        ctx.fillStyle = [PAPER, ORANGE, YELLOW][i % 3];
        ctx.globalAlpha = 0.75;
        ctx.beginPath();
        ctx.moveTo(fx - 5, 7);
        ctx.lineTo(fx + 5, 7);
        ctx.lineTo(fx, 22);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // floor
      ctx.strokeStyle = "#474b56";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, floorY);
      ctx.lineTo(W, floorY);
      ctx.stroke();
      ctx.fillStyle = "#14161b";
      ctx.fillRect(0, floorY + 1, W, H - floorY - 1);
      // parquet — plank seams with staggered joints on the floor's face.
      // On tall screens the court centers and this face grows, so it has
      // to look like wood, not dead fill.
      ctx.strokeStyle = "#191c22";
      ctx.beginPath();
      let rowIdx = 0;
      for (let py = floorY + 9; py < H; py += 9, rowIdx++) {
        ctx.moveTo(0, py);
        ctx.lineTo(W, py);
        const off = rowIdx % 2 ? 44 : 0;
        for (let jx = off + ((ox % 88) - 88); jx < W; jx += 88) {
          ctx.moveTo(jx, py - 9 + 2);
          ctx.lineTo(jx, py - 2);
        }
      }
      ctx.stroke();
      // surveyor's ticks — one per meter along the floor, the court's
      // ends a touch taller. The world is measured, and shows it.
      ctx.strokeStyle = "#2a2d35";
      ctx.beginPath();
      for (let m = 0; m <= level.w; m++) {
        const tx = sx(m);
        const tall = m === 0 || m === level.w ? 7 : 3;
        ctx.moveTo(tx, floorY);
        ctx.lineTo(tx, floorY - tall);
      }
      ctx.stroke();

      // the hoop: glass, mount, iron, net
      const rimY = sy(level.rim.y);
      const frontX = sx(level.rim.x);
      const backX = sx(level.rim.x + RIM_GAP);
      const boardX = sx(level.rim.x + RIM_GAP + BOARD_OFF);
      if (level.board) {
        const bTop = sy(level.rim.y + BOARD_H);
        const bBot = sy(level.rim.y - 0.05);
        // the pole — hoops stand on something
        ctx.strokeStyle = "#2a2d35";
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(boardX + 3, bTop + 8);
        ctx.lineTo(boardX + 3, floorY);
        ctx.stroke();
        // glass with a body, not a wire
        ctx.fillStyle = PAPER;
        ctx.globalAlpha = 0.1;
        ctx.fillRect(boardX, bTop, 4, bBot - bTop);
        ctx.globalAlpha = 0.8;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(boardX, bBot);
        ctx.lineTo(boardX, bTop);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1;
        ctx.strokeStyle = MUTED; // mount
        ctx.beginPath();
        ctx.moveTo(backX, rimY);
        ctx.lineTo(boardX, rimY);
        ctx.stroke();
      }
      // the iron — flashes yellow the instant a make drops through
      const ironC =
        madeRef.current && now - eventAtRef.current < 0.25 ? YELLOW : ORANGE;
      ctx.strokeStyle = ironC;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(frontX, rimY);
      ctx.lineTo(backX, rimY);
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = ironC;
      ctx.beginPath();
      ctx.arc(frontX, rimY, 2.5, 0, Math.PI * 2);
      ctx.arc(backX, rimY, 2.5, 0, Math.PI * 2);
      ctx.fill();
      // net — three converging dashes
      ctx.strokeStyle = PAPER;
      ctx.globalAlpha = 0.35;
      ctx.setLineDash([2, 3]);
      const netB = sy(level.rim.y - 0.35);
      for (const [t0, t1] of [
        [0.06, 0.16],
        [0.5, 0.5],
        [0.94, 0.84],
      ] as const) {
        ctx.beginPath();
        ctx.moveTo(frontX + (backX - frontX) * t0, rimY);
        ctx.lineTo(frontX + (backX - frontX) * t1, netB);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      // obstacle walls — solid slabs, not blueprint lines
      ctx.strokeStyle = PATCH;
      ctx.lineWidth = 7;
      for (const wl of level.walls) {
        ctx.beginPath();
        ctx.moveTo(sx(wl.x1), sy(wl.y1));
        ctx.lineTo(sx(wl.x2), sy(wl.y2));
        ctx.stroke();
      }
      ctx.lineWidth = 1;

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

      // ball trail — the comet
      if (trailRef.current.length > 1 && ph !== "aim") {
        ctx.strokeStyle = ORANGE;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.35;
        ctx.beginPath();
        trailRef.current.forEach((p, i) => {
          if (i === 0) ctx.moveTo(sx(p.x), sy(p.y));
          else ctx.lineTo(sx(p.x), sy(p.y));
        });
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1;
      }

      // the ball — pixel art like the creature: 9×9 grid, orange with
      // dark seams (cross + side arcs)
      const drawBall = (bx: number, by: number) => {
        const r = Math.max(4, BALL_R * scale);
        const bk = Math.max(1, Math.round((2 * r) / 9)); // pixel size
        // integer origin — fractional coords leave antialiasing seams
        const x0 = Math.round(bx - 4.5 * bk);
        const y0 = Math.round(by - 4.5 * bk);
        for (let row = 0; row < 9; row++) {
          const line = BALL_PIX[row];
          for (let col = 0; col < 9; col++) {
            const c = line[col];
            if (c === ".") continue;
            ctx.fillStyle = c === "S" ? "#8f3a1a" : ORANGE;
            ctx.fillRect(x0 + col * bk, y0 + row * bk, bk, bk);
          }
        }
      };

      if (ph === "flying" && shot && !shot.state.done) {
        drawBall(sx(shot.state.x), sy(shot.state.y));
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
          // the arrow heats up with power
          ctx.strokeStyle = p01 > 0.6 ? ORANGE : PAPER;
          ctx.lineWidth = 2;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(bx, by);
          ctx.lineTo(bx + Math.cos(rad) * len, by - Math.sin(rad) * len);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.lineWidth = 1;
          // power bar — no units, just how hard
          ctx.fillStyle = "#2a2d35";
          ctx.fillRect(bx - 17, by + 14, 34, 5);
          ctx.fillStyle = p01 >= 0.999 ? YELLOW : ORANGE;
          ctx.fillRect(bx - 16, by + 15, 32 * p01, 3);
          // training wheels: until the first-ever bucket, level 1 shows
          // the opening beat of the true arc — deterministic physics keeps
          // it honest. Gone forever after the first make.
          if (bestDepthRef.current === 0 && levelIdxRef.current === 0) {
            const ghost = createShot(level, aim.p, aim.a);
            ctx.fillStyle = PAPER;
            ctx.globalAlpha = 0.3;
            for (let i = 0; i < 6; i++) {
              ghost.step(0.055);
              ctx.fillRect(sx(ghost.state.x) - 1.5, sy(ghost.state.y) - 1.5, 3, 3);
            }
            ctx.globalAlpha = 1;
          }
        } else if (bestDepthRef.current === 0 && levelIdxRef.current === 0) {
          // first-timer: nothing on screen explains the gesture — this does
          ctx.fillStyle = PAPER;
          ctx.globalAlpha = 0.55 + 0.3 * Math.sin(now * 3);
          ctx.fillText("drag back anywhere — let go to shoot", bx + 16, by - 16);
          ctx.globalAlpha = 1;
        }
      }

      // the creature — drawn last so no line ever crosses him.
      // pose derived, never stored
      const pose: Pose =
        ph === "beat"
          ? "triumph"
          : madeRef.current
            ? "joy"
            : ph === "dead"
              ? "sad"
              : ph === "aim" || ph === "enter"
                ? "aim"
                : now - lastRimAtRef.current < 0.9
                  ? "panic"
                  : "watch";
      // small on purpose — he's a little guy in a big gym (~0.65m tall)
      const k = Math.max(2, Math.round((scale * 0.65) / 14));
      drawCreature(ctx, sx(level.launch.x), floorY, k, pose, now);

      // the shot-name pop — SWISH / BANK! / RATTLED IN / OFF THE WALL
      const pop = popRef.current;
      if (pop) {
        const a = now - pop.at;
        if (a > 0.95) popRef.current = null;
        else {
          const size = Math.round(28 - 9 * Math.min(a / 0.12, 1)); // slams in
          ctx.font = `700 ${size}px ui-monospace, Menlo, monospace`;
          ctx.textAlign = "center";
          ctx.fillStyle = pop.color;
          ctx.globalAlpha = a < 0.55 ? 1 : 1 - (a - 0.55) / 0.4;
          ctx.fillText(pop.text, sx(level.rim.x + RIM_GAP / 2), sy(level.rim.y + 0.7) - a * 18);
          ctx.globalAlpha = 1;
          ctx.textAlign = "left";
          ctx.font = CANVAS_FONT;
        }
      }

      // --- overlay cards: verdicts and the level intro, faded not cut ---
      const tp = now - phaseAtRef.current;
      if (ph === "enter" && tp < 0.25) {
        // the new level fades up from the shell — no hard cut
        ctx.fillStyle = "#111318";
        ctx.globalAlpha = 1 - tp / 0.25;
        ctx.fillRect(0, 0, W, H);
        ctx.globalAlpha = 1;
      }
      if (ph === "dead" && tp < 0.25) {
        // the sting — one orange blink when the run dies
        ctx.fillStyle = ORANGE;
        ctx.globalAlpha = 0.12 * (1 - tp / 0.25);
        ctx.fillRect(0, 0, W, H);
        ctx.globalAlpha = 1;
      }
      const card = (main: string, sub: string, color: string) => {
        const f = Math.min(1, tp / 0.18);
        const cy = H * 0.3 - (1 - f) * 8; // drifts up as it fades in
        ctx.globalAlpha = f;
        ctx.textAlign = "center";
        ctx.font = "700 20px ui-monospace, Menlo, monospace";
        ctx.fillStyle = color;
        ctx.fillText(main, W / 2, cy);
        ctx.font = CANVAS_FONT;
        ctx.fillStyle = MUTED;
        ctx.fillText(sub, W / 2, cy + 18);
        ctx.textAlign = "left";
        ctx.globalAlpha = 1;
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
        // level 6 is match point — it should feel like it
        const lastOne = level.id === LEVELS.length;
        card(
          lastOne ? "THE LAST SHOT" : `LEVEL ${level.id}`,
          lastOne ? `level ${level.id} — game ${run}` : `game ${run}`,
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
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { sx: e.clientX, sy: e.clientY, dx: e.clientX, dy: e.clientY };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    d.dx = e.clientX;
    d.dy = e.clientY;
  };

  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || phaseRef.current !== "aim") return;
    const pull = Math.hypot(d.dx - d.sx, d.dy - d.sy);
    if (pull < 10) return; // no free throws — a tap is not a shot
    shoot(aimFromDrag(d));
  };

  // Space = the exact same pull again. Deterministic physics makes this an
  // instant replay of the aim — the proof there's no dice in the machine.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
  };

  const run = runState?.run ?? 1;
  const bestDepth = runState?.bestDepth ?? 0;

  // the wordle move: a game collapses to one pasteable line
  const shareRun = async () => {
    const made = phase === "beat" ? LEVELS.length : levelIdx;
    const trail = "🏀".repeat(made) + (phase === "beat" ? "" : "✗");
    const text =
      phase === "beat"
        ? `HOOPING game ${run}\n${trail} all ${LEVELS.length} levels, one ball\nhooping.io`
        : `HOOPING game ${run}\n${trail} died on level ${levelIdx + 1}\nhooping.io`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked — nothing to do
    }
  };

  return (
    <div className="flex h-dvh flex-col">
      {/* readout bar — the only chrome above the game */}
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5 sm:px-5">
        <div className="flex items-baseline gap-4">
          <h1 className="font-mono text-sm tracking-tight text-header-text">Hooping</h1>
          {/* the ladder — made levels in ink, the live one in ball orange */}
          <span className="flex items-center gap-[5px]" aria-hidden>
            {LEVELS.map((l, i) => {
              const made = i < levelIdx || phase === "beat";
              const current = i === levelIdx && phase !== "beat";
              return (
                <span
                  key={l.id}
                  className={`h-3 w-[3px] ${
                    made ? "bg-accent" : current ? "bg-accent-negative" : "bg-border"
                  }`}
                />
              );
            })}
          </span>
          <span className="font-mono text-xs text-muted max-sm:hidden">
            {levelIdx + 1} / {LEVELS.length}
          </span>
        </div>
        <div className="flex items-center gap-4 font-mono text-xs text-muted">
          <span>GAME {run}</span>
          <span>BEST {bestDepth > 0 ? `${bestDepth}/${LEVELS.length}` : "—"}</span>
          <button
            onClick={toggleSound}
            className="flex items-center hover:text-foreground"
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
          className="absolute inset-0 h-full w-full cursor-crosshair touch-none select-none bg-[#111318]"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (dragRef.current = null)}
        />

        {/* the verdict — a real panel, not canvas text. Tap anywhere
            (including the panel) starts the next game; the share button
            stops the tap from advancing. */}
        {(phase === "dead" || phase === "beat") && (
          <div
            className="absolute inset-0 z-10 flex touch-none items-center justify-center bg-[#101216]/70 animate-[fade-in_0.2s_ease-out_0.1s_both]"
            onPointerDown={advance}
          >
            <div className="flex w-72 max-w-[85%] flex-col items-center gap-4 border border-border bg-[#14161b] px-8 py-7 text-center font-mono animate-[verdict-in_0.3s_ease-out_0.15s_both]">
              {phase === "dead" ? (
                <>
                  <h2 className="text-2xl font-bold tracking-tight text-accent-negative">
                    GAME OVER
                  </h2>
                  <p className="text-xs text-muted">
                    died on level {levelIdx + 1}
                    {last ? ` — ${autopsy(last)}` : ""}
                  </p>
                </>
              ) : (
                <>
                  <h2 className="text-2xl font-bold tracking-tight text-warning">
                    YOU BEAT IT
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
                className="border border-border bg-well px-4 py-2 text-xs text-foreground hover:bg-hover-bg"
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

      {/* status line — verdicts on the left, the controls truth on the right */}
      <div className="flex min-h-10 items-center justify-between gap-4 border-t border-border px-4 py-2 font-mono text-xs sm:px-5">
        {phase === "cleared" ? (
          <span className="text-accent">level {levelIdx + 1} down</span>
        ) : phase === "beat" ? (
          <span className="text-accent">all {LEVELS.length} cleared, one ball</span>
        ) : phase === "dead" && last ? (
          <span className="text-accent-negative">{autopsy(last)}</span>
        ) : phase === "flying" ? (
          <span className="text-muted">…</span>
        ) : (
          // the drag lesson lives on the canvas, next to the ball —
          // this line states the stakes instead of repeating it
          <span className="text-muted">one shot per level. a miss ends the game.</span>
        )}
        <span className="flex shrink-0 items-center gap-3 text-muted max-sm:hidden">
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

