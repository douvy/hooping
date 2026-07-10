"use client";

// The run. One shot per level; miss and the run dies back to level 1.
// Deterministic physics means every level has a fixed, learnable answer —
// a run is executing six memorized shots without a motor error, so the
// only dice in the machine are your hands (verified: scripts/gauntlet.mjs).
// The creature narrates: squints while you aim, panics while the ball
// rattles on the iron, hops when it drops, wears the crown when you
// clear all six, and the red ! when the run dies.

import { useCallback, useEffect, useRef, useState } from "react";
import { track } from "@vercel/analytics";
import { Check, Share2, Volume2, VolumeX } from "lucide-react";
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
import {
  describeMiss,
  isBucketMilestone,
  parseRun,
  showGestureHint,
  type RunState,
} from "@/lib/run";
import { createSpring } from "@/lib/spring";
import * as sound from "@/lib/sound";
import { SKIES, THEME, darken, mix, saturate, withAlpha } from "@/lib/theme";

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

// The career odometer — holds at the pre-run total while the pips
// stamp, then rolls this run's deposits in. body has tabular-nums,
// so the roll doesn't jitter the line.
function CountUp({ from, to, delayMs }: { from: number; to: number; delayMs: number }) {
  // initial state is already `to` when there's nothing to roll
  const [v, setV] = useState(Math.min(from, to));
  useEffect(() => {
    if (from >= to) return;
    let raf = 0;
    const timer = setTimeout(() => {
      const t0 = performance.now();
      const dur = 500;
      const tick = (now: number) => {
        const p = Math.min(1, (now - t0) / dur);
        setV(Math.round(from + (to - from) * (1 - (1 - p) ** 3)));
        if (p < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }, delayMs);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
  }, [from, to, delayMs]);
  return <>{v}</>;
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

// ——— the backdrop, shared by the live canvas and the share card ———
// Module-level painters: everything is deterministic off hash01 plus a
// clock, so the poster can freeze any moment of the same world.

// scale unit — the skyline furniture is hand-tuned against ~520px of
// sky, then scales for tablets and the 1080px card
function skyU(floorY: number): number {
  return Math.max(0.8, Math.min(2.2, floorY / 520));
}

// the sun and the moon — the sky's clock hands. No sun at midday
// (levels 1-2): overhead light isn't in frame, and a sticker sun on a
// bright sky is clip art. It enters at golden hour, already big and
// dropping, and sinks into the skyline as the levels climb — the
// swollen level-4 sunset is the reward. Once it's under, a paper
// crescent takes the other shoulder of the sky.
function drawCelestials(
  ctx: CanvasRenderingContext2D,
  W: number,
  floorY: number,
  sky: string,
  night: number,
  now: number,
) {
  if (night >= 0.15 && night < 0.62) {
    const sunX = W * 0.76;
    const sunY = floorY * (0.16 + night * 1.5);
    const r = floorY * (0.075 + night * 0.15);
    // the halo breathes slowly — alive, not blinking
    ctx.fillStyle = withAlpha(THEME.gold, "26");
    ctx.beginPath();
    ctx.arc(sunX, sunY, r * (1.45 + 0.05 * Math.sin(now * 0.5)), 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = THEME.gold;
    ctx.beginPath();
    ctx.arc(sunX, sunY, r, 0, Math.PI * 2);
    ctx.fill();
  }
  if (night > 0.55) {
    const mx = W * 0.22;
    const my = floorY * 0.16;
    const r = floorY * 0.07;
    const a = Math.min(1, (night - 0.55) / 0.25);
    ctx.fillStyle = THEME.paper;
    ctx.globalAlpha = 0.12 * a;
    ctx.beginPath();
    ctx.arc(mx, my, r * 1.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = a;
    ctx.beginPath();
    ctx.arc(mx, my, r, 0, Math.PI * 2);
    ctx.fill();
    // the bite — a sky-colored disc clipped to the moon, so the halo
    // can't ring the crescent's hollow
    ctx.save();
    ctx.beginPath();
    ctx.arc(mx, my, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = sky;
    ctx.beginPath();
    ctx.arc(mx + r * 0.45, my - r * 0.2, r * 0.82, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;
  }
}

// the city's daylight paint — Koriko rules: facades own their color
// (cream, brick, rose, ochre) and the roofs answer in verdigris, slate,
// and dusk brick. Ambient light does the rest.
const FACADES = ["#ead9b0", "#bd6b52", "#cf9282", "#dda75c"] as const;
const ROOFS = ["#74a898", "#5c6674", "#a05545"] as const;

// the city — the Kiki's Delivery Service move translated to flat
// side-view: two hazy silhouette layers for distance, then a painted
// row of houses up front with real facade colors, pitched roofs,
// chimneys with paper steam, and one clock tower over the roofline
// whose clock tells the run's hour — 4pm at level 1, midnight at the
// keyhole. Every color is mixed toward the sky and dimmed with night,
// so the same brick street reads afternoon-warm at four and plum after
// dark. Windows are dark by day and light one by one as night comes on
// — the same window hash every visit, so the city fills in rather than
// reshuffles. party (the beat screen and its card) turns nearly every
// window on.
function drawSkyline(
  ctx: CanvasRenderingContext2D,
  W: number,
  floorY: number,
  sky: string,
  night: number,
  now: number,
  opts: { party?: boolean; hScale?: number } = {},
) {
  const u = skyU(floorY);
  const hS = opts.hScale ?? 1;
  const party = opts.party ?? false;
  // ambient — paint leans toward the sky, then loses light with night
  const amb = (c: string) => darken(mix(c, sky, 0.28 + 0.3 * night), 1 - 0.38 * night);
  const litFrac = party ? 0.92 : night <= 0.12 ? 0 : 0.08 + 0.4 * night;
  const lampA = Math.min(1, 0.35 + night) * 0.9;

  // horizon haze — two paler strips of the same sky; the far towers
  // stand in them and the flat backdrop reads ten more miles deep
  ctx.fillStyle = darken(sky, 1.05);
  ctx.fillRect(0, floorY - floorY * 0.3 * hS, W, floorY * 0.3 * hS);
  ctx.fillStyle = darken(sky, 1.11);
  ctx.fillRect(0, floorY - floorY * 0.14 * hS, W, floorY * 0.14 * hS);

  // ——— distance: two silhouette layers, saturate-then-darken so the
  // haze keeps the sky's hue instead of going gray ———
  let masts = 0;
  for (const [sat, f, hMin, hMax, wMin, wVar, gapMul, seed, detail] of [
    [1.25, 0.92, 0.3, 0.72, 26, 64, 1.35, 500, false], // far — pale, thin, spaced
    [1.45, 0.8, 0.18, 0.6, 44, 130, 1, 700, true], // back
  ] as const) {
    const bc = darken(saturate(sky, sat), f);
    ctx.fillStyle = bc;
    for (let bx = -30 * u - seed * 0.01, bi = 0; bx < W; bi++) {
      const bw = (wMin + hash01(seed + bi * 3 + 1) * wVar) * u;
      const bh = (hMin + hash01(seed + bi * 3 + 2) * (hMax - hMin)) * floorY * hS;
      const roof = hash01(seed + bi * 3 + 3);
      const top = floorY - bh;
      const cr = Math.min(12 * u, bw * 0.15);
      ctx.beginPath();
      ctx.roundRect(bx, top, bw, bh, [cr, cr, 0, 0]);
      if (roof < 0.16) {
        // the knob — a small rounded nub off one shoulder
        ctx.roundRect(bx + bw * 0.14, top - 9 * u, 16 * u, 14 * u, 5 * u);
      }
      ctx.fill();

      // roofline furniture, silhouette-colored — same paper cut
      if (detail && roof >= 0.16) {
        const fx = bx + bw * (0.24 + hash01(seed + bi * 3 + 5) * 0.4);
        if (roof < 0.26 && bw > 80 * u) {
          // water tank — legs, drum, conical lid
          ctx.beginPath();
          ctx.rect(fx - 8 * u, top - 8 * u, 3 * u, 9 * u);
          ctx.rect(fx + 5 * u, top - 8 * u, 3 * u, 9 * u);
          ctx.roundRect(fx - 10.5 * u, top - 22 * u, 21 * u, 15 * u, 2 * u);
          ctx.moveTo(fx - 10.5 * u, top - 21 * u);
          ctx.lineTo(fx, top - 28 * u);
          ctx.lineTo(fx + 10.5 * u, top - 21 * u);
          ctx.closePath();
          ctx.fill();
        } else if (roof >= 0.26 && roof < 0.36) {
          // stair bulkhead
          ctx.beginPath();
          ctx.roundRect(fx - 12 * u, top - 11 * u, 24 * u, 12 * u, [3 * u, 3 * u, 0, 0]);
          ctx.fill();
        } else if (roof >= 0.36 && roof < 0.46 && masts < 2) {
          // radio mast — its beacon pulses once the sky is dark enough
          // to need warning
          masts++;
          ctx.fillRect(fx - 1.5 * u, top - 26 * u, 3 * u, 27 * u);
          if (night > 0.3 || party) {
            const pulse = party ? 1 : 0.5 + 0.5 * Math.sin(now * 2.4 + bi);
            ctx.globalAlpha = 0.35 + 0.65 * pulse;
            ctx.fillStyle = THEME.rim;
            ctx.beginPath();
            ctx.arc(fx, top - 27 * u, 3 * u, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.fillStyle = bc;
          }
        }
      }

      // lit windows on the silhouettes — sparse grid, night only
      if (detail && litFrac > 0) {
        const cols = Math.min(8, Math.floor((bw - 8 * u) / (13 * u)));
        const rows = Math.min(6, Math.floor((bh - 12 * u) / (16 * u)));
        if (cols > 0 && rows > 0) {
          const gx0 = bx + (bw - cols * 13 * u) / 2 + 4.5 * u;
          ctx.fillStyle = THEME.lamp;
          ctx.globalAlpha = lampA * 0.55;
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              if (hash01(seed + bi * 173 + r * 31 + c * 7) >= litFrac * 0.7) continue;
              ctx.fillRect(gx0 + c * 13 * u, top + 8 * u + r * 16 * u, 4 * u, 5 * u);
            }
          }
          ctx.globalAlpha = 1;
          ctx.fillStyle = bc;
        }
      }

      // overlap or gap, hung by eye — unions within a layer read as
      // one silhouette, gaps show the layer behind. A sliver gap reads
      // as a seam, not a gap — too-thin gaps widen to a readable one.
      let nx = bx + bw * (0.72 + hash01(seed + bi * 3 + 4) * 0.55) * gapMul;
      const gap = nx - (bx + bw);
      if (gap > 0 && gap < 20 * u) nx = bx + bw + 20 * u;
      bx = nx;
    }
  }

  // ——— the clock tower — one landmark, risen behind the front row.
  // Its clock keeps the ladder's time: NIGHT maps to 4pm..midnight. ———
  {
    const tx = W * 0.3;
    const tw = 30 * u;
    const th = floorY * 0.58 * hS;
    const top = floorY - th;
    const body = amb("#c8a678");
    ctx.fillStyle = body;
    ctx.fillRect(tx - tw / 2, top, tw, th);
    // a shaded edge so the shaft reads round-ish, not a plank
    ctx.fillStyle = darken(body, 0.85);
    ctx.fillRect(tx + tw / 2 - 5 * u, top, 5 * u, th);
    // the clock head — slightly proud of the shaft
    const hw = tw + 8 * u;
    ctx.fillStyle = body;
    ctx.fillRect(tx - hw / 2, top, hw, 34 * u);
    ctx.fillStyle = darken(body, 0.8);
    ctx.fillRect(tx - hw / 2, top + 34 * u, hw, 3 * u);
    // verdigris cap and spire, mustard finial
    const cap = amb(ROOFS[0]);
    ctx.fillStyle = cap;
    ctx.beginPath();
    ctx.moveTo(tx - hw / 2 - 2 * u, top);
    ctx.lineTo(tx + hw / 2 + 2 * u, top);
    ctx.lineTo(tx + 4 * u, top - 22 * u);
    ctx.lineTo(tx - 4 * u, top - 22 * u);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(tx - 1.5 * u, top - 32 * u, 3 * u, 11 * u);
    ctx.fillStyle = THEME.ball;
    ctx.beginPath();
    ctx.arc(tx, top - 33 * u, 3 * u, 0, Math.PI * 2);
    ctx.fill();
    // the face — paper under the same light, hands telling the level's
    // hour. Lit from inside once the city needs it.
    const fy = top + 17 * u;
    const fr = 11 * u;
    ctx.fillStyle = night > 0.45 || party ? THEME.lamp : amb(THEME.paper);
    ctx.beginPath();
    ctx.arc(tx, fy, fr, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = darken(body, 0.7);
    ctx.lineWidth = 2 * u;
    ctx.stroke();
    const hour = 16 + 8 * night; // the ladder's clock
    const ha = ((hour % 12) / 12) * Math.PI * 2 - Math.PI / 2;
    const ma = (hour % 1) * Math.PI * 2 - Math.PI / 2;
    ctx.strokeStyle = THEME.outline;
    ctx.lineWidth = 1.8 * u;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(tx, fy);
    ctx.lineTo(tx + Math.cos(ha) * fr * 0.5, fy + Math.sin(ha) * fr * 0.5);
    ctx.moveTo(tx, fy);
    ctx.lineTo(tx + Math.cos(ma) * fr * 0.78, fy + Math.sin(ma) * fr * 0.78);
    ctx.stroke();
    ctx.lineCap = "butt";
    ctx.lineWidth = 1;
    // slim shaft windows below the face
    ctx.fillStyle = darken(body, 0.62);
    for (let r = 0; r < 3; r++) {
      const wy = fy + fr + (14 + r * 24) * u;
      if (wy > floorY - 20 * u) break;
      ctx.fillRect(tx - 7 * u, wy, 4 * u, 8 * u);
      ctx.fillRect(tx + 3 * u, wy, 4 * u, 8 * u);
    }
  }

  // ——— the front row — painted houses, Koriko rules ———
  let billboard = false;
  let steams = 0;
  const seed = 900;
  for (let bx = -24 * u, bi = 0; bx < W; bi++) {
    const bw = (54 + hash01(seed + bi * 3 + 1) * 76) * u;
    const wh = (0.07 + hash01(seed + bi * 3 + 2) * 0.19) * floorY * hS;
    const roof = hash01(seed + bi * 3 + 3);
    const top = floorY - wh;
    const fc = amb(FACADES[Math.floor(hash01(seed + bi * 5 + 8) * FACADES.length)]);
    const rc = amb(ROOFS[Math.floor(hash01(seed + bi * 5 + 9) * ROOFS.length)]);

    // the wall and its cornice
    ctx.fillStyle = fc;
    ctx.fillRect(bx, top, bw, wh);
    ctx.fillStyle = darken(fc, 0.82);
    ctx.fillRect(bx, top, bw, 3 * u);

    // the roof — gable, mansard, or flat parapet, eaves a hair proud
    if (roof < 0.4) {
      // gable
      ctx.fillStyle = rc;
      ctx.beginPath();
      ctx.moveTo(bx - 3 * u, top);
      ctx.lineTo(bx + bw + 3 * u, top);
      ctx.lineTo(bx + bw * 0.5, top - (14 + hash01(seed + bi * 5 + 10) * 8) * u);
      ctx.closePath();
      ctx.fill();
    } else if (roof < 0.72) {
      // mansard — a trapezoid with a flat lid
      const rh = (12 + hash01(seed + bi * 5 + 10) * 6) * u;
      ctx.fillStyle = rc;
      ctx.beginPath();
      ctx.moveTo(bx - 3 * u, top);
      ctx.lineTo(bx + bw + 3 * u, top);
      ctx.lineTo(bx + bw - 9 * u, top - rh);
      ctx.lineTo(bx + 9 * u, top - rh);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = darken(rc, 0.85);
      ctx.fillRect(bx + 9 * u, top - rh, bw - 18 * u, 2.5 * u);
    } else {
      // flat parapet
      ctx.fillStyle = rc;
      ctx.fillRect(bx - 2 * u, top - 5 * u, bw + 4 * u, 6 * u);
    }

    // chimney — brick stub off-ridge; a couple of them still smoke
    if (hash01(seed + bi * 5 + 11) < 0.45) {
      const cx2 = bx + bw * (0.18 + hash01(seed + bi * 5 + 12) * 0.3);
      const ct = top - (roof < 0.4 ? 18 : roof < 0.72 ? 20 : 12) * u;
      ctx.fillStyle = darken(fc, 0.72);
      ctx.fillRect(cx2 - 4 * u, ct, 8 * u, top - ct + 2 * u);
      ctx.fillRect(cx2 - 5.5 * u, ct - 3 * u, 11 * u, 3.5 * u);
      if (steams < 2 && hash01(seed + bi * 5 + 13) < 0.4) {
        steams++;
        ctx.fillStyle = THEME.paper;
        for (let k = 0; k < 3; k++) {
          const p = (now * 0.12 + k * 0.33 + hash01(bi * 7 + k)) % 1;
          ctx.globalAlpha = 0.22 * (1 - p);
          ctx.beginPath();
          ctx.arc(
            cx2 + Math.sin((p * 3 + k) * 2.1) * 4 * u,
            ct - 6 * u - p * 34 * u,
            (2.5 + p * 4.5) * u,
            0,
            Math.PI * 2,
          );
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    }

    // the billboard — the city advertising the game back at you. One
    // per skyline; more would read as a joke told twice.
    if (roof >= 0.72 && bw > 100 * u && !billboard) {
      billboard = true;
      const bbw = Math.min(bw * 0.72, 92 * u);
      const bbh = 28 * u;
      const bbx = bx + (bw - bbw) / 2;
      const bby = top - bbh - 13 * u;
      ctx.fillStyle = darken(fc, 0.6);
      ctx.fillRect(bbx + bbw * 0.2, top - 14 * u, 3 * u, 10 * u);
      ctx.fillRect(bbx + bbw * 0.8 - 3 * u, top - 14 * u, 3 * u, 10 * u);
      ctx.beginPath();
      ctx.roundRect(bbx - 2 * u, bby - 2 * u, bbw + 4 * u, bbh + 4 * u, 3 * u);
      ctx.fill();
      ctx.fillStyle = amb(THEME.paper);
      ctx.fillRect(bbx, bby, bbw, bbh);
      ctx.fillStyle = THEME.ball;
      ctx.beginPath();
      ctx.arc(bbx + bbh * 0.5, bby + bbh * 0.5, bbh * 0.3, 0, Math.PI * 2);
      ctx.fill();
      // two lines of unreadable copy
      ctx.fillStyle = darken(fc, 0.6);
      ctx.fillRect(bbx + bbh * 0.95, bby + bbh * 0.32, bbw - bbh * 1.3, 2.5 * u);
      ctx.fillRect(bbx + bbh * 0.95, bby + bbh * 0.58, (bbw - bbh * 1.3) * 0.6, 2.5 * u);
    }

    // windows — dark panes by day on a real grid, lamps coming on one
    // by one with night. Each window owns its hash forever.
    {
      const cols = Math.min(7, Math.floor((bw - 12 * u) / (14 * u)));
      const rows = Math.min(4, Math.floor((wh - 12 * u) / (17 * u)));
      if (cols > 0 && rows > 0) {
        const paneInk = darken(fc, 0.55);
        const gx0 = bx + (bw - cols * 14 * u) / 2 + (14 * u - 5 * u) / 2;
        const gy0 = top + 9 * u;
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const t = hash01(seed + bi * 173 + r * 31 + c * 7);
            const wx = gx0 + c * 14 * u;
            const wy = gy0 + r * 17 * u;
            if (t < litFrac) {
              // the newest lamp still flickers — someone just got home
              const flick =
                t > litFrac - 0.03 && Math.sin(now * 3 + t * 90) < -0.2 ? 0.3 : 1;
              ctx.fillStyle = THEME.lamp;
              ctx.globalAlpha = lampA * flick;
              ctx.fillRect(wx - u, wy - u, 7 * u, 9 * u);
              ctx.globalAlpha = 1;
            } else {
              ctx.fillStyle = paneInk;
              ctx.fillRect(wx, wy, 5 * u, 7 * u);
            }
          }
        }
      }
    }

    // row houses touch; an alley now and then shows the layer behind
    bx += bw + (hash01(seed + bi * 3 + 4) < 0.24 ? 18 * u : -1);
  }
}

const kickSpring = createSpring({ stiffness: 320, damping: 14, mass: 1 });

// pennant ceremony timing — a new flag leaves the net HOIST_DELAY after
// the swish and flies for RISE seconds to its slot on the rope. The
// cleared phase holds until the raise lands: nobody misses their own
// ceremony.
const HOIST_DELAY = 0.6;
const RISE = 0.8;

interface Aim {
  p: number;
  a: number;
}

// px of pull per m/s of power. Desktop's 24 buys precision — a longer
// pull for the same power means finger error is a smaller fraction of
// the aim (gauntlet sim: practiced make rate 60% → 68% per level). But
// at 24 a full-power shot is a 312px swipe — most of a phone's width,
// past a thumb's comfortable stroke (field report: "not a lot of room
// to drag past level 1"). Small screens scale down until typical
// answers (8-10.5 m/s) land at 140-185px strokes. 0.58 over 0.5:
// jitter sims showed reachability dominates and the longer pull keeps
// more precision. Floor keeps tiny viewports from going hair-trigger.
function pullPxPerMps(): number {
  const s = Math.min(window.innerWidth, window.innerHeight);
  return Math.max(14, Math.min(24, (s * 0.58) / MAX_POWER));
}

// a drag only ARMS when it's a real pull: past min power (where the bar
// first reads above 0) and not ending substantially forward of its
// origin — a cancel flick back past the start point must stay a cancel,
// especially at touch speeds. The 0.35 tolerance keeps straight-down
// lob pulls with a little thumb drift legal.
function isArmed(d: { sx: number; sy: number; dx: number; dy: number }): boolean {
  const pull = Math.hypot(d.dx - d.sx, d.dy - d.sy);
  return pull > MIN_POWER * pullPxPerMps() && d.sx - d.dx > -0.35 * pull;
}

// pull back, throw opposite
function aimFromDrag(d: { sx: number; sy: number; dx: number; dy: number }): Aim {
  const pull = Math.hypot(d.dx - d.sx, d.dy - d.sy);
  const vx = d.sx - d.dx;
  const vy = d.dy - d.sy; // screen y down: pulling down aims up
  const a = (Math.atan2(vy, Math.max(vx, 1)) * 180) / Math.PI;
  return {
    p: Math.min(MAX_POWER, Math.max(MIN_POWER, pull / pullPxPerMps())),
    a: Math.max(5, Math.min(85, a)),
  };
}

interface Spark {
  x: number;
  y: number;
  at: number;
  color: string;
}

// pure celebration pixels — visual only, never touches the physics.
// size 3 is the square pixel burst off the rim; bigger pieces are paper —
// they tumble (rot/vr) and fall against drag, which is what makes the
// victory rain flutter instead of plummet.
interface Confetti {
  x: number;
  y: number;
  vx: number;
  vy: number;
  at: number;
  color: string;
  size: number;
  rot: number;
  vr: number;
  /** seconds before it fades — falling off the screen culls it sooner */
  life: number;
  /** air resistance; 0 keeps the original ballistic burst */
  drag: number;
}

// enter = the level-intro card; it hands off to aim on its own, and any
// press skips straight there — the card never eats an input
type Phase = "enter" | "aim" | "flying" | "cleared" | "dead" | "beat";
type Pose = "aim" | "watch" | "panic" | "joy" | "triumph" | "rest";

interface LastShot {
  made: boolean;
  touches: Touch[];
  missBy: number;
  missSide: "short" | "long";
  /** this miss beat the level's stored record (and a record existed) */
  closestYet: boolean;
}

// --- the run, persisted ---

const RUN_KEY = "hoop-run-v1";
const MUTE_KEY = "hoop-muted-v1";

function loadRun(): RunState {
  try {
    return parseRun(localStorage.getItem(RUN_KEY));
  } catch {
    return parseRun(null); // storage blocked — fresh player
  }
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
  // the glass must not steal or smear the aim.
  const dragRef = useRef<{
    id: number;
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
  const bucketsRef = useRef(0); // career makes — the meter that only climbs
  const eventAtRef = useRef(-Infinity); // joy hop clock
  const leanAtRef = useRef(-Infinity); // rim-approach slow-mo clock
  const inMouthRef = useRef(false); // edge-detects entry into rim airspace
  const kickAtRef = useRef(-Infinity);
  const phaseRef = useRef<Phase>("aim");
  const levelIdxRef = useRef(0);
  const lastAimRef = useRef<Aim | null>(null);
  // the pull's memory, per level, across games this session. The game is
  // memorizing six shots, but mobile hands had no reference — this feeds
  // the ghost arrow while aiming and space-replay on the same level.
  const levelAimsRef = useRef<(Aim | null)[]>([]);
  // consecutive clean makes per level, across games — the veteran's
  // meta-game on rungs they've long since solved
  const swishStreakRef = useRef<number[]>([]);
  const phaseAtRef = useRef(0); // when the current phase began — drives fades
  const runRef = useRef(1); // run number, readable inside the rAF loop
  const confettiRef = useRef<Confetti[]>([]);
  const popRef = useRef<{ text: string; at: number; color: string } | null>(null);
  const newBestRef = useRef(false); // this make went deeper than ever
  const winsRef = useRef(0); // career full clears — one gold banner each
  // the banner-raising: how many pennants already hung before the current
  // ceremony, and when the new one(s) started their climb to the rafters
  const ropeBaseRef = useRef(0);
  const hoistAtRef = useRef(-Infinity);
  const snapCountRef = useRef(0); // pennants that have snapped in (gates the sound)
  const hoistFromRef = useRef({ x: 0, y: 0 }); // rim screen pos at swish — new flags launch from the net
  const waveAtRef = useRef(-Infinity); // regrind make: the level's old flag waves back
  const waveIdxRef = useRef(-1);
  const powerNotchRef = useRef(0); // last power-bar notch ticked — the detent gate
  // per-level closest miss in meters, persisted — the record you can
  // break while losing. Feeds the death card's "your closest yet".
  const closestRef = useRef<(number | null)[]>([]);
  // practice balls left on the level that killed the run — 0 = not
  // practicing. Three per death, one session per card, a make ends it
  // early: enough to read the shot, not enough to groove it for free.
  const practiceRef = useRef(0);

  // HUD state
  const [phase, setPhase] = useState<Phase>("aim");
  const [levelIdx, setLevelIdx] = useState(0);
  const [runState, setRunState] = useState<RunState | null>(null);
  const [last, setLast] = useState<LastShot | null>(null);
  const [sndOn, setSndOn] = useState(true);
  const [copied, setCopied] = useState(false);
  const [practiceLeft, setPracticeLeft] = useState(0);
  const [practiced, setPracticed] = useState(false); // this death's session, spent

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
      bucketsRef.current = s.buckets;
      winsRef.current = s.wins;
      closestRef.current = [...s.closest];
      ropeBaseRef.current = s.bestDepth + s.wins; // veterans hang settled
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
      levelAimsRef.current[levelIdxRef.current] = aim;
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
      // the next round announces itself — an arpeggio rooted by the
      // level just cleared, timed to the enter card's slam
      sound.levelUp(ni);
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
    // practice ball — nothing counts: no records, no buckets, no
    // analytics, no verdict. A make ends the session (the answer's
    // found — go execute it); misses loop straight back to aim until
    // the rack is empty, then the death card returns.
    if (practiceRef.current > 0) {
      practiceRef.current -= 1;
      const over = s.made || practiceRef.current === 0;
      if (over) practiceRef.current = 0;
      setPracticeLeft(practiceRef.current);
      const missPop = s.made ? null : describeMiss(s.missBy, s.missSide);
      if (over) {
        setPhaseBoth("dead"); // back to the verdict card
      } else {
        resetForAim();
        setPhaseBoth("aim");
      }
      // the autopsy, posted where the next ball gets aimed — reading
      // these against a live retry is the whole point of the gym
      if (missPop) {
        popRef.current = {
          text: missPop.toUpperCase(),
          at: performance.now() / 1000,
          color: THEME.paper,
        };
      }
      return;
    }
    // the record you can break while losing: a miss closer than every
    // previous miss on this level. Only counts as news when a record
    // existed — the first miss anywhere is just a data point.
    const li = levelIdxRef.current;
    const prevClosest = closestRef.current[li];
    const closer = !s.made && s.missBy < (prevClosest ?? Infinity);
    if (closer) {
      closestRef.current[li] = s.missBy;
      setRunState((prev) => {
        if (!prev) return prev;
        const closest = [...prev.closest];
        while (closest.length < li) closest.push(null);
        closest[li] = s.missBy;
        const next = { ...prev, closest };
        saveRun(next);
        return next;
      });
    }
    setLast({
      made: s.made,
      touches: [...s.touches],
      missBy: s.missBy,
      missSide: s.missSide,
      closestYet: closer && prevClosest != null,
    });
    if (s.made) {
      const depth = levelIdxRef.current + 1;
      setRunState((prev) => {
        if (!prev) return prev;
        // bucketsRef and winsRef were bumped at the made-moment in the rAF loop
        const next = {
          ...prev,
          bestDepth: Math.max(prev.bestDepth, depth),
          buckets: bucketsRef.current,
          wins: winsRef.current,
        };
        saveRun(next);
        return next;
      });
      // the run's one datapoint — depth by input type, so the mobile/
      // desktop difficulty gap gets measured on players, not the sim
      if (depth === LEVELS.length) {
        track("run_end", {
          depth,
          beat: true,
          coarse: matchMedia("(pointer: coarse)").matches,
        });
      }
      setPhaseBoth(depth === LEVELS.length ? "beat" : "cleared");
    } else {
      track("run_end", {
        depth: levelIdxRef.current,
        beat: false,
        coarse: matchMedia("(pointer: coarse)").matches,
      });
      // the near-miss gets named too — an in-and-out hurts more than an
      // airball, and the game should say so
      const rims = s.touches.filter((t) => t.kind === "rim").length;
      if (rims > 0) {
        popRef.current = {
          text: rims >= 2 ? "IN AND OUT" : "RIM OUT",
          at: performance.now() / 1000,
          color: THEME.ball,
        };
      }
      // any miss breaks the level's clean-make streak
      swishStreakRef.current[levelIdxRef.current] = 0;
      sound.plunk(); // the run dies with a low dead thud
      navigator.vibrate?.(60);
      eventAtRef.current = performance.now() / 1000;
      setPracticed(false); // a fresh death card carries a fresh gym pass
      setPhaseBoth("dead");
    }
  }, [setPhaseBoth]);

  // the death card's gym pass: three balls on the level that killed
  // you. Practice finds the answer, the ghost arrow remembers it, the
  // next run executes it — the run itself stays one shot per level.
  const startPractice = useCallback(() => {
    setPracticed(true);
    practiceRef.current = 3;
    setPracticeLeft(3);
    resetForAim();
    setPhaseBoth("aim");
  }, [setPhaseBoth]);

  // bail out mid-session — back to the card, the pass stays spent
  const endPractice = useCallback(() => {
    practiceRef.current = 0;
    setPracticeLeft(0);
    setPhaseBoth("dead");
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
    // side: true draws the profile — feet, chest and eyes toward the
    // hoop. Used the whole time the ball is live (set point + flight);
    // reactions play to the camera. A snap turn, no tween — the
    // two-frame head turn is the oldest trick in cartooning.
    side = false,
  ) => {
    const { outline: OUTLINE, paper: PAPER, gold: YELLOW, fur: FUR, hair: HAIR, face: FACE, headband: HEADBAND, hoodie: HOODIE, pocket: POCKET, grape: GRAPE, teal: TEAL } = THEME;
    const age = now - eventAtRef.current;
    let dy = 0;
    // he's even-keeled: beating the game gets the double hop, a make
    // gets one modest hop, a miss doesn't move him
    if (pose === "triumph") dy = age < 0.64 ? [-1, 0, -1, 0][Math.floor(age / 0.16)] : 0;
    else if (pose === "joy") dy = age < 0.16 ? -1 : 0;
    // holding the ball he's set — crouch into the pull, no bouncing.
    // Only once the pull ARMS: a ghost pull isn't a shot, so bailing
    // out of one can't pop him back up like a hop.
    else if (pose === "aim") {
      const d = dragRef.current;
      dy = d && isArmed(d) ? 1 : 0;
    }
    else dy = Math.floor(now / 0.82) % 2 ? 1 : 0; // idle bob

    const cx = feetX;
    const foot = floorY + dy * k;
    // Construction: one chunky rounded-square head, tiny stoic features
    // low on the face, a green hoodie bunched off the left shoulder,
    // jointed arms. Few shapes, all wearing the same line — less plush
    // toy, more point guard.
    const headW = 10.4 * k;
    const headH = 8.6 * k;
    const headY = foot - 14.6 * k;
    const headR = headH / 2; // the marks above hang off this
    const headTop = headY - headR;
    const lw = Math.max(1.5, k * 0.55); // his cartoon line scales with him

    // his shadow — stays on the ground when he hops, like the reference's
    // flat unblurred pools under every object
    ctx.fillStyle = withAlpha(OUTLINE, "2b");
    ctx.beginPath();
    ctx.ellipse(cx, floorY + 2, (side ? 3.6 : 4.5) * k, 1.1 * k, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = lw;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    // legs — longer than a plush toy's, still chunky. In profile they
    // tuck together, the near leg mostly covering the far one, and run
    // longer — the shooting stance stands a head taller than the
    // frontal reaction shots.
    for (const lx of side ? [-0.9, 0.9] : [-1.8, 1.8]) {
      ctx.beginPath();
      ctx.moveTo(cx + lx * k, foot - (side ? 10.4 : 8.2) * k);
      ctx.lineTo(cx + lx * k, foot - 1.2 * k);
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 1.5 * k + lw * 1.6;
      ctx.stroke();
      ctx.strokeStyle = FUR;
      ctx.lineWidth = 1.5 * k;
      ctx.stroke();
    }
    // shoes — grape 5s off the pixel reference: white leather upper,
    // grape midsole with teal shark teeth biting up out of it, a teal
    // splash at the collar, the ink line holding the silhouette
    for (const fx of side ? [-0.9, 0.9] : [-2.0, 2.0]) {
      const bx = cx + fx * k;
      // in profile the boot points at the rim — heel tucked, toe long
      const bx0 = bx - (side ? 1.1 : 1.8) * k;
      const bw = (side ? 3.4 : 3.6) * k;
      const bh = 1.6 * k;
      // the tongue — a wide low tab stepping up off the flat collar on
      // the toe side, drawn first so the collar line crosses its base.
      // In profile only the near shoe wears one; the far shoe's tongue
      // would poke out of the near boot's silhouette.
      if (!side || fx > 0) {
        ctx.beginPath();
        ctx.roundRect(
          bx0 + bw - 1.55 * k,
          foot - bh - 0.35 * k,
          1.3 * k,
          0.8 * k,
          [0.25 * k, 0.25 * k, 0, 0],
        );
        ctx.fillStyle = PAPER;
        ctx.fill();
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = lw;
        ctx.stroke();
      }
      // the boot — flat collar, rounded sole corners
      const shape = () => {
        ctx.beginPath();
        ctx.roundRect(
          bx0,
          foot - bh,
          bw,
          bh,
          side
            ? [0.1 * k, 0.1 * k, 0.9 * k, 0.35 * k]
            : [0.1 * k, 0.1 * k, 0.45 * k, 0.45 * k],
        );
      };
      shape();
      ctx.fillStyle = PAPER; // the white upper
      ctx.fill();
      ctx.save();
      ctx.clip();
      // the grape midsole
      ctx.fillStyle = GRAPE;
      ctx.fillRect(bx0, foot - 0.7 * k, bw, 0.7 * k);
      // shark teeth — three teal flames leaning toward the toe
      ctx.fillStyle = TEAL;
      ctx.beginPath();
      for (let i = 0; i < 3; i++) {
        const x0 = bx0 + bw * (0.06 + i * 0.32);
        ctx.moveTo(x0, foot - 0.65 * k);
        ctx.lineTo(x0 + bw * 0.2, foot - 1.05 * k);
        ctx.lineTo(x0 + bw * 0.28, foot - 0.65 * k);
      }
      ctx.fill();
      // the collar splash at the heel top — profile only; head-on the
      // collar hides behind the pant leg
      if (side) {
        ctx.fillRect(bx0, foot - bh, 0.75 * k, 0.4 * k);
      }
      ctx.restore();
      shape();
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = lw;
      ctx.stroke();
    }
    // the legs left strokeStyle on fur blue; everything below inks
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = lw;
    // the hoodie — one fleece shape; side-on the
    // torso is chest-deep, not shoulder-wide
    ctx.fillStyle = HOODIE;
    ctx.beginPath();
    // square bottom corners — the hem over the pants is a straight
    // line. Legs read leg-length by raising the hem; the torso also
    // grows upward (shoulders at -13.2) so the chest isn't a stub
    // either — the head and arms ride up with it. Both views share the
    // proportions; only the chest depth differs.
    if (side) ctx.roundRect(cx - 2.1 * k, foot - 15.4 * k, 4.2 * k, 7.0 * k, [1.7 * k, 1.7 * k, 0, 0]);
    else ctx.roundRect(cx - 3.2 * k, foot - 13.2 * k, 6.4 * k, 5.6 * k, [1.7 * k, 1.7 * k, 0, 0]);
    ctx.fill();
    ctx.lineWidth = Math.max(1.2, lw * 0.75); // big flat shape, lighter line
    ctx.stroke();
    ctx.lineWidth = lw;
    // the kangaroo pocket — one stop darker, low on the hem; the
    // profile keeps the fleece clean
    if (!side) {
      ctx.fillStyle = POCKET;
      ctx.beginPath();
      ctx.roundRect(cx - 1.7 * k, foot - 9.8 * k, 3.4 * k, 2.2 * k, 0.6 * k);
      ctx.fill();
      ctx.stroke();
    }
    // drawstrings — blue cords off the collar (the reference's scarf
    // blue; paper would sink into the white fleece), ink aglets.
    // Frontal only — in profile the shooting arm eclipses the cord and
    // the leftover sliver reads as a stray blue speck.
    ctx.strokeStyle = HEADBAND;
    ctx.lineWidth = 0.5 * k;
    for (const sxo of side ? [] : [-0.9, 0.9]) {
      ctx.beginPath();
      ctx.moveTo(cx + sxo * k, foot - 12.4 * k);
      ctx.lineTo(cx + sxo * k, foot - 11.2 * k);
      ctx.stroke();
      ctx.fillStyle = OUTLINE;
      ctx.beginPath();
      ctx.arc(cx + sxo * k, foot - 11.05 * k, 0.28 * k, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = lw;
    // arms — shoulder, elbow, hand: jointed, so poses read athletic.
    // Shooting form (aim, watch) draws them after the head — forearms
    // cross in front of the face holding a real set shot. Everything
    // else keeps them behind the body.
    // [elbowX, elbowY, handX, handY] per side, in k units off the feet
    let arms: readonly (readonly [number, number, number, number])[] =
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
                [-5.0, -10.2, -6.8, -10.2],
                [5.0, -10.2, 6.8, -10.2],
              ] // hands held out, steady — braced, not flailing
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
                    [-2.8, -14.2, 0.3, -19.9],
                    [3.2, -13.8, 2.6, -19.7],
                  ]; // aim: the set point — guide hand on the ball's side,
                     // shooting elbow under it, forearm near vertical.
                     // Hands stop short; the mitten radius closes the gap.
    // profile shooting form — traced off the Curry frame: both arms go
    // up the front. The guide arm's elbow sits just forward of the
    // chin, its short forearm near vertical to the ball's near-low
    // side, mostly eclipsed by the shooting arm (drawn second, so it
    // covers). The shooting arm swings out under the chin, elbow
    // dropped low past the face, forearm up the front edge to the
    // ball. Nothing crosses the face or pokes behind the back.
    if (side && pose === "aim")
      arms = [
        // guide elbow tucked up behind the head so its cut end never
        // peeks out on the torso under the face
        [2.0, -16.6, 5.4, -21.5],
        [7.6, -14.8, 6.5, -22.0], // upper arm angles up and forward from
        // the socket; the long forearm carries the ball high overhead

      ];
    else if (side && pose === "watch")
      arms = [
        [0.8, -13.6, 2.2, -16.4], // guide hand stays up through the
        // follow-through, half-raised under the shooting arm
        [2.8, -14.1, 7.4, -18.2], // shooting arm out toward the rim, held
      ];
    const drawArms = () => {
      arms.forEach(([ex2, ey2, hx, hy], i) => {
        // first entry is always his left arm — the hand may cross the
        // midline (guide hand on the ball), so side comes from order.
        // In profile the shoulders stack up near the chest's midline —
        // except the set point's shooting shoulder, which sits out at
        // the chest's front edge instead of buried mid-body.
        const shoulderX =
          side && pose === "aim" && i === 1
            ? 2.3
            : (i === 0 ? -3.0 : 3.0) * (side ? 0.3 : 1);
        const ax = cx + shoulderX * k; // the shoulder
        // shoulders at the chest's top — the profile chest sits higher
        const ay = foot - (side ? 13.4 : 11.4) * k;
        const elX = cx + ex2 * k;
        const elY = foot + ey2 * k;
        const handX = cx + hx * k;
        const handY = foot + hy * k;
        // profile set point and follow-through: the guide arm's
        // shoulder is eclipsed by the body — draw only the forearm,
        // emerging from behind the head (the head draws after arms and
        // covers the elbow end), so no socket stub shows on the torso
        const hideUpper = side && (pose === "aim" || pose === "watch") && i === 0;
        ctx.beginPath();
        if (hideUpper) {
          ctx.moveTo(elX, elY);
        } else {
          ctx.moveTo(ax, ay);
          ctx.lineTo(elX, elY);
        }
        ctx.lineTo(handX, handY);
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = 1.5 * k + lw * 1.6;
        ctx.stroke();
        ctx.strokeStyle = HOODIE; // sleeves
        ctx.lineWidth = 1.5 * k;
        ctx.stroke();
        // the wristband — a blue tick across the forearm (paper would
        // sink into the white sleeve). In profile the band sits a fixed
        // step off the mitten's edge so it always touches the palm — a
        // forearm fraction drifts up the long shooting arm and hides
        // under the held ball.
        const flen = Math.hypot(handX - elX, handY - elY) || 1;
        const wfrac = side ? Math.max(0.5, 1 - (1.25 * k) / flen) : 0.7;
        const wx = elX + (handX - elX) * wfrac;
        const wy = elY + (handY - elY) * wfrac;
        ctx.strokeStyle = HEADBAND;
        ctx.lineWidth = 0.8 * k;
        ctx.beginPath();
        ctx.moveTo(wx - ((handY - elY) / flen) * 0.75 * k, wy + ((handX - elX) / flen) * 0.75 * k);
        ctx.lineTo(wx + ((handY - elY) / flen) * 0.75 * k, wy - ((handX - elX) / flen) * 0.75 * k);
        ctx.stroke();
        // the mitten — frontal mittens take a lighter line, full lw
        // reads too heavy on the small circles
        ctx.fillStyle = FACE;
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = side ? lw : lw * 0.65;
        ctx.beginPath();
        ctx.arc(handX, handY, (side ? 1.05 : 0.9) * k, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      });
    };
    // frontal shooting form crosses the forearms in front of the face;
    // in profile the arms go behind the head instead (see above)
    const armsInFront = (pose === "aim" || pose === "watch") && !side;
    if (!armsInFront) drawArms();
    if (side) {
      // --- the profile head, traced off the reference: a round skull
      // under a smooth hair helmet — no tufts, no headband. Hair is a
      // cap on the crown plus a narrow strip down the back; the big
      // tan face owns the whole lower half. Fringe
      // teeth over the forehead, the ear a nub in the hairline.
      // narrower than the frontal mop — the reference head is nearly
      // round, and it leaves room for the shooting arm to read
      const rxs = 4.4 * k;
      // the whole head (features, ear, collar) was traced at chibi
      // size; the reference head is way smaller on the body, so scale
      // the lot down around the chin, where the head sockets into the
      // collar. Lines inside scale too — smaller head, finer line.
      const HS = 0.72;
      const chinY = foot - 10.5 * k;
      ctx.save();
      // nudged back off the chest's midline — clears room up front for
      // the shooting arm
      // -5.2k: the head rides up with the taller profile torso
      ctx.translate(cx - 0.6 * k, chinY - 5.2 * k);
      ctx.scale(HS, HS);
      ctx.translate(-cx, -chinY);
      const skull = () => {
        ctx.beginPath();
        // the ellipse keeps the crown, back and nape; the front-lower
        // quadrant is hand-drawn as a marshmallow jaw — fuller and
        // flatter under the eye, dropping lower than the ellipse did.
        // One path, so fill, clip and stroke all wear the same edge.
        ctx.ellipse(cx, headY, rxs, headR, 0, 2.1, 0.15);
        ctx.quadraticCurveTo(cx + 4.55 * k, foot - 12.2 * k, cx + 4.0 * k, foot - 11.2 * k);
        // an extra quad through the jaw corner keeps it round, not pointy
        ctx.quadraticCurveTo(cx + 3.6 * k, foot - 10.45 * k, cx + 2.7 * k, foot - 10.25 * k);
        ctx.quadraticCurveTo(cx + 1.5 * k, foot - 10.1 * k, cx - 0.4 * k, foot - 10.5 * k);
        ctx.quadraticCurveTo(cx - 1.5 * k, foot - 10.6 * k, cx - 2.22 * k, foot - 10.89 * k);
        ctx.closePath();
      };
      skull();
      ctx.fillStyle = HAIR;
      ctx.fill();
      // the hairline — two chunky fringe teeth down the forehead, the
      // front one hanging right over the eye, then the helmet's bottom
      // edge sagging back across the skull to the nape. The face owns
      // everything below it. Both ends land on the skull's own ink and
      // disappear. Doubles as the face fill's inner boundary.
      const hairlinePath = () => {
        const teeth: readonly (readonly [number, number])[] = [
          [4.0, -16.4],
          [3.5, -14.2],
          [2.8, -15.6],
          [2.0, -14.3],
          [1.35, -15.3],
          [0.5, -13.5],
        ];
        for (const [px, py] of teeth) ctx.lineTo(cx + px * k, foot + py * k);
        // the back tail drops just behind the ear to the collar, so the
        // nape stays hair — ending it further back left a tan wedge
        // between hairline and collar. The end hides under the collar.
        ctx.quadraticCurveTo(cx - 1.6 * k, foot - 13.4 * k, cx - 2.2 * k, foot - 11.6 * k);
      };
      // the face — clipped to the skull so its outer edge IS the head
      // edge; the polygon just has to overshoot the front-bottom
      ctx.save();
      skull();
      ctx.clip();
      ctx.fillStyle = FACE;
      ctx.beginPath();
      hairlinePath();
      ctx.lineTo(cx - 5.0 * k, foot - 9.4 * k);
      ctx.lineTo(cx + 6.4 * k, foot - 9.6 * k);
      ctx.lineTo(cx + 6.4 * k, foot - 16.4 * k);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      // one clean outline over everything (the face fill ate the inner
      // half of it up front)
      skull();
      ctx.stroke();
      // ink only the hairline edge
      ctx.lineWidth = Math.max(1, lw * 0.8);
      ctx.beginPath();
      hairlinePath();
      ctx.stroke();
      // the ear — the hairline curls into a round lobe at the face's
      // back corner and ENDS there, like the reference: the arc opens
      // up-right into the cheek, bulge pointing down-left. Stroke only;
      // the skin behind it is already the face fill.
      ctx.beginPath();
      ctx.arc(cx - 0.5 * k, foot - 12.65 * k, 0.75 * k, -Math.PI * 0.675, Math.PI * 0.175, true);
      ctx.stroke();
      // no shine swoosh in profile — the crown stays one flat hair color
      ctx.lineWidth = lw;
      // the hood collar — drawn over the head like the reference: a
      // teardrop wrapping the nape, rounded crown at the back rising
      // to the ear, tapering to a tip at the chin that stops at the
      // hoodie's front edge
      ctx.fillStyle = HOODIE;
      ctx.beginPath();
      ctx.moveTo(cx + 2.2 * k, foot - 10.0 * k); // the tip
      // bottom edge running back
      ctx.quadraticCurveTo(cx - 0.5 * k, foot - 8.5 * k, cx - 3.4 * k, foot - 9.0 * k);
      // the round back bulge, rising
      ctx.quadraticCurveTo(cx - 6.2 * k, foot - 9.6 * k, cx - 5.6 * k, foot - 11.8 * k);
      // rounded crown near ear height
      ctx.quadraticCurveTo(cx - 4.8 * k, foot - 13.2 * k, cx - 3.2 * k, foot - 12.5 * k);
      // inner edge sliding under the ear, down to the tip
      ctx.quadraticCurveTo(cx - 1.0 * k, foot - 12.3 * k, cx + 0.2 * k, foot - 11.5 * k);
      ctx.quadraticCurveTo(cx + 1.6 * k, foot - 10.7 * k, cx + 2.2 * k, foot - 10.0 * k);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // the eye — one full dark oval under the fringe's front tooth,
      // wearing a small paper glint up-front. Lives inside the head's
      // transform so it scales along. No brow, no mouth; the fringe
      // hangs the scowl for him.
      ctx.fillStyle = OUTLINE;
      ctx.beginPath();
      ctx.ellipse(cx + 2.6 * k, foot - 13.1 * k, 0.62 * k, 0.75 * k, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = PAPER;
      ctx.beginPath();
      ctx.arc(cx + 2.6 * k, foot - 13.1 * k, 0.22 * k, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else {
    // --- the frontal head, matching the profile's language: the chibi
    // trace scaled 0.72 around the chin and raised onto the taller
    // torso. Smooth hair helmet — no tufts, no headband; the features
    // below are drawn inside this same transform so they ride along.
    // (Restored after the feature block, before armsInFront draws.)
    const chinF = foot - 10.3 * k; // the frontal head's bottom edge
    ctx.save();
    ctx.translate(cx, chinF - 3.2 * k);
    ctx.scale(0.72, 0.72);
    ctx.translate(-cx, -chinF);
    // ears — little side nubs, peeking past the silhouette
    ctx.fillStyle = FACE;
    for (const ex of [-5.5, 5.5]) {
      ctx.beginPath();
      ctx.arc(cx + ex * k, foot - 13.2 * k, 0.95 * k, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    // the head — one chunky rounded square filled with hair: the smooth
    // helmet wraps the sides, the face patch below is the only skin
    ctx.fillStyle = HAIR;
    ctx.beginPath();
    ctx.roundRect(cx - headW / 2, headTop, headW, headH, 3.6 * k);
    ctx.fill();
    ctx.stroke();
    // two tufts sticking up off the crown, bunched together right of
    // center. Bases sit inside the head so no seam shows.
    const tufts: readonly (readonly [number, number, number, number, number, number])[] = [
      [0.4, -18.8, 0.9, -19.9, 1.4, -18.8],
      [1.7, -18.5, 3.0, -19.4, 2.7, -18.1],
    ];
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
    // the jaw — below ear level the skin runs to the head's edge, so the
    // hair reads as a helmet with short sideburns, not chin-straps.
    // Clipped to the head so skin can't poke past the silhouette.
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(cx - headW / 2, headTop, headW, headH, 3.6 * k);
    ctx.clip();
    ctx.fillRect(cx - headW / 2, foot - 12.9 * k, headW, 2.6 * k);
    ctx.restore();
    // restate the ink the jaw fill covered
    ctx.beginPath();
    ctx.roundRect(cx - headW / 2, headTop, headW, headH, 3.6 * k);
    ctx.stroke();
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
    }

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
      // wide whites, pinprick pupils, mouth pressed flat — he's
      // watching the rattle like a deploy, not screaming at it
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
      ctx.moveTo(cx - 0.5 * k, foot - 11.8 * k);
      ctx.lineTo(cx + 0.5 * k, foot - 11.8 * k);
      ctx.stroke();
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
    } else if (pose === "aim" || pose === "watch") {
      // locked in the whole time the ball's in his hands — dot eyes,
      // brows angled down. Half-lids over the ball read as sleepwalking.
      // The profile eye is drawn inside the head block above (it lives
      // in the head's scale transform), so only the frontal draws here.
      if (!side) {
        // frontal — the beat before the turn: dot eyes dead on the
        // camera, the free-throw stare
        for (const ex of [-1.9, 1.9]) {
          ctx.beginPath();
          ctx.arc(cx + ex * k, eyeY, 0.5 * k, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.beginPath();
        ctx.moveTo(cx - 2.5 * k, eyeY - 1.6 * k);
        ctx.lineTo(cx - 1.1 * k, eyeY - 1.1 * k);
        ctx.moveTo(cx + 2.5 * k, eyeY - 1.6 * k);
        ctx.lineTo(cx + 1.1 * k, eyeY - 1.1 * k);
        ctx.stroke();
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
    // close the frontal head transform (opened in the else branch
    // above) — the features drew inside it so they scale with the head
    if (!side) ctx.restore();
    // shooting form: arms last, in front of the face
    if (armsInFront) drawArms();
    // marks above the head
    const markX = cx + 4.5 * k;
    const markY = headY - headR - 1.6 * k;
    if (pose === "panic") {
      // one still sweat bead at the temple — concerned, composed
      ctx.fillStyle = HEADBAND;
      ctx.beginPath();
      ctx.ellipse(markX, markY, 0.6 * k, 0.9 * k, 0, 0, Math.PI * 2);
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

  // the ball — flat mustard leather in a thick outline, thin dark seams
  // spun by rot, reference-style: no shading. Shared by the rAF loop
  // (at true physics size so rim reads honest) and the share card.
  const drawBall = (
    ctx: CanvasRenderingContext2D,
    bx: number,
    by: number,
    r: number,
    rot: number,
  ) => {
    const { outline: OUTLINE, ball: MUSTARD } = THEME;
    ctx.save();
    ctx.translate(bx, by);
    ctx.fillStyle = MUSTARD;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.clip();
    // seams — a gently bowed cross and two side arcs, spinning inside
    // the clip. Thin against the outline, like the reference.
    ctx.rotate(-rot);
    ctx.strokeStyle = OUTLINE;
    // ~80% of the outline's weight, and both run light — at the zoomed-in
    // span-fit scales heavy ink made the ball read as a black knot
    ctx.lineWidth = Math.max(1, r * 0.08);
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
    ctx.lineWidth = Math.max(1.2, r * 0.1);
    ctx.beginPath();
    ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.stroke();
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
      // only death asks for a press. Regrind levels (below your best)
      // get a shorter beat, but still a full one — 0.4s whisked past the
      // swish before it finished paying out.
      const clearedHold =
        LEVELS[levelIdxRef.current].id < bestDepthRef.current ? 0.7 : 1.0;
      // a raise in progress holds the curtain — the level transition's
      // sky wash was papering over the mid-flight flag. Nobody misses
      // their own ceremony: snap, whip, THEN the next level.
      const ceremonyEnd = hoistAtRef.current + HOIST_DELAY + RISE + 0.55;
      if (
        phaseRef.current === "cleared" &&
        now - phaseAtRef.current > clearedHold &&
        now > ceremonyEnd
      ) {
        advance();
      }

      const level = LEVELS[levelIdxRef.current];
      const W = canvas.width / dpr;
      const H = canvas.height / dpr;
      // fit the ACTION SPAN (launch → pole + a step) by both axes and
      // center it — the ~2m of court behind the pole is physics runway,
      // not picture, and on a width-limited portrait phone it was costing
      // 25-35% of the zoom and floating the hoop mid-frame. Cropped, the
      // hoop sits near the right edge and everything draws bigger; misses
      // still exit stage right, just off-camera. Zoomed past a strict fit:
      // crop a sliver of side margin and the empty sky above 4.7m
      // (ceilings live at 4.4-4.5). The rim is the protagonist — high
      // arcs already leave the frame, and that's drama, not a bug.
      const spanW = Math.min(level.w, level.rim.x + RIM_GAP + BOARD_OFF + 0.55);
      const scale = Math.min(W / (spanW * 0.93), (H - 20) / 4.7);
      const ox = (W - spanW * scale) / 2;
      // wide screens pin the floor near the bottom — leaving room for the
      // 16px asphalt cap plus a band of grass; tall screens center the
      // court so sky and floor split the leftover instead of the hoop
      // sinking to the bottom of a portrait phone
      const floorY = Math.min(H - 32, (H + level.h * scale) / 2);
      const sx = (x: number) => ox + x * scale;
      const sy = (y: number) => floorY - y * scale;
      // the ball's drawn radius — 20% over physics truth. The physics ball
      // is deliberately kind (46% of the mouth vs regulation's ~53%); drawn
      // dead honest it reads too small next to the chibi head. At 1.2 the
      // picture shows a regulation-looking fit while the physics stays
      // friendly underneath.
      const ballR = Math.max(5, BALL_R * scale * 1.2);

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
          const depth = levelIdxRef.current + 1;
          sound.swish(depth); // deeper buckets ring higher
          navigator.vibrate?.([20, 30, 40]);
          // a practice make deposits nothing — no pennant, no bucket,
          // no streak. The pop names the actual prize: this exact
          // pull, executed on a live run.
          const practice = practiceRef.current > 0;
          const firstEver = !practice && bestDepthRef.current === 0; // the conversion moment
          // pennants earned this make: a new-best hangs its level flag, a
          // full clear hangs a gold championship banner — beat it for the
          // first time and both go up. Mark the ceremony; the rafters
          // block raises whatever's beyond ropeBase.
          const isWin = !practice && depth === LEVELS.length;
          if (practice) {
            popRef.current = { text: "THAT'S THE ONE", at: now, color: YELLOW };
          } else {
            if (depth > bestDepthRef.current || isWin) {
              ropeBaseRef.current = bestDepthRef.current + winsRef.current;
              hoistAtRef.current = now;
              snapCountRef.current = 0;
              // the flag is earned HERE — launch it from the net so the
              // eye can ride it up to the rafters
              hoistFromRef.current = {
                x: sx(level.rim.x + RIM_GAP / 2),
                y: sy(level.rim.y) + 10,
              };
            } else {
              // already-flagged level: that flag waves back at the swish —
              // every bucket touches the rafters, not just the new bests
              waveAtRef.current = now;
              waveIdxRef.current = depth - 1;
            }
            if (depth > bestDepthRef.current) {
              bestDepthRef.current = depth;
              newBestRef.current = true;
              if (!isWin) sound.fanfare(); // deeper than ever before
            }
            if (isWin) {
              winsRef.current += 1;
              sound.finale(); // the flagpole — outranks every other jingle
            }
            // the career meter — every make anywhere deposits one, so even a
            // run that dies on level 2 paid into something permanent
            bucketsRef.current += 1;
            const milestone = isBucketMilestone(bucketsRef.current);
            if (milestone && !newBestRef.current && !isWin) sound.fanfare();
            // name the shot
            const walled = s.touches.some((t) => t.kind === "wall");
            const banked = s.touches.some((t) => t.kind === "board");
            const rims = s.touches.filter((t) => t.kind === "rim").length;
            // clean make = the SWISH branch below; streak survives across
            // games so the 800th layup still has something to protect
            const li = levelIdxRef.current;
            const clean = !walled && rims < 2 && !banked;
            swishStreakRef.current[li] = clean ? (swishStreakRef.current[li] ?? 0) + 1 : 0;
            const streak = swishStreakRef.current[li];
            popRef.current = {
              text:
                depth === LEVELS.length
                  ? "GAME WINNER"
                  : milestone
                    ? `${bucketsRef.current} BUCKETS`
                    : firstEver
                      ? "FIRST BUCKET"
                      : s.touches.length >= 4
                        ? "CIRCUS SHOT"
                        : walled
                          ? "OFF THE WALL"
                          : rims >= 2
                            ? "SHOOTERS SHOOT"
                            : banked
                              ? "BANK'S OPEN"
                              : streak >= 2
                                ? `SWISH ×${streak}`
                                : "SWISH",
              at: now,
              color:
                depth === LEVELS.length || newBestRef.current || milestone
                  ? YELLOW
                  : PAPER,
            };
          }
          // confetti from the rim — scaled with depth, so a deep make
          // literally rains more; the first bucket ever gets a parade.
          // Practice makes get the level's normal rain, no parades.
          const ccx = level.rim.x + RIM_GAP / 2;
          const n = practice
            ? 24
            : depth === LEVELS.length
              ? 80
              : firstEver
                ? 60
                : 24 + depth * 6;
          for (let i = 0; i < n; i++) {
            confettiRef.current.push({
              x: ccx,
              y: level.rim.y,
              vx: (Math.random() - 0.5) * 5,
              vy: 1 + Math.random() * 3.5,
              at: now,
              color: [MUSTARD, PAPER, YELLOW][i % 3],
              size: 3,
              rot: 0,
              vr: 0,
              life: 1.4,
              drag: 0,
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

      // sun or moon — behind the clouds, ahead of the city
      drawCelestials(ctx, W, floorY, SKY, night, now);

      // clouds — flat paper cumulus drifting by, gone after dark. Built
      // like the reference sky: a tall round head and two shoulder lobes
      // sitting on a flat base, not a stretched lens. cy is the cloud's
      // flat bottom.
      if (night < 0.8) {
        ctx.fillStyle = PAPER;
        ctx.globalAlpha = 0.9 * (1 - night);
        for (let i = 0; i < 4; i++) {
          const cw = 60 + hash01(i * 9 + 2) * 80;
          const cy = 20 + hash01(i * 9 + 3) * floorY * 0.32;
          const cx = ((hash01(i * 9 + 4) * W + now * (4 + i * 2)) % (W + cw * 2)) - cw;
          const lean = (hash01(i * 9 + 5) - 0.5) * 0.16; // head sits off-center
          // each lobe gets its own subpath (moveTo) — chained arcs draw
          // connector lines whose self-intersections fill as holes
          ctx.beginPath();
          for (const [lx, ly, lr] of [
            [lean, -0.26, 0.3],
            [-0.32, -0.14, 0.18],
            [0.28, -0.16, 0.2],
          ] as const) {
            ctx.moveTo(cx + (lx + lr) * cw, cy + ly * cw);
            ctx.arc(cx + lx * cw, cy + ly * cw, lr * cw, 0, Math.PI * 2);
          }
          ctx.roundRect(cx - 0.46 * cw, cy - 0.12 * cw, 0.92 * cw, 0.12 * cw, 0.06 * cw);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      // the bird — a small commuter crossing the sky now and then, gone
      // once the sun gets serious. Two paper shapes, a mustard beak, and
      // a wing that snaps between two frames in bursts: flap-flap-glide,
      // the oldest bird in cartooning. Some crossings bring a friend.
      if (night < 0.4) {
        // no crossing in the first 50s — the bird must never share the
        // screen with someone learning the drag, and being found beats
        // being presented. After that, one pass a minute at most: a
        // passerby, not a pet.
        const CYCLE = 53; // prime — never syncs with the clouds
        const bt = now - 50;
        const cyc = Math.floor(bt / CYCLE);
        const ct = (bt % CYCLE) / 14; // 14s on screen, the rest elsewhere
        if (bt > 0 && ct < 1) {
          const dir = hash01(cyc * 13 + 5) > 0.5 ? 1 : -1;
          const bdx = dir > 0 ? ct * (W + 90) - 45 : W + 45 - ct * (W + 90);
          // altitude picked per crossing, a lazy bob on the way across
          const bdy =
            16 + hash01(cyc * 13 + 6) * floorY * 0.22 + Math.sin(ct * Math.PI * 3) * 7;
          const bs = 1 + hash01(cyc * 13 + 7) * 0.4; // some days a bigger bird
          const pair = hash01(cyc * 13 + 8) < 0.3; // some days a friend trails along
          ctx.lineWidth = 1.5;
          ctx.lineJoin = "round";
          ctx.strokeStyle = OUTLINE;
          for (const [ox, oy, os, oph] of pair
            ? ([
                [0, 0, 1, 0],
                [-24, -7, 0.75, 1.9],
              ] as const)
            : ([[0, 0, 1, 0]] as const)) {
            ctx.save();
            ctx.translate(bdx + ox * bs * dir, bdy + oy * bs);
            ctx.scale(dir * bs * os, bs * os);
            // flap in bursts, glide between — no tween on the wing
            const flapping = Math.sin(now * 1.6 + cyc + oph) > -0.3;
            const up = flapping && Math.floor(now * 9 + oph) % 2 === 0;
            ctx.fillStyle = PAPER;
            // tail
            ctx.beginPath();
            ctx.moveTo(-5.5, -1);
            ctx.lineTo(-10.5, -3.5);
            ctx.lineTo(-9, 1);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            // beak — mustard, like everything worth chasing around here
            ctx.fillStyle = MUSTARD;
            ctx.beginPath();
            ctx.moveTo(5.5, -1.5);
            ctx.lineTo(9.5, 0);
            ctx.lineTo(5.5, 1.5);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            // body — one plump blob, nose up a touch
            ctx.fillStyle = PAPER;
            ctx.beginPath();
            ctx.ellipse(0, 0, 6.5, 4.2, -0.12, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            // the wing — a chunky leaf pivoting off the shoulder,
            // swept back whichever frame it's on
            ctx.beginPath();
            if (up) {
              ctx.moveTo(-2.5, -2);
              ctx.quadraticCurveTo(-7.5, -9, -8, -10);
              ctx.quadraticCurveTo(-3.5, -8.5, 2, -1.5);
            } else {
              ctx.moveTo(-2.5, -0.5);
              ctx.quadraticCurveTo(-6, 5.5, -6.5, 6.5);
              ctx.quadraticCurveTo(-1.5, 5.5, 2, 0.5);
            }
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            // eye — the same dot everyone here wears
            ctx.fillStyle = OUTLINE;
            ctx.beginPath();
            ctx.arc(3.2, -1.3, 0.8, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
          ctx.lineWidth = 1;
        }
      }

      // the city — see drawSkyline. The beat screen throws the party:
      // every window in town comes on.
      drawSkyline(ctx, W, floorY, SKY, night, now, {
        party: phaseRef.current === "beat",
      });

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
      // the level number painted at center court
      ctx.globalAlpha = 0.65;
      ctx.fillStyle = PAPER;
      ctx.font = `700 13px ${DISPLAY}`;
      ctx.textAlign = "center";
      ctx.fillText(String(level.id), sx(level.w / 2), floorY + 13);
      ctx.textAlign = "left";
      ctx.font = CANVAS_FONT;
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;

      // flat ground shadows — reference rule: every body in the world
      // sits on one. Solid ink at low alpha, no blur, centered under the
      // object (side view — an offset shadow would read as depth we
      // don't have).
      const shadow = (px: number, rx: number) => {
        ctx.fillStyle = withAlpha(OUTLINE, "2b");
        ctx.beginPath();
        ctx.ellipse(px, floorY + 2, rx, Math.max(2, rx * 0.28), 0, 0, Math.PI * 2);
        ctx.fill();
      };
      // the ball's shadow shrinks and thins with height — free altitude
      // readout while the ball flies
      const ballShadow = (wx: number, wy: number) => {
        const h01 = Math.min(1, Math.max(0, wy / 4));
        ctx.globalAlpha = 1 - 0.75 * h01;
        shadow(sx(wx), ballR * (1.1 - 0.5 * h01));
        ctx.globalAlpha = 1;
      };

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
        shadow(poleX, 9);
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
      // the net — a real diamond mesh, ink under paper like every other
      // line in the world: rim knots zigzag to a waist, waist to the hem,
      // two rows of diamonds. A make punches the whole lattice down and
      // it rings back like nylon. A function because the flying branch
      // redraws it over a ball dropping through — the ball sinks behind
      // the mesh, not over it.
      const drawNet = () => {
        const nt = madeRef.current ? now - eventAtRef.current : Infinity;
        const kick = nt < 0.6 ? Math.exp(-nt * 7) * Math.cos(nt * 20) * 7 : 0;
        const topW = backX - frontX;
        const netLen = scale * 0.38 + kick;
        const midXc = (frontX + backX) / 2;
        // x of knot t (0..1) on a band of width w, centered on the mouth
        const at = (w: number, t: number) => midXc - w / 2 + w * t;
        const midW = topW * 0.72;
        const botW = topW * 0.55;
        const midY = rimY + netLen * 0.52;
        const botY = rimY + netLen;
        ctx.lineCap = "round";
        ctx.beginPath();
        // rim → waist: each rim knot drops to its neighboring waist knots
        for (let i = 0; i < 4; i++) {
          const tx = at(topW, i / 3);
          if (i > 0) {
            ctx.moveTo(tx, rimY);
            ctx.lineTo(at(midW, (i - 0.5) / 3), midY);
          }
          if (i < 3) {
            ctx.moveTo(tx, rimY);
            ctx.lineTo(at(midW, (i + 0.5) / 3), midY);
          }
        }
        // waist → hem, then the hem itself
        for (let j = 0; j < 3; j++) {
          const mx = at(midW, (j + 0.5) / 3);
          ctx.moveTo(mx, midY);
          ctx.lineTo(at(botW, j / 3), botY);
          ctx.moveTo(mx, midY);
          ctx.lineTo(at(botW, (j + 1) / 3), botY);
        }
        ctx.moveTo(at(botW, 0), botY);
        ctx.lineTo(at(botW, 1), botY);
        // thinner cord than the old four strands — the mesh is denser
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.strokeStyle = PAPER;
        ctx.lineWidth = 1.6;
        ctx.stroke();
      };
      drawNet();
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

      // obstacle slabs — concrete in the cartoon line. Ground-standing
      // slabs sit on a shadow like everything else; floating ones don't.
      for (const wl of level.walls) {
        if (Math.min(wl.y1, wl.y2) === 0) {
          shadow(sx(wl.y1 <= wl.y2 ? wl.x1 : wl.x2), 11);
        }
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

      // beating the game turns the sky into a parade — a steady rain of
      // tumbling paper across the whole screen for as long as the verdict
      // is up, plus corner cannons for the first half second. Capped;
      // pieces leaving the screen free their slots, so the rain never
      // stalls and never mounds.
      if (phaseRef.current === "beat" && confettiRef.current.length < 240) {
        const PARADE = [MUSTARD, PAPER, YELLOW, THEME.rim, THEME.headband];
        const pick = () => PARADE[Math.floor(Math.random() * PARADE.length)];
        for (let i = 0; i < 2; i++) {
          confettiRef.current.push({
            // spawned just above the visible sky, anywhere across it
            x: (Math.random() * W - ox) / scale,
            y: (floorY + 10) / scale + Math.random() * 0.6,
            vx: (Math.random() - 0.5) * 1.4,
            vy: -(0.4 + Math.random() * 1.2),
            at: now,
            color: pick(),
            size: 4 + Math.random() * 3.5,
            rot: Math.random() * Math.PI * 2,
            vr: (Math.random() - 0.5) * 8,
            life: 6,
            drag: 2.5,
          });
        }
        if (now - phaseAtRef.current < 0.5) {
          for (const [cnx, dir] of [
            [0.2, 1],
            [level.w - 0.2, -1],
          ] as const) {
            for (let i = 0; i < 2; i++) {
              confettiRef.current.push({
                x: cnx,
                y: 0.1,
                vx: dir * (1 + Math.random() * 2.5),
                vy: 7 + Math.random() * 6,
                at: now,
                color: pick(),
                size: 4 + Math.random() * 3,
                rot: Math.random() * Math.PI * 2,
                vr: (Math.random() - 0.5) * 10,
                life: 6,
                drag: 1.8,
              });
            }
          }
        }
      }

      // confetti — pixel rain from the rim on every make, tumbling paper
      // across the sky when the game is beaten
      const aliveConf: Confetti[] = [];
      const confCullY = (floorY - H) / scale - 0.4; // below the screen — gone
      for (const c of confettiRef.current) {
        const a = now - c.at;
        if (a > c.life || c.y < confCullY) continue;
        c.vy -= (9.8 * 0.6 + c.vy * c.drag) * dt; // floaty; drag → flutter
        c.x += c.vx * dt;
        c.y += c.vy * dt;
        c.rot += c.vr * dt;
        aliveConf.push(c);
        ctx.fillStyle = c.color;
        ctx.globalAlpha = a < c.life - 0.5 ? 1 : (c.life - a) / 0.5;
        if (c.size <= 3) {
          ctx.fillRect(sx(c.x) - 1.5, sy(c.y) - 1.5, 3, 3);
        } else {
          // a paper piece thins as it turns edge-on — reads as a tumble
          ctx.save();
          ctx.translate(sx(c.x), sy(c.y));
          ctx.rotate(c.rot);
          const th = c.size * (0.25 + 0.55 * Math.abs(Math.sin(c.rot * 1.3)));
          ctx.fillRect(-c.size / 2, -th / 2, c.size, th);
          ctx.restore();
        }
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
      // profile the whole time the ball's his problem — set point
      // through flight. He only turns to the camera for reactions;
      // reaction shots play to the audience.
      const sideOn = pose === "aim" || pose === "watch";
      // he stands a step behind the launch point, so the held ball sits
      // up and in front of his forehead — the set point, not a head
      // rest, with the shooting arm reaching for it. The aim ball draws
      // after him, so where it overlaps his crown it reads as in front,
      // which is exactly right.
      drawCreature(ctx, sx(level.launch.x) - 7.0 * k, floorY, k, pose, now, sideOn);
      // the shooting palm — drawn after the held ball so it reads as
      // the hand cupping its underside; the wrist mitten below-left
      // closes the arm
      const palmUnderBall = (bx: number, by: number) => {
        // the blue wristband, restated — the arm's own band is buried
        // under the ball and this palm, so peek it out just below,
        // crossing the forearm. Drawn first so the palm laps its top.
        const wby = by + ballR * 0.92 + 1.15 * k;
        ctx.strokeStyle = THEME.headband;
        ctx.lineWidth = 0.8 * k;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(bx - 0.95 * k, wby + 0.11 * k);
        ctx.lineTo(bx + 0.55 * k, wby - 0.11 * k);
        ctx.stroke();
        ctx.lineCap = "butt";
        ctx.fillStyle = THEME.face;
        ctx.strokeStyle = THEME.outline;
        ctx.lineWidth = Math.max(1.2, k * 0.45);
        ctx.beginPath();
        ctx.ellipse(bx - 0.4 * k, by + ballR * 0.92, 1.55 * k, 0.85 * k, 0.35, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      };
      // the HELD ball rides above the true launch point — the long
      // forearms carry it high overhead. Cosmetic only: the shot still
      // leaves from launch, and the snap down on release is smaller
      // than one frame of ball travel.
      const setLift = 2.2 * k;

      if (ph === "flying" && shot && !shot.state.done) {
        const bx2 = sx(shot.state.x);
        const by2 = sy(shot.state.y);
        ballShadow(shot.state.x, shot.state.y);
        if (heat >= 2) {
          // the heater — a flickering halo on the streaking ball
          const hc = heat >= 4 ? THEME.rim : YELLOW;
          const hr = ballR * (1.8 + 0.2 * Math.sin(now * 24));
          const halo = ctx.createRadialGradient(bx2, by2, 0, bx2, by2, hr);
          halo.addColorStop(0, withAlpha(hc, "55"));
          halo.addColorStop(1, withAlpha(hc, "00"));
          ctx.fillStyle = halo;
          ctx.fillRect(bx2 - hr, by2 - hr, hr * 2, hr * 2);
        }
        drawBall(ctx, bx2, by2, ballR, ballRotRef.current);
        // dropping through the mouth the ball sinks behind the mesh —
        // redraw the net over it while they overlap
        if (
          by2 > rimY &&
          by2 - ballR < rimY + scale * 0.45 &&
          bx2 > frontX - ballR &&
          bx2 < backX + ballR
        ) {
          drawNet();
        }
      } else if (ph === "enter") {
        // ball in hand, waiting
        drawBall(ctx, sx(level.launch.x), sy(level.launch.y) - setLift, ballR, ballRotRef.current);
        palmUnderBall(sx(level.launch.x), sy(level.launch.y) - setLift);
      } else if (ph === "dead" && shot) {
        // the dead ball lies where it stopped
        ballShadow(shot.state.x, Math.max(shot.state.y, BALL_R));
        drawBall(ctx, sx(shot.state.x), sy(Math.max(shot.state.y, BALL_R)), ballR, ballRotRef.current);
      }

      // aiming — ball in his raised hands, the pull, the readout
      if (ph === "aim") {
        let bx = sx(level.launch.x);
        let by = sy(level.launch.y) - setLift;
        // the ghost of the last pull on this level — a faint dashed
        // reference to line the live arrow up against. Mobile's
        // space-replay: the hands still execute, the eyes get a target.
        const mem = levelAimsRef.current[levelIdxRef.current];
        if (mem) {
          const mp = (mem.p - MIN_POWER) / (MAX_POWER - MIN_POWER);
          const mr = (mem.a * Math.PI) / 180;
          const ml = 14 + mp * 52;
          ctx.strokeStyle = OUTLINE;
          ctx.globalAlpha = 0.28;
          ctx.lineWidth = 2;
          ctx.setLineDash([2, 6]);
          ctx.beginPath();
          ctx.moveTo(bx, by);
          ctx.lineTo(bx + Math.cos(mr) * ml, by - Math.sin(mr) * ml);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
          ctx.lineWidth = 1;
        }
        const drag = dragRef.current;
        const aim = drag ? aimFromDrag(drag) : null;
        // unarmed pulls (see isArmed) are free bail-outs — the aim draws
        // as a ghost stub until it's a real shot, and snaps solid armed
        const pullPx = drag ? Math.hypot(drag.dx - drag.sx, drag.dy - drag.sy) : 0;
        const armed = drag ? isArmed(drag) : false;
        if (!aim) powerNotchRef.current = -1; // fresh pull, fresh detents
        if (aim) {
          // drawn-bowstring tremble past 60% power
          const p01 = (aim.p - MIN_POWER) / (MAX_POWER - MIN_POWER);
          if (p01 > 0.6) {
            const j = (p01 - 0.6) * 4;
            bx += (Math.random() - 0.5) * 2 * j;
            by += (Math.random() - 0.5) * 2 * j;
          }
        }
        drawBall(ctx, bx, by, ballR, ballRotRef.current);
        palmUnderBall(bx, by);
        if (aim) {
          const p01 = (aim.p - MIN_POWER) / (MAX_POWER - MIN_POWER);
          const rad = (aim.a * Math.PI) / 180;
          // unarmed pulls draw a short ghost stub that grows toward the
          // arming point — the shot isn't real yet and the picture says so
          const len = armed
            ? 14 + p01 * 52
            : 4 + Math.min(1, pullPx / (MIN_POWER * pullPxPerMps())) * 10;
          // the arrow heats up with power — ink by default, red when hot
          const aimC = p01 > 0.6 ? THEME.rim : OUTLINE;
          const tipX = bx + Math.cos(rad) * len;
          const tipY = by - Math.sin(rad) * len;
          ctx.strokeStyle = aimC;
          ctx.lineWidth = 2.5;
          ctx.lineCap = "round";
          ctx.setLineDash([4, 5]);
          if (!armed) ctx.globalAlpha = 0.35;
          ctx.beginPath();
          ctx.moveTo(bx, by);
          ctx.lineTo(tipX, tipY);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.lineCap = "butt";
          ctx.globalAlpha = 1;
          if (armed) {
            // arrowhead — the aim is a vector, not a string; it only
            // grows its head once a release means a shot
            ctx.fillStyle = aimC;
            ctx.beginPath();
            ctx.moveTo(tipX + Math.cos(rad) * 8, tipY - Math.sin(rad) * 8);
            ctx.lineTo(tipX + Math.cos(rad + 2.5) * 6, tipY - Math.sin(rad + 2.5) * 6);
            ctx.lineTo(tipX + Math.cos(rad - 2.5) * 6, tipY - Math.sin(rad - 2.5) * 6);
            ctx.closePath();
            ctx.fill();
            // power bar — an outlined paper pill above the ball (the ball
            // is held overhead; below-the-ball put it across his face at
            // phone zoom). An instrument, not a widget: quarter notches to
            // read the draw against, a caret marking the last pull on this
            // level, the fill heating with the arrow, and a quiet climbing
            // tick each notch crossed — you learn a level's power by ear
            // as much as by eye.
            const barX = bx - 17;
            const barY = by - ballR - 21;
            const full = p01 >= 0.999;
            ctx.fillStyle = PAPER;
            ctx.strokeStyle = full ? YELLOW : OUTLINE;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.roundRect(barX, barY, 34, 7, 3.5);
            ctx.fill();
            ctx.stroke();
            // the fill — clipped to the pill so the ends stay round; heat
            // matches the arrow: ink→brick past 60%, gold at full draw
            ctx.save();
            ctx.beginPath();
            ctx.roundRect(barX + 1.5, barY + 1.5, 31, 4, 2);
            ctx.clip();
            ctx.fillStyle = full ? YELLOW : p01 > 0.6 ? THEME.rim : MUSTARD;
            ctx.fillRect(barX + 1.5, barY + 1.5, 31 * p01, 4);
            // quarter notches — hairlines the thumb can come back to
            ctx.strokeStyle = OUTLINE;
            ctx.lineWidth = 1;
            ctx.globalAlpha = 0.3;
            for (const q of [0.25, 0.5, 0.75]) {
              const qx = barX + 1.5 + 31 * q;
              ctx.beginPath();
              ctx.moveTo(qx, barY + 1.5);
              ctx.lineTo(qx, barY + 5.5);
              ctx.stroke();
            }
            ctx.globalAlpha = 1;
            ctx.restore();
            // the ghost's power — a caret under the bar at the remembered
            // pull, partner to the dashed arrow
            if (mem) {
              const mx = barX + 1.5 + 31 * ((mem.p - MIN_POWER) / (MAX_POWER - MIN_POWER));
              ctx.fillStyle = OUTLINE;
              ctx.globalAlpha = 0.35;
              ctx.beginPath();
              ctx.moveTo(mx, barY + 9);
              ctx.lineTo(mx - 2.5, barY + 13);
              ctx.lineTo(mx + 2.5, barY + 13);
              ctx.closePath();
              ctx.fill();
              ctx.globalAlpha = 1;
            }
            // detents — one tick per notch crossed on the way up, pitch
            // climbing, starting with the arming click at notch 0;
            // pulling back down re-arms them silently
            const notch = full ? 4 : Math.floor(p01 * 4);
            if (notch > powerNotchRef.current) {
              sound.tick(notch * 2);
              navigator.vibrate?.(4);
            }
            powerNotchRef.current = notch;
            ctx.strokeStyle = OUTLINE;
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
          } else {
            powerNotchRef.current = -1; // release here is a free bail-out
          }
        } else if (
          showGestureHint(
            bestDepthRef.current,
            lastAimRef.current !== null,
            levelIdxRef.current,
          )
        ) {
          // first-timer, or anyone's first pull of the session — gone
          // after the session's first shot. 12px, and clamped so it
          // can't run off a narrow phone.
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

      // the rafters — the trophy case is the world, not a stat readout.
      // One pennant per level ever cleared, then a gold championship
      // banner per full clear, strung on a sagging rope top-right like a
      // small gym's banner wall. A new one is earned AT THE RIM: it
      // launches out of the net trophy-big, the eye rides it up to its
      // slot, it sails just past, snaps on (the rope dips, sparks fly in
      // its color), and sways itself still. Drawn late in the frame so
      // the flight crosses the world instead of hiding behind the glass.
      // Makes on already-flagged levels get a wave from their old flag —
      // every bucket touches the rafters.
      const nBest = bestDepthRef.current;
      const nFlags = nBest + winsRef.current;
      if (nFlags > 0) {
        // a lifetime of wins keeps hanging banners — the rope crowds
        // before it grows past roughly half the sky
        const spacing = Math.min(22, Math.max(9, (W * 0.55 - 26) / nFlags));
        const ropeR = W - 12;
        const ropeL = ropeR - nFlags * spacing - 10;
        const hoistStart = (i: number) =>
          hoistAtRef.current + HOIST_DELAY + (i - ropeBaseRef.current) * 0.35;
        // the rope dips when a flag snaps on, then rings itself out
        let sag = 4;
        for (let i = ropeBaseRef.current; i < nFlags; i++) {
          const since = now - hoistStart(i) - RISE;
          if (since > 0) sag += 2.5 * Math.exp(-3 * since) * Math.cos(7 * since);
        }
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = 1.5;
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(ropeL, 0);
        ctx.quadraticCurveTo((ropeL + ropeR) / 2, sag * 2, ropeR, 0);
        ctx.stroke();
        // each level flies its own color, left to right — six is the gold;
        // every full clear hangs a swallowtail after them
        const flags = [THEME.rim, THEME.headband, MUSTARD, THEME.grass, PAPER, YELLOW];
        for (let i = 0; i < nFlags; i++) {
          const px2 = ropeL + spacing * 0.7 + i * spacing;
          // where the rope hangs at this x — quadratic from ends at y=0
          const t = (px2 - ropeL) / (ropeR - ropeL);
          const py2 = 4 * sag * t * (1 - t);
          const champ = i >= nBest;
          const color = champ ? YELLOW : flags[i % flags.length];
          // hung by hand, not machine
          const len = champ ? 18 + hash01(i * 7 + 70) * 3 : 13 + hash01(i * 7 + 70) * 5;
          // the breeze — every flag stirs a little, out of step
          let rot = 0.04 * Math.sin(now * 0.9 + i * 1.7);
          let fx = px2;
          let fy = py2;
          let sc = 1;
          if (i >= ropeBaseRef.current) {
            const tr = (now - hoistStart(i)) / RISE;
            if (tr < 0) continue; // still in the net, waiting its turn
            if (tr < 1) {
              // the flight — net to rafter. Soft back-ease sails it a
              // touch past the slot before it settles; the sine lob bows
              // the path upward so it reads thrown, not slid.
              const u = tr - 1;
              const c1 = 0.7;
              const eased = 1 + (c1 + 1) * u * u * u + c1 * u * u;
              fx = hoistFromRef.current.x + (px2 - hoistFromRef.current.x) * eased;
              fy = hoistFromRef.current.y + (py2 - hoistFromRef.current.y) * eased;
              fy -= 22 * Math.sin(Math.min(1, Math.max(0, eased)) * Math.PI);
              // trophy-big out of the net, true size on the rope
              sc = 1 + 1.2 * (1 - eased);
              rot += (1 - tr) * 0.3 * Math.sin(tr * 12); // flutter on the way up
            } else {
              // snapped on — one cloth whip per flag, then sway to rest
              const local = i - ropeBaseRef.current;
              if (snapCountRef.current <= local) {
                snapCountRef.current = local + 1;
                sound.pennant();
                // the burst, in the flag's own color — sparks live in
                // world coords, so convert back out of rope space
                sparksRef.current.push({
                  x: (px2 - ox) / scale,
                  y: (floorY - (py2 + len * 0.5)) / scale,
                  at: now,
                  color,
                });
              }
              const since = tr * RISE - RISE; // seconds since arrival
              rot += 0.45 * Math.exp(-1.8 * since) * Math.sin(8 * since);
            }
          }
          // a make on an already-flagged level — that flag waves back
          const ws = now - waveAtRef.current;
          if (i === waveIdxRef.current && ws < 1.6) {
            rot += 0.5 * Math.exp(-2.2 * ws) * Math.sin(9 * ws);
          }
          ctx.save();
          ctx.translate(fx, fy);
          ctx.rotate(rot);
          ctx.scale(sc, sc);
          ctx.fillStyle = color;
          ctx.beginPath();
          if (champ) {
            // championship banner — gold swallowtail, notched hem
            ctx.moveTo(-5.5, 0);
            ctx.lineTo(5.5, 0);
            ctx.lineTo(5.5, len);
            ctx.lineTo(0, len - 5);
            ctx.lineTo(-5.5, len);
          } else {
            ctx.moveTo(-5, 0);
            ctx.lineTo(5, 0);
            ctx.lineTo(0, len);
          }
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          if (champ) {
            // the stitched dot — reads as a star from courtside
            ctx.fillStyle = PAPER;
            ctx.beginPath();
            ctx.arc(0, 5.5, 1.7, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.restore();
        }
        ctx.lineWidth = 1;
        ctx.lineJoin = "miter";
      }

      // the shot-name pop — SWISH / BANK'S OPEN / SHOOTERS SHOOT / OFF THE WALL
      const pop = popRef.current;
      if (pop) {
        const a = now - pop.at;
        if (a > 0.95) popRef.current = null;
        else {
          const size = Math.round(46 - 12 * Math.min(a / 0.12, 1)); // slams in
          // centered in the viewport, not on the rim — rims live near
          // the edge on portrait and the long calls clipped offscreen
          const px2 = W / 2;
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
        // level 6 is the last shot; the level past your best is match
        // point — the run that could set a new best should feel different
        // BEFORE the shot, not just after. Deep runs get their streak
        // named on the way in.
        const lastOne = level.id === LEVELS.length;
        const matchPoint =
          !lastOne && bestDepthRef.current > 0 && level.id === bestDepthRef.current + 1;
        card(
          lastOne
            ? "THE LAST SHOT"
            : matchPoint
              ? `LEVEL ${level.id} — MATCH POINT`
              : `LEVEL ${level.id}`,
          lastOne
            ? `level ${level.id} — game ${run}`
            : matchPoint
              ? `game ${run} — a make sets a new best`
              : heat >= 4
                ? `game ${run} — on fire`
                : heat >= 2
                  ? `game ${run} — heating up`
                  : `game ${run}`,
          lastOne || matchPoint ? YELLOW : PAPER,
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
    if (ph === "flying") return;
    if (ph === "enter") {
      // a press during the intro card is a player already pulling —
      // skip the rest of the read instead of eating the drag
      setPhaseBoth("aim");
    } else if (ph !== "aim") {
      advance(); // cleared → next level, dead/beat → run it back
      return;
    }
    if (dragRef.current) return; // one finger owns the aim
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      id: e.pointerId,
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
    // the up event carries the TRUE final finger position — touch moves
    // are throttled and coalesced, so a quick pull-back-and-lift can
    // leave dx/dy frames stale and fire a shot the player bailed on
    d.dx = e.clientX;
    d.dy = e.clientY;
    // an unarmed pull is not a shot — release is a free bail-out.
    // Covers stray taps, regretted angles eased back to the ball, and
    // cancel flicks that overshoot the origin.
    if (!isArmed(d)) return;
    shoot(aimFromDrag(d));
  };

  // Space = this level's remembered pull (the ghost arrow), falling back
  // to the last pull anywhere. Deterministic physics makes this an
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
      if (ph === "flying") return;
      if (ph === "enter") {
        setPhaseBoth("aim"); // the masher's replay must not be eaten
      } else if (ph !== "aim") {
        advance();
        return;
      }
      const mem = levelAimsRef.current[levelIdxRef.current] ?? lastAimRef.current;
      if (mem) shoot(mem);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shoot, advance, setPhaseBoth]);

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
  const buckets = runState?.buckets ?? 0;
  const wins = runState?.wins ?? 0;
  // what the miss cost you — no tease when you die on the last rung
  const nextLevel = levelIdx + 1 < LEVELS.length ? LEVELS[levelIdx + 1] : null;
  // the autopsy — a near miss named in ball-widths; bricks stay unnamed
  const missLine =
    last && !last.made ? describeMiss(last.missBy, last.missSide) : null;
  // dying at the frontier — one make past this ✗ was a new best
  const frontier = bestDepth > 0 && levelIdx === bestDepth;
  // this run's deposits, for the odometer roll and the +N tick
  const runMakes = phase === "beat" ? LEVELS.length : levelIdx;

  // the share card — not a DOM screenshot but the world repainted as a
  // poster: the sky the run ended under, the verdict, the career line,
  // and the little guy with his ball standing where the button sits on
  // screen. No "Game Over" — the wordmark carries the top.
  const renderShareCard = (beat: boolean): Promise<Blob> => {
    const { outline: OUTLINE, paper: PAPER, ball: MUSTARD, gold: YELLOW } = THEME;
    const W = 1080;
    const H = 1350; // 4:5 — survives every share sheet uncropped
    const cv = document.createElement("canvas");
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext("2d")!;
    const DISPLAY =
      getComputedStyle(document.body).getPropertyValue("--font-plex-serif").trim() ||
      "ui-monospace, Menlo, monospace";
    const night = NIGHT[levelIdx] ?? 1;
    const grassY = H - 290;
    const sky = SKIES[levelIdx] ?? SKIES[SKIES.length - 1];

    // the sky the run ended under — stars, sun or moon, the whole
    // painted city. The card is a postcard from the level you died on.
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    if (night > 0.5) {
      ctx.fillStyle = PAPER;
      ctx.globalAlpha = (night - 0.5) * 2 * 0.7;
      for (let i = 0; i < 70; i++) {
        ctx.fillRect(hash01(i * 2 + 1) * W, hash01(i * 2 + 2) * grassY * 0.6, 5, 5);
      }
      ctx.globalAlpha = 1;
    }
    // fixed clock — every card of the same run is the same picture
    drawCelestials(ctx, W, grassY, sky, night, 0.35);
    drawSkyline(ctx, W, grassY, sky, night, 0.35, { party: beat, hScale: 0.55 });

    // sticker lettering, the game's house style
    ctx.textAlign = "center";
    ctx.lineJoin = "round";
    const sticker = (text: string, size: number, y: number, fill: string) => {
      ctx.font = `700 ${size}px ${DISPLAY}`;
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = Math.max(5, size * 0.18);
      ctx.strokeText(text, W / 2, y);
      ctx.fillStyle = fill;
      ctx.fillText(text, W / 2, y);
    };
    sticker("HOOPING", 104, 200, MUSTARD);

    // the run, replayed in pips — the poster's hero and its whole
    // scoreboard. Makes in mustard, the ✗ where it died, the pennant
    // over the best. A stranger reads it without a legend; that's the
    // wordle trick. Empty pips wear the stat ink so they survive
    // every sky.
    const ink = night > 0.5 ? PAPER : OUTLINE;
    const pipY = 340;
    const pipR = 28;
    const step = 92;
    const pipX0 = W / 2 - ((LEVELS.length - 1) * step) / 2;
    LEVELS.forEach((_, i) => {
      const x = pipX0 + i * step;
      if (i < runMakes) {
        ctx.beginPath();
        ctx.arc(x, pipY, pipR, 0, Math.PI * 2);
        ctx.fillStyle = MUSTARD;
        ctx.fill();
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = 6;
        ctx.stroke();
      } else if (!beat && i === levelIdx) {
        ctx.strokeStyle = THEME.rim;
        ctx.lineWidth = 11;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x - 20, pipY - 20);
        ctx.lineTo(x + 20, pipY + 20);
        ctx.moveTo(x + 20, pipY - 20);
        ctx.lineTo(x - 20, pipY + 20);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(x, pipY, pipR, 0, Math.PI * 2);
        ctx.strokeStyle = withAlpha(ink, "66");
        ctx.lineWidth = 6;
        ctx.stroke();
      }
      if (!beat && bestDepth === i + 1) {
        const fy = pipY - pipR - 44;
        ctx.beginPath();
        ctx.moveTo(x - 16, fy);
        ctx.lineTo(x + 16, fy);
        ctx.lineTo(x, fy + 28);
        ctx.closePath();
        ctx.fillStyle = YELLOW;
        ctx.fill();
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = 4;
        ctx.stroke();
      }
    });

    // the one line of text — the career best, same wording as the top
    // bar, gold when the run earned gold. No stats dashboard; the pips
    // already told the story.
    const verdict = beat
      ? `ALL ${LEVELS.length} LEVELS, ONE BALL`
      : bestDepth > 0
        ? `BEST ${bestDepth}/${LEVELS.length} CLEARED`
        : `LEVEL ${levelIdx + 1}`;
    let vSize = 56;
    ctx.font = `700 ${vSize}px ${DISPLAY}`;
    while (vSize > 36 && ctx.measureText(verdict).width > W - 160) {
      vSize -= 4;
      ctx.font = `700 ${vSize}px ${DISPLAY}`;
    }
    sticker(
      verdict,
      vSize,
      480,
      beat || last?.closestYet || frontier ? YELLOW : PAPER,
    );

    // the ground — grass with the asphalt cap, same seams as the game
    ctx.fillStyle = THEME.grass;
    ctx.fillRect(0, grassY, W, H - grassY);
    ctx.fillStyle = THEME.asphalt;
    ctx.fillRect(0, grassY, W, 46);
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(0, grassY);
    ctx.lineTo(W, grassY);
    ctx.stroke();
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(0, grassY + 46);
    ctx.lineTo(W, grassY + 46);
    ctx.stroke();

    // the little guy — crowned in his V after a win, ball resting at his
    // feet; otherwise frozen in the follow-through, the shot still rising.
    // snapNow: a fixed clock that lands every pose on its rest frame
    // (no mid-hop feet, no mid-bob offset).
    const k = 21;
    const snapNow = beat ? eventAtRef.current + 1 : 0.001;
    if (beat) {
      drawCreature(ctx, W / 2, grassY, k, "triumph", snapNow);
      ctx.fillStyle = withAlpha(OUTLINE, "2b");
      ctx.beginPath();
      ctx.ellipse(W / 2 + 7.5 * k, grassY + 2, 3.3 * k, 0.9 * k, 0, 0, Math.PI * 2);
      ctx.fill();
      drawBall(ctx, W / 2 + 7.5 * k, grassY - 2.8 * k, 2.8 * k, 0.6);
    } else {
      // mid-shot: the ball high on its arc up-right, ghost beats trailing
      // back to his shooting hand like the training-wheel dots
      const feetX = W / 2 - 120;
      drawCreature(ctx, feetX, grassY, k, "watch", snapNow, true); // eyes on the shot, not us
      const handX = feetX + 6.6 * k;
      const handY = grassY - 16.2 * k;
      const ballX = W / 2 + 250;
      const ballY = 620;
      ctx.fillStyle = OUTLINE;
      for (let i = 1; i <= 5; i++) {
        const t = i / 6;
        const gx = handX + (ballX - handX) * t;
        // ease-out rise — the dots climb steeply then flatten at the ball
        const gy = handY + (ballY - handY) * (1 - (1 - t) * (1 - t));
        ctx.globalAlpha = 0.15 + 0.3 * t;
        ctx.fillRect(gx - 5, gy - 5, 10, 10);
      }
      ctx.globalAlpha = 1;
      drawBall(ctx, ballX, ballY, 2.8 * k, 2.2);
    }

    ctx.font = `600 38px ui-monospace, Menlo, monospace`;
    ctx.fillStyle = PAPER;
    ctx.fillText("hooping.io", W / 2, H - 60);

    return new Promise<Blob>((resolve, reject) => {
      cv.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
    });
  };

  // the wordle move, upgraded: the game collapses to one PNG. Phones get
  // the card through the native share sheet; desktop copies it to the
  // clipboard, or downloads it when the clipboard won't take images.
  const shareRun = async () => {
    const beat = phase === "beat";
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
      // share() rejects when the user dismisses the sheet — that's a
      // no-op, not a fallback
      try {
        const file = new File([await renderShareCard(beat)], `hooping-game-${run}.png`, {
          type: "image/png",
        });
        if (navigator.canShare?.({ files: [file] })) {
          // the card alone — it carries the pips and the URL; a caption
          // would just be someone's app talking over it
          await navigator.share({ files: [file] });
        } else {
          await navigator.share({ text: "hooping.io" }); // no file sharing — old move
        }
      } catch {
        // sheet dismissed
      }
      return;
    }
    try {
      // ClipboardItem takes the promise itself — Safari requires the
      // write to begin inside the click, before any await
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": renderShareCard(beat) }),
      ]);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard won't take images (or blocked) — hand the file over
      const a = document.createElement("a");
      a.href = URL.createObjectURL(await renderShareCard(beat));
      a.download = `hooping-game-${run}.png`;
      a.click();
      URL.revokeObjectURL(a.href);
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
          <span>BEST {bestDepth > 0 ? `${bestDepth}/${LEVELS.length} CLEARED` : "—"}</span>
          <button
            onClick={toggleSound}
            // -m/p: a finger-sized hit area around a 13px icon, no layout shift
            className="-m-2 flex items-center p-2 hover:text-[#fdfaf2]"
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
            className={`absolute inset-0 z-10 flex touch-none items-center justify-center animate-[fade-in_0.2s_ease-out_0.1s_both] ${
              // death dims the world in ink; victory keeps it bright under
              // a gold wash so the confetti rain stays lit
              phase === "beat" ? "bg-[#f2b32e]/10" : "bg-[#312d28]/40"
            }`}
            onPointerDown={advance}
          >
            <div className="flex w-96 max-w-[94%] flex-col items-center gap-4 rounded-2xl border-[3px] border-foreground bg-background px-6 py-7 text-center font-mono shadow-[5px_5px_0_rgba(49,45,40,0.55)] animate-[verdict-in_0.3s_ease-out_0.15s_both] sm:px-8">
              {phase === "dead" ? (
                <>
                  {/* the verdict is the story, not the genre — the miss
                      named in ball-widths wears the headline. Gold when
                      the death set a record or brushed the frontier;
                      iron red otherwise. */}
                  <h2
                    className={`font-display text-2xl font-bold leading-tight text-balance ${
                      last?.closestYet || frontier
                        ? "text-warning"
                        : "text-accent-negative"
                    }`}
                  >
                    {missLine ?? (last ? autopsy(last) : "game over")}
                  </h2>
                  {/* the run, replayed — each make stamps in on its own
                      beat, the ✗ lands last on the level that killed it,
                      and the record's pennant hangs over the slot it
                      guards, named so it never reads as a puzzle. The
                      gap between ✗ and flag IS the pitch. */}
                  <div
                    className="flex justify-center gap-2.5"
                    aria-label={`died on level ${levelIdx + 1}${
                      bestDepth > 0 ? `, best level ${bestDepth}` : ""
                    }`}
                  >
                    {LEVELS.map((_, i) => (
                      <span
                        key={i}
                        aria-hidden
                        className="flex flex-col items-center gap-[3px] animate-[letter-pop_0.4s_cubic-bezier(0.34,1.56,0.64,1)_both]"
                        style={{ animationDelay: `${0.35 + i * 0.07}s` }}
                      >
                        <svg
                          viewBox="0 0 8 9"
                          className={`h-3 w-3 text-warning ${
                            bestDepth === i + 1 ? "" : "invisible"
                          }`}
                        >
                          <path
                            d="M0 .5h8L4 8.5Z"
                            fill="currentColor"
                            stroke="var(--foreground)"
                            strokeWidth="1"
                          />
                        </svg>
                        {i < levelIdx ? (
                          <span className="h-5 w-5 rounded-full border-2 border-foreground bg-[#dfa63f]" />
                        ) : i === levelIdx ? (
                          <span className="flex h-5 w-5 items-center justify-center text-xl font-bold leading-none text-accent-negative">
                            ✗
                          </span>
                        ) : (
                          <span className="h-5 w-5 rounded-full border-2 border-border" />
                        )}
                        <span
                          className={`text-[8px] font-bold uppercase leading-none tracking-wide text-warning ${
                            bestDepth === i + 1 ? "" : "invisible"
                          }`}
                        >
                          best
                        </span>
                      </span>
                    ))}
                  </div>
                  {/* the stakes, in gold, right above the button that
                      cashes them — the strongest retry triggers in the
                      game sit adjacent to the retry */}
                  {last?.closestYet && (
                    <p className="text-xs font-bold text-warning">
                      your closest yet
                    </p>
                  )}
                  {frontier && (
                    <p className="text-xs font-bold text-warning">
                      one make from a new best
                    </p>
                  )}
                  {/* the retry is the reward — the next court rides the
                      button itself, a tease you cash by pressing it.
                      Tap-anywhere still works; this is the same verb
                      with a face. stopPropagation so the overlay's
                      pointerdown doesn't advance before the click. */}
                  <button
                    onClick={advance}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="w-full overflow-hidden rounded-xl border-2 border-foreground bg-well text-foreground shadow-[4px_4px_0_#312d28] transition-[transform,box-shadow] duration-100 ease-out animate-[note-in_0.35s_cubic-bezier(0.34,1.56,0.64,1)_0.75s_both] hover:-translate-x-px hover:-translate-y-px hover:shadow-[5px_5px_0_#312d28] active:translate-x-[4px] active:translate-y-[4px] active:shadow-none"
                  >
                    {nextLevel && (
                      <span className="flex flex-col items-center gap-1.5 px-3 pb-2.5 pt-3">
                        <span className="label">
                          next up — level {nextLevel.id}
                        </span>
                        <MiniCourt level={nextLevel} />
                        <span className="font-display text-sm font-semibold uppercase tracking-wide">
                          {nextLevel.name}
                        </span>
                      </span>
                    )}
                    <span
                      className={`flex w-full items-center justify-center gap-2 bg-[#dfa63f] py-2.5 text-xs font-bold ${
                        nextLevel ? "border-t-2 border-foreground" : ""
                      }`}
                    >
                      run it back <span aria-hidden>→</span>
                    </span>
                  </button>
                </>
              ) : (
                <>
                  {/* the banner — champion lettering. each letter stamps
                      in on its own beat with a hand-set tilt, then the
                      whole line hangs from its nail and sways. */}
                  <h2
                    aria-label="You Beat It"
                    className="origin-top animate-[banner-sway_3.4s_ease-in-out_1.4s_infinite] font-display text-3xl font-bold text-warning [text-shadow:0.07em_0.07em_0_var(--foreground)]"
                  >
                    {"You Beat It".split("").map((ch, i) => (
                      <span
                        key={i}
                        aria-hidden
                        className="inline-block whitespace-pre animate-[letter-pop_0.5s_cubic-bezier(0.34,1.56,0.64,1)_both]"
                        style={{
                          animationDelay: `${0.3 + i * 0.05}s`,
                          // hand-set type: nothing sits perfectly straight
                          rotate: `${((i * 7) % 5) - 2}deg`,
                        }}
                      >
                        {ch}
                      </span>
                    ))}
                  </h2>
                  {/* his note — taped on askew after the banner settles */}
                  <div className="relative w-full rotate-[-2deg] rounded-sm border border-border bg-surface px-4 pb-2 pt-3 shadow-[2px_2px_0_rgba(49,45,40,0.12)] animate-[note-in_0.4s_cubic-bezier(0.34,1.56,0.64,1)_1s_both]">
                    <div
                      aria-hidden
                      className="absolute -top-2 left-1/2 h-4 w-10 -translate-x-1/2 rotate-[4deg] rounded-[1px] bg-[#eae2cb]/80"
                    />
                    <p className="font-hand text-xl leading-tight text-foreground">
                      all {LEVELS.length} levels, one ball, no misses.
                      <br />
                      {wins > 1
                        ? `that's banner ${wins} in the rafters.`
                        : "i watched every shot."}
                    </p>
                    <p className="mt-1 text-right font-hand text-lg text-muted">
                      — the little guy
                    </p>
                  </div>
                </>
              )}
              {/* the career line moves — it holds at the pre-run total
                  while the pips stamp, then rolls this run's deposits
                  in with a gold +N. Numbers going up, on schedule. */}
              <p className="text-xs text-muted">
                GAME {run} ·{" "}
                <CountUp
                  from={buckets - runMakes}
                  to={buckets}
                  delayMs={1000}
                />{" "}
                CAREER {buckets === 1 ? "BUCKET" : "BUCKETS"}
                {runMakes > 0 && (
                  <span className="font-bold text-warning animate-[letter-pop_0.3s_ease-out_1s_both]">
                    {" "}
                    +{runMakes}
                  </span>
                )}
              </p>
              {/* share is the primary verb only on a win — a death
                  screen's verb is retry, so there it goes ghost. min-w
                  so the copied swap doesn't jiggle the width. Death
                  cards seat the gym pass beside it: three free balls on
                  the shot that killed the run, one session per death —
                  enough to find the answer, not enough to groove it. */}
              <div className="flex items-center gap-2.5">
                {phase === "dead" && !practiced && (
                  <button
                    onClick={startPractice}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="flex items-center justify-center rounded-lg border border-border px-4 py-2 text-xs font-bold text-muted transition-colors hover:border-foreground hover:text-foreground"
                  >
                    practice it
                  </button>
                )}
                <button
                  onClick={shareRun}
                  onPointerDown={(e) => e.stopPropagation()}
                  className={
                    phase === "beat"
                      ? "flex min-w-28 items-center justify-center gap-2 rounded-lg border-2 border-foreground bg-[#dfa63f] px-5 py-2.5 text-xs font-bold text-foreground shadow-[3px_3px_0_#312d28] transition-[transform,box-shadow] duration-100 ease-out hover:-translate-x-px hover:-translate-y-px hover:shadow-[4px_4px_0_#312d28] active:translate-x-[3px] active:translate-y-[3px] active:shadow-none"
                      : "flex min-w-24 items-center justify-center gap-1.5 rounded-lg border border-border px-4 py-2 text-xs font-bold text-muted transition-colors hover:border-foreground hover:text-foreground"
                  }
                >
                  {copied ? (
                    <Check size={13} strokeWidth={3} aria-hidden />
                  ) : (
                    <Share2 size={13} strokeWidth={2.5} aria-hidden />
                  )}
                  {copied ? "copied" : "share"}
                </button>
              </div>
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
        ) : practiceLeft > 0 ? (
          // the gym — ball count where the stakes line usually sits
          <span>
            practice — {practiceLeft} {practiceLeft === 1 ? "ball" : "balls"}{" "}
            left, nothing counts
          </span>
        ) : phase === "flying" ? (
          <span>…</span>
        ) : (
          // the drag lesson lives on the canvas, next to the ball —
          // this line states the stakes instead of repeating it. Phones
          // get the short cut: the full line plus the bucket counter
          // wraps at 393px.
          <span>
            one shot<span className="max-sm:hidden"> per level</span>. a miss
            ends the game.
          </span>
        )}
        <span className="flex shrink-0 items-center gap-3">
          {/* mid-practice exit — back to the card, the pass stays spent */}
          {practiceLeft > 0 && phase === "aim" && (
            <button
              onClick={endPractice}
              className="font-bold underline underline-offset-2"
            >
              done <span aria-hidden>→</span>
            </button>
          )}
          {/* the career meter — only ever climbs, every run deposits */}
          {buckets > 0 && (
            <span>
              {buckets} {buckets === 1 ? "bucket" : "buckets"}
            </span>
          )}
          <span className="max-sm:hidden">
            <Kbd>drag</Kbd> shoot
          </span>
          <span className="max-sm:hidden">
            <Kbd>space</Kbd> replay
          </span>
        </span>
      </div>
    </div>
  );
}

