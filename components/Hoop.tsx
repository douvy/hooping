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
import VerdictCard, { type VerdictApi } from "./VerdictCard";
import {
  BALL_R,
  BOARD_H,
  BOARD_OFF,
  LEVELS,
  MAX_POWER,
  MIN_POWER,
  RIM_GAP,
  V_SCALE,
  createShot,
  type Shooter,
  type Touch,
} from "@/lib/hoop";
import {
  describeMiss,
  isBucketMilestone,
  localDay,
  nextBucketMilestone,
  parseRun,
  shareArtifact,
  shareStakes,
  showGestureHint,
  type RunState,
} from "@/lib/run";
import { createSpring } from "@/lib/spring";
import * as sound from "@/lib/sound";
import { INK, LINE_WEIGHTS, SHADOW, SKIES, THEME, darken, mix, saturate, shade, withAlpha } from "@/lib/theme";

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
    // upper-left — the scene's one light source lives on this shoulder;
    // every shade edge and shadow in the world answers to it
    const sunX = W * 0.24;
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
    const mx = W * 0.78; // the crescent takes the sun's opposite shoulder
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

  // a shooting star — deep night only. The day sky has the bird; this
  // is the night's one heartbeat. A streak every 41s (prime — never
  // syncs with anything), 0.9s long: rare enough to feel like luck.
  if (night > 0.7) {
    const st = now - 20;
    const cyc = Math.floor(st / 41);
    const p = (st % 41) / 0.9;
    if (st > 0 && p < 1) {
      const x0 = (0.15 + hash01(cyc * 17 + 3) * 0.6) * W;
      const y0 = (0.05 + hash01(cyc * 17 + 4) * 0.16) * floorY;
      const dir = hash01(cyc * 17 + 5) > 0.5 ? 1 : -1;
      const len = floorY * 0.24;
      const hx = x0 + dir * p * len;
      const hy = y0 + p * len * 0.5;
      const fade =
        Math.min(1, p / 0.15, (1 - p) / 0.3) * Math.min(1, (night - 0.7) / 0.3);
      ctx.strokeStyle = THEME.paper;
      ctx.lineCap = "round";
      ctx.lineWidth = 1.6;
      ctx.globalAlpha = 0.7 * fade;
      ctx.beginPath();
      ctx.moveTo(hx - dir * len * 0.22, hy - len * 0.11);
      ctx.lineTo(hx, hy);
      ctx.stroke();
      ctx.globalAlpha = fade;
      ctx.fillStyle = THEME.paper;
      ctx.beginPath();
      ctx.arc(hx, hy, 1.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineCap = "butt";
      ctx.lineWidth = 1;
    }
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
  opts: { party?: boolean; hScale?: number; gaze?: boolean } = {},
) {
  const u = skyU(floorY);
  // Law 1 — the street band's three line weights, the tokenized tiers
  // scaled by this band's unit. Heavy holds object silhouettes, medium
  // the major interior divisions, light the detail marks.
  const wHeavy = LINE_WEIGHTS.heavy * u;
  const wMed = LINE_WEIGHTS.med * u;
  const wLight = LINE_WEIGHTS.light * u;
  const hS = opts.hScale ?? 1;
  const party = opts.party ?? false;
  const gaze = opts.gaze ?? false; // a ball is in the air — the cat cares
  // ambient — a golden cast first (the foreground lives in the warm
  // band of the scene's single upper-left light), then paint leans
  // toward the sky and loses light with night
  const amb = (c: string) =>
    darken(
      mix(mix(c, "#f2b06a", 0.1 * (1 - night * 0.85)), sky, 0.28 + 0.3 * night),
      1 - 0.38 * night,
    );
  const litFrac = party ? 0.92 : night <= 0.12 ? 0 : 0.08 + 0.4 * night;
  const lampA = Math.min(1, 0.35 + night) * 0.9;
  // golden hour — light gets a direction. The sun hangs off the sky's
  // LEFT shoulder, so left edges and left slopes warm as it drops: a
  // whisper at level 3, full gold at the swollen level-4 sunset, gone
  // once it sinks. Objects stay put; only the light moves.
  const glow =
    night >= 0.15 && night < 0.62
      ? Math.min(1, (night - 0.02) / 0.43) * Math.min(1, (0.62 - night) / 0.07)
      : 0;

  // horizon haze — two paler strips of the same sky; the far towers
  // stand in them and the flat backdrop reads ten more miles deep
  ctx.fillStyle = darken(sky, 1.05);
  ctx.fillRect(0, floorY - floorY * 0.3 * hS, W, floorY * 0.3 * hS);
  ctx.fillStyle = darken(sky, 1.11);
  ctx.fillRect(0, floorY - floorY * 0.14 * hS, W, floorY * 0.14 * hS);

  // ——— distance: two silhouette layers, saturate-then-darken so the
  // haze keeps the sky's hue instead of going gray. Both stand on the
  // river's FAR bank — the whole far city rises from the water's edge,
  // and the river runs in front of it. No water behind the skyline
  // anywhere. Zero line, zero texture out here: the silent band. ———
  const waterTop = floorY - 0.26 * floorY * hS;
  const waterBot = floorY - 0.12 * floorY * hS;
  let masts = 0;
  // temperature drops with distance: the town on the far bank cools one
  // step off the warm front row, the towers behind it cool two and
  // nearly lose their edge against the sky — the squint test wants two
  // bands, not swatches
  for (const [sat, f, hMin, hMax, wMin, wVar, gapMul, seed, detail] of [
    // far — pale, thin, spaced: downtown behind the far-bank town
    [1.0, 0.945, 0.12, 0.48, 26, 64, 1.35, 500, false],
    [1.3, 0.85, 0.06, 0.4, 44, 130, 1, 700, true], // the far-bank town
  ] as const) {
    const base = waterTop;
    const bc = darken(saturate(sky, sat), f);
    ctx.fillStyle = bc;
    for (let bx = -30 * u - seed * 0.01, bi = 0; bx < W; bi++) {
      const bw = (wMin + hash01(seed + bi * 3 + 1) * wVar) * u;
      const bh = (hMin + hash01(seed + bi * 3 + 2) * (hMax - hMin)) * floorY * hS;
      const roof = hash01(seed + bi * 3 + 3);
      const top = base - bh;
      const cr = Math.min(12 * u, bw * 0.15);
      ctx.beginPath();
      ctx.roundRect(bx, top, bw, bh, [cr, cr, 0, 0]);
      if (roof < 0.16) {
        // the knob — a small rounded nub off one shoulder
        ctx.roundRect(bx + bw * 0.14, top - 9 * u, 16 * u, 14 * u, 5 * u);
      }
      ctx.fill();

      // the skyline's melody — a spire here, a dome there, so the far
      // city reads as an old town's roofline, not a bar chart
      if (roof >= 0.46 && roof < 0.56) {
        // church spire — a slim cone on a short drum
        const px = bx + bw * (0.3 + hash01(seed + bi * 3 + 6) * 0.4);
        ctx.beginPath();
        ctx.rect(px - 5 * u, top - 8 * u, 10 * u, 9 * u);
        ctx.moveTo(px - 6 * u, top - 8 * u);
        ctx.lineTo(px, top - 30 * u);
        ctx.lineTo(px + 6 * u, top - 8 * u);
        ctx.closePath();
        ctx.fill();
      } else if (roof >= 0.56 && roof < 0.64 && bw > 60 * u) {
        // a dome with its finial nub
        const px = bx + bw * 0.5;
        ctx.beginPath();
        ctx.arc(px, top + u, 13 * u, Math.PI, 0);
        ctx.rect(px - 1.5 * u, top - 16 * u, 3 * u, 5 * u);
        ctx.fill();
      }

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

  // ——— the river — the quiet band, drawn in FRONT of the skyline: the
  // far city rises from the water's far bank. No ink out here, soft
  // fills only — the depth language switches at the waterline. ———
  {
    // the far bank — a thin ground line the skyline sits on
    ctx.fillStyle = darken(saturate(sky, 1.28), 0.86);
    ctx.fillRect(0, waterTop - 2.5 * u, W, 2.5 * u);
    // one step cooler and grayer than the street — the river's
    // temperature sits between the warm front row and the pale far city
    const wtr = darken(saturate(sky, 1.35), 0.8);
    ctx.fillStyle = wtr;
    ctx.fillRect(0, waterTop, W, waterBot - waterTop);
    // the near-shore edge — one darker line where the water meets our
    // bank, the river's third and last mark
    ctx.fillStyle = darken(wtr, 0.85);
    ctx.fillRect(0, waterBot - 1.6 * u, W, 1.6 * u);
    // lamp smears — the far city's windows fall in and wobble; three
    // columns, no more — the water stays quiet
    if (litFrac > 0) {
      ctx.strokeStyle = THEME.lamp;
      ctx.lineWidth = 1.4 * u;
      ctx.lineCap = "round";
      ctx.globalAlpha = lampA * 0.4;
      ctx.beginPath();
      for (let i = 0; i < 3; i++) {
        const lx = W * (0.08 + hash01(1370 + i) * 0.45);
        for (let r = 0; r < 3; r++) {
          const sy = waterTop + (0.2 + r * 0.28) * (waterBot - waterTop);
          const sw = (7 - r * 1.6) * u;
          const wob = Math.sin(now * 1.1 + i * 2.3 + r * 1.9) * 2 * u;
          ctx.moveTo(lx + wob - sw / 2, sy);
          ctx.lineTo(lx + wob + sw / 2, sy);
        }
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineCap = "butt";
      ctx.lineWidth = 1;
    }
    // the bridge — three stone arches over open water, the one line
    // that ties the two banks into a single town. It stands at its own
    // waterline partway down the band, leaving water below for the
    // reflection.
    const brC = darken(saturate(sky, 1.32), 0.76);
    const bxl = W * 0.6;
    const span = W * 0.36;
    const band = waterBot - waterTop;
    const deckY = waterTop + 0.18 * band;
    const wl = waterTop + 0.62 * band; // the bridge's waterline
    ctx.fillStyle = brC;
    ctx.fillRect(bxl, deckY, span, wl - deckY);
    // its shade side — the span's far end answers the upper-left light,
    // soft fill, no ink: the same physics as the street in the river's
    // quieter voice
    ctx.fillStyle = shade(brC);
    ctx.fillRect(bxl + span * 0.72, deckY, span * 0.28, wl - deckY);
    // punch the arches back out in water
    ctx.fillStyle = wtr;
    const ar = Math.min((span / 3) * 0.32, (wl - deckY) * 0.75);
    for (let a = 0; a < 3; a++) {
      const acx = bxl + ((a + 0.5) / 3) * span;
      ctx.beginPath();
      ctx.arc(acx, wl, ar, Math.PI, 0);
      ctx.fill();
    }
    // the reflection — the arches flipped into the water, heavily
    // faded, then broken by exactly two ripple lines. Restraint is the
    // point.
    ctx.fillStyle = darken(brC, 0.92);
    ctx.globalAlpha = 0.3;
    ctx.fillRect(bxl, wl, span, (waterBot - wl) * 0.85);
    ctx.globalAlpha = 1;
    ctx.fillStyle = wtr;
    for (let a = 0; a < 3; a++) {
      const acx = bxl + ((a + 0.5) / 3) * span;
      ctx.beginPath();
      ctx.arc(acx, wl, ar * 0.9, 0, Math.PI);
      ctx.fill();
    }
    ctx.strokeStyle = wtr;
    ctx.lineWidth = 1.8 * u;
    ctx.beginPath();
    for (const rt of [0.36, 0.68]) {
      ctx.moveTo(bxl - 6 * u, wl + (waterBot - wl) * rt);
      ctx.lineTo(bxl + span + 6 * u, wl + (waterBot - wl) * rt);
    }
    ctx.stroke();
    ctx.lineWidth = 1;
    // where the light grazes the surface — two paper dashes, no more
    ctx.strokeStyle = mix(wtr, THEME.paper, 0.7);
    ctx.lineWidth = 1.6 * u;
    ctx.lineCap = "round";
    ctx.globalAlpha = 0.5 + 0.3 * glow;
    ctx.beginPath();
    ctx.moveTo(bxl + span * 0.18, wl + (waterBot - wl) * 0.42);
    ctx.lineTo(bxl + span * 0.18 + 14 * u, wl + (waterBot - wl) * 0.42);
    ctx.moveTo(bxl + span * 0.55, wl + (waterBot - wl) * 0.66);
    ctx.lineTo(bxl + span * 0.55 + 9 * u, wl + (waterBot - wl) * 0.66);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineCap = "butt";
    ctx.lineWidth = 1;
    // deck cap, a hair proud at both ends
    ctx.fillStyle = darken(brC, 0.8);
    ctx.fillRect(bxl - 4 * u, deckY, span + 8 * u, 3 * u);
    // lamp posts on the piers — warm dots once the city needs them
    ctx.fillStyle = brC;
    for (let a = 0; a <= 3; a++) {
      const px = bxl + (a / 3) * span;
      ctx.fillRect(px - u, deckY - 9 * u, 2 * u, 9 * u);
      if (night > 0.3 || party) {
        ctx.globalAlpha = lampA;
        ctx.fillStyle = THEME.lamp;
        ctx.beginPath();
        ctx.arc(px, deckY - 10.5 * u, 1.8 * u, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = brC;
      }
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
    // the shade face — one step darker and warmer, hard edge, same
    // upper-left light every wall in the town answers to
    ctx.fillStyle = shade(body);
    ctx.fillRect(tx + tw / 2 - 5 * u, top, 5 * u, th);
    // at golden hour the sun claims the near edge
    if (glow > 0) {
      ctx.fillStyle = mix(body, THEME.gold, 0.5 * glow);
      ctx.fillRect(tx - tw / 2, top, 4 * u, th);
    }
    ctx.strokeStyle = INK;
    ctx.lineJoin = "round";
    ctx.lineWidth = wHeavy;
    ctx.strokeRect(tx - tw / 2, top, tw, th);
    // the clock head — slightly proud of the shaft
    const hw = tw + 8 * u;
    ctx.fillStyle = body;
    ctx.fillRect(tx - hw / 2, top, hw, 34 * u);
    ctx.fillStyle = shade(body);
    ctx.fillRect(tx + hw / 2 - 5 * u, top, 5 * u, 34 * u);
    ctx.fillStyle = darken(body, 0.8);
    ctx.fillRect(tx - hw / 2, top + 34 * u, hw, 3 * u);
    ctx.lineWidth = wHeavy;
    ctx.strokeRect(tx - hw / 2, top, hw, 37 * u);
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
    // the cap's shade slope — the right face drops one warm step
    ctx.fillStyle = shade(cap);
    ctx.beginPath();
    ctx.moveTo(tx + hw / 2 + 2 * u, top);
    ctx.lineTo(tx + 4 * u, top - 22 * u);
    ctx.lineTo(tx + u, top - 22 * u);
    ctx.lineTo(tx + hw * 0.2, top);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = wHeavy;
    ctx.beginPath();
    ctx.moveTo(tx - hw / 2 - 2 * u, top);
    ctx.lineTo(tx + hw / 2 + 2 * u, top);
    ctx.lineTo(tx + 4 * u, top - 22 * u);
    ctx.lineTo(tx - 4 * u, top - 22 * u);
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = cap;
    ctx.fillRect(tx - 1.5 * u, top - 32 * u, 3 * u, 11 * u);
    ctx.fillStyle = THEME.ball;
    ctx.beginPath();
    ctx.arc(tx, top - 33 * u, 3 * u, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = wLight;
    ctx.stroke();
    // the face — paper under the same light, hands telling the level's
    // hour. Lit from inside once the city needs it.
    const fy = top + 17 * u;
    const fr = 11 * u;
    ctx.fillStyle = night > 0.45 || party ? THEME.lamp : amb(THEME.paper);
    ctx.beginPath();
    ctx.arc(tx, fy, fr, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = wMed;
    ctx.stroke();
    // the glass — one diagonal paper bar, the reference's screen glare
    // (Law 4: the scene's highlight mark, drawn, never blended)
    ctx.save();
    ctx.beginPath();
    ctx.arc(tx, fy, fr - 0.5 * u, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = withAlpha(THEME.paper, "b3");
    ctx.beginPath();
    ctx.moveTo(tx - fr * 0.05, fy - fr);
    ctx.lineTo(tx + fr * 0.45, fy - fr);
    ctx.lineTo(tx - fr * 0.45, fy + fr);
    ctx.lineTo(tx - fr * 0.95, fy + fr);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    const hour = 16 + 8 * night; // the ladder's clock
    const ha = ((hour % 12) / 12) * Math.PI * 2 - Math.PI / 2;
    const ma = (hour % 1) * Math.PI * 2 - Math.PI / 2;
    ctx.strokeStyle = INK;
    ctx.lineWidth = wMed;
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

  // ——— the front row — painted houses, Koriko shapes wearing the
  // reference's ink: every silhouette holds the heavy line, every face
  // splits into lit and warm shade, texture is drawn and rationed ———
  let billboard = false;
  let steams = 0;
  let cat = false;
  let shop = false;
  let bricks = 0; // brick dashes on two or three buildings — not all
  let glints = 0; // diagonal glass bars on two or three windows — no more
  const chimneys: { x: number; y: number }[] = [];
  const trees: { x: number; s: number }[] = [];
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
    // the shade side — light from the upper left, so the right of every
    // face drops one value, hard edge at the corner — one step darker
    // and one step warmer, never gray. Two values pretending to be one
    // is what turns a rectangle into architecture.
    const shadeX = bx + bw * 0.72;
    ctx.fillStyle = shade(fc);
    ctx.fillRect(shadeX, top, bw * 0.28, wh);
    ctx.fillStyle = darken(fc, 0.82);
    ctx.fillRect(bx, top, bw, 3 * u);
    // golden hour: the sun-side edge of every wall catches it — the
    // Koriko trick, a lit face answering a shaded one
    if (glow > 0) {
      const ew = (4 + hash01(seed + bi * 5 + 16) * 2.5) * u;
      ctx.fillStyle = mix(fc, THEME.gold, 0.45 * glow);
      ctx.fillRect(bx, top + 3 * u, ew, wh - 3 * u);
    }
    // the silhouette's ink — the wall wears the heavy line; the roof
    // fill will eat the top edge under its eaves, which is correct
    ctx.strokeStyle = INK;
    ctx.lineJoin = "round";
    ctx.lineWidth = wHeavy;
    ctx.strokeRect(bx, top, bw, wh);
    // brick dashes — drawn texture at the light weight, on the lit face
    // only, two or three buildings per row. Drawn before the windows so
    // any collision hides under a pane.
    if (bricks < 3 && hash01(seed + bi * 5 + 23) < 0.3 && bw > 60 * u) {
      bricks++;
      ctx.lineWidth = wLight;
      ctx.lineCap = "round";
      ctx.beginPath();
      // one tight patch of coursework — five dashes in three staggered
      // rows sharing course lines, running bond in shorthand. The same
      // dashes scattered at random y read as specks; alignment is what
      // says "brick".
      const ax = bx + 5 * u + hash01(seed + bi * 31) * Math.max(0, bw * 0.6 - 20 * u);
      const ay = top + 6 * u + hash01(seed + bi * 31 + 3) * Math.max(0, wh - 18 * u);
      for (const [dx2, row] of [
        [0, 0],
        [5.5, 0],
        [2.75, 1],
        [0, 2],
        [5.5, 2],
      ] as const) {
        ctx.moveTo(ax + dx2 * u, ay + row * 3 * u);
        ctx.lineTo(ax + (dx2 + 4) * u, ay + row * 3 * u);
      }
      ctx.stroke();
      ctx.lineCap = "butt";
      ctx.lineWidth = wHeavy;
    }

    // the roof — gable, mansard, or flat parapet, eaves a hair proud
    if (roof < 0.4) {
      // gable
      const gh = (14 + hash01(seed + bi * 5 + 10) * 8) * u;
      ctx.fillStyle = rc;
      ctx.beginPath();
      ctx.moveTo(bx - 3 * u, top);
      ctx.lineTo(bx + bw + 3 * u, top);
      ctx.lineTo(bx + bw * 0.5, top - gh);
      ctx.closePath();
      ctx.fill();
      // lit left slope, shaded right — one step darker and warmer,
      // hard edge at the ridge
      ctx.fillStyle = shade(rc);
      ctx.beginPath();
      ctx.moveTo(bx + bw * 0.5, top - gh);
      ctx.lineTo(bx + bw + 3 * u, top);
      ctx.lineTo(bx + bw * 0.5, top);
      ctx.closePath();
      ctx.fill();
      // the roof's ink — heavy on the silhouette
      ctx.lineWidth = wHeavy;
      ctx.beginPath();
      ctx.moveTo(bx - 3 * u, top);
      ctx.lineTo(bx + bw + 3 * u, top);
      ctx.lineTo(bx + bw * 0.5, top - gh);
      ctx.closePath();
      ctx.stroke();
      if (glow > 0) {
        // gold lick down the sun-side slope
        ctx.strokeStyle = mix(rc, THEME.gold, 0.55 * glow);
        ctx.lineWidth = 2.5 * u;
        ctx.beginPath();
        ctx.moveTo(bx + bw * 0.5, top - gh + 1.5 * u);
        ctx.lineTo(bx - 1.5 * u, top - u);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
      // the attic eye — a round window under the ridge; some are attic
      // lamps at night, most stay dark glass
      if (gh > 15 * u) {
        const ex2 = bx + bw * 0.5;
        const ey = top - gh * 0.36;
        ctx.fillStyle = darken(rc, 0.78);
        ctx.beginPath();
        ctx.arc(ex2, ey, 3.4 * u, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = wLight;
        ctx.stroke();
        ctx.lineWidth = wHeavy;
        const eyeLit = hash01(seed + bi * 5 + 17) < litFrac;
        ctx.fillStyle = eyeLit ? THEME.lamp : darken(fc, 0.55);
        if (eyeLit) ctx.globalAlpha = lampA;
        ctx.beginPath();
        ctx.arc(ex2, ey, 2.2 * u, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
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
      // the shade side of the face — same split the wall wears below,
      // one step darker and warmer
      ctx.fillStyle = shade(rc);
      ctx.beginPath();
      ctx.moveTo(bx + bw * 0.66, top);
      ctx.lineTo(bx + bw + 3 * u, top);
      ctx.lineTo(bx + bw - 9 * u, top - rh + 2.5 * u);
      ctx.lineTo(bx + 9 * u + (bw - 18 * u) * 0.66, top - rh + 2.5 * u);
      ctx.closePath();
      ctx.fill();
      // the mansard's ink
      ctx.lineWidth = wHeavy;
      ctx.beginPath();
      ctx.moveTo(bx - 3 * u, top);
      ctx.lineTo(bx + bw + 3 * u, top);
      ctx.lineTo(bx + bw - 9 * u, top - rh);
      ctx.lineTo(bx + 9 * u, top - rh);
      ctx.closePath();
      ctx.stroke();
      if (glow > 0) {
        // gold lick down the sun-side face of the mansard
        ctx.strokeStyle = mix(rc, THEME.gold, 0.55 * glow);
        ctx.lineWidth = 2.5 * u;
        ctx.beginPath();
        ctx.moveTo(bx + 9 * u, top - rh + 1.5 * u);
        ctx.lineTo(bx - 1.5 * u, top - u);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
      // standing seams — drawn texture at the light weight, spaced wide:
      // the verticals that make a mansard read as metal instead of a
      // painted trapezoid, held under the density cap
      ctx.lineWidth = wLight;
      ctx.beginPath();
      for (let s2 = 1; s2 < Math.floor(bw / (24 * u)); s2++) {
        const t2 = (s2 * 24 * u) / bw;
        ctx.moveTo(bx + bw * t2, top - u);
        ctx.lineTo(bx + 9 * u + (bw - 18 * u) * t2, top - rh + 2.5 * u);
      }
      ctx.stroke();
      ctx.lineWidth = wHeavy;
      // dormers — little roofed windows breaking the mansard face;
      // each one lights on the same forever-hash as the wall windows
      const dn = bw > 90 * u ? 2 : 1;
      for (let d = 0; d < dn; d++) {
        const dx2 = bx + bw * (dn === 2 ? 0.32 + d * 0.36 : 0.5);
        const dw2 = 7 * u;
        const dh2 = Math.min(9 * u, rh - 4 * u);
        const dy = top - dh2 - u;
        ctx.fillStyle = darken(rc, 0.8);
        ctx.fillRect(dx2 - dw2 / 2, dy, dw2, dh2);
        ctx.beginPath();
        ctx.moveTo(dx2 - dw2 / 2 - 1.5 * u, dy);
        ctx.lineTo(dx2 + dw2 / 2 + 1.5 * u, dy);
        ctx.lineTo(dx2, dy - 4 * u);
        ctx.closePath();
        ctx.fill();
        ctx.lineWidth = wLight;
        ctx.stroke();
        ctx.strokeRect(dx2 - dw2 / 2, dy, dw2, dh2);
        ctx.lineWidth = wHeavy;
        const dLit = hash01(seed + bi * 5 + 18 + d) < litFrac;
        ctx.fillStyle = dLit ? THEME.lamp : darken(fc, 0.55);
        if (dLit) ctx.globalAlpha = lampA;
        ctx.fillRect(dx2 - dw2 / 2 + 1.5 * u, dy + 2 * u, dw2 - 3 * u, dh2 - 3.5 * u);
        ctx.globalAlpha = 1;
      }
      // a TV aerial on some lids — one line and two whiskers, in the
      // one ink at the light weight
      if (hash01(seed + bi * 5 + 14) < 0.22) {
        const ax = bx + bw * 0.74;
        ctx.lineWidth = wLight;
        ctx.beginPath();
        ctx.moveTo(ax, top - rh);
        ctx.lineTo(ax, top - rh - 12 * u);
        ctx.moveTo(ax - 5 * u, top - rh - 17 * u);
        ctx.lineTo(ax, top - rh - 12 * u);
        ctx.lineTo(ax + 5 * u, top - rh - 17 * u);
        ctx.stroke();
        ctx.lineWidth = wHeavy;
      }
    } else {
      // flat parapet
      ctx.fillStyle = rc;
      ctx.fillRect(bx - 2 * u, top - 5 * u, bw + 4 * u, 6 * u);
      // its shade end — warmer, not grayer
      ctx.fillStyle = shade(rc);
      ctx.fillRect(bx + bw * 0.66, top - 5 * u, bw * 0.34 + 2 * u, 6 * u);
      if (glow > 0) {
        // the parapet's sun-side end catches the gold too
        ctx.fillStyle = mix(rc, THEME.gold, 0.5 * glow);
        ctx.fillRect(bx - 2 * u, top - 5 * u, 12 * u, 6 * u);
      }
      ctx.lineWidth = wHeavy;
      ctx.strokeRect(bx - 2 * u, top - 5 * u, bw + 4 * u, 6 * u);
      // the cat — takes a parapet right of center for half a minute out
      // of every 89s (prime), and earns the entrance: pads in along the
      // parapet, stands a beat, does the full stretch, then settles in
      // to watch the city — and the game: a ball in the air turns its
      // head and perks its ears. It leaves on foot the way it came. No
      // fades anywhere — cats arrive, they don't materialize.
      if (!cat && bx > W * 0.5 && bx + bw < W * 0.95) {
        cat = true;
        const ct2 = now - 70;
        const tIn = ct2 > 0 ? ct2 % 89 : -1;
        if (tIn >= 0 && tIn < 26) {
          const dir = hash01(Math.floor(ct2 / 89) * 11 + 2) > 0.5 ? 1 : -1;
          // the visit's beats, all positions pure functions of tIn:
          // pad in, stand a moment, the stretch, the long sit, pad off
          const IN = 2.2;
          const PAUSE = 2.7;
          const STR = 4.6;
          const LEAVE = 23.6;
          const mid = bx + bw * 0.5;
          const enterX = dir > 0 ? bx - 16 * u : bx + bw + 16 * u;
          const exitX = dir > 0 ? bx + bw + 16 * u : bx - 16 * u;
          const cx3 =
            tIn < IN
              ? enterX + (mid - enterX) * (tIn / IN)
              : tIn < LEAVE
                ? mid
                : mid + (exitX - mid) * ((tIn - LEAVE) / (26 - LEAVE));
          const moving = tIn < IN || tIn >= LEAVE;
          ctx.save();
          // clipped to its own rooftop — it emerges over one roof edge
          // and leaves past the other, never hanging in the air
          ctx.beginPath();
          ctx.rect(bx - 2 * u, top - 44 * u, bw + 4 * u, 45 * u);
          ctx.clip();
          // faces where it's going; a seated cat snaps around to track
          // a live ball — a two-frame turn, like every cut around here
          const face = !moving && tIn >= STR && gaze ? 1 : -dir;
          ctx.translate(cx3, top - 5 * u);
          ctx.scale(face * u, u);
          ctx.globalAlpha = 0.85;
          ctx.fillStyle = INK;
          ctx.strokeStyle = INK;
          ctx.lineCap = "round";
          if (tIn < PAUSE || tIn >= LEAVE) {
            // on the move (or stood taking the roof's measure): long
            // body, head forward, tail carried high; the legs snap
            // between two frames, no tween — the bird's law
            const stp = Math.floor(now * 5) % 2;
            ctx.beginPath();
            ctx.ellipse(0, -5.5, 7, 3.2, 0, 0, Math.PI * 2); // body
            ctx.moveTo(-4.8, -7.5);
            ctx.arc(-8, -7.5, 3, 0, Math.PI * 2); // head
            ctx.moveTo(-10.2, -9.4);
            ctx.lineTo(-9.7, -12.6); // far ear
            ctx.lineTo(-8.1, -10.2);
            ctx.moveTo(-6.9, -10.4);
            ctx.lineTo(-5.9, -12.4); // near ear
            ctx.lineTo(-5.1, -9.9);
            ctx.fill();
            ctx.lineWidth = 1.7;
            ctx.beginPath();
            for (const [hx, ph2] of [
              [-5, 0],
              [-2.6, 1],
              [2.8, 1],
              [5.2, 0],
            ] as const) {
              const sw2 = moving ? (stp === ph2 ? 1.5 : -1.1) : 0;
              ctx.moveTo(hx, -4.6);
              ctx.lineTo(hx + sw2, -0.2);
            }
            ctx.stroke();
            ctx.lineWidth = 1.8;
            ctx.beginPath();
            ctx.moveTo(6.2, -5.5);
            ctx.quadraticCurveTo(9.5, -8, 9.8, -13);
            ctx.stroke();
          } else if (tIn < STR) {
            // the full stretch — a play-bow: rump high, back dipping,
            // chest low over the stretched forelegs, head UP and
            // forward. (The head used to sit low over the paws and the
            // silhouette read as a cat folded in half.) The reason to
            // keep a rooftop.
            ctx.beginPath();
            ctx.ellipse(4.2, -6.2, 4.4, 4.2, 0, 0, Math.PI * 2); // the rump, up
            ctx.rect(2.6, -2.5, 1.7, 2.4); // rear legs planted
            ctx.rect(5.4, -2.5, 1.7, 2.4);
            // the back dips off the rump and climbs to the raised head;
            // chest low, forelegs stretched flat out to the paws
            ctx.moveTo(6.5, -9.4);
            ctx.quadraticCurveTo(0, -4.9, -6.4, -6.6);
            ctx.lineTo(-7.6, -4.2);
            ctx.lineTo(-11.4, -0.8);
            ctx.lineTo(-11.4, 0.2);
            ctx.lineTo(-1.6, 0.2);
            ctx.quadraticCurveTo(1.4, -0.6, 3.2, -1.6);
            ctx.closePath();
            // the head up and forward, chin above the paws
            ctx.moveTo(-5.5, -8.2);
            ctx.arc(-8.4, -8.2, 2.9, 0, Math.PI * 2);
            ctx.moveTo(-10.4, -10.2);
            ctx.lineTo(-9.8, -13.2); // far ear
            ctx.lineTo(-8.2, -10.8);
            ctx.moveTo(-6.8, -11);
            ctx.lineTo(-5.9, -13); // near ear
            ctx.lineTo(-5.1, -10.4);
            ctx.fill();
            ctx.lineWidth = 1.8;
            ctx.beginPath();
            ctx.moveTo(7.3, -8.5);
            ctx.quadraticCurveTo(10.8, -12.5, 9.9, -17.5);
            ctx.stroke();
          } else {
            // the long sit — the statue with a pulse: the tail keeps
            // time, and after dark the lamp eyes drop a slow blink now
            // and then — cat for "all is well"
            const perk = gaze ? 1.6 : 0; // ears up for a live ball
            ctx.beginPath();
            ctx.ellipse(0, -4.5, 6, 4.5, 0, 0, Math.PI * 2); // sitting body
            ctx.moveTo(-3.1, -8);
            ctx.arc(-6.5, -8, 3.4, 0, Math.PI * 2); // head
            ctx.moveTo(-8.8, -10);
            ctx.lineTo(-8.2, -13.5 - perk); // far ear
            ctx.lineTo(-6.5, -10.8);
            ctx.moveTo(-5.2, -11);
            ctx.lineTo(-4.2, -13.2 - perk); // near ear
            ctx.lineTo(-3.4, -10.5);
            ctx.fill();
            const sw = Math.sin(now * 1.3) * 3;
            ctx.lineWidth = 1.8;
            ctx.beginPath();
            ctx.moveTo(5.5, -3);
            ctx.quadraticCurveTo(10, -6, 10.5 + sw * 0.3, -12 + sw);
            ctx.stroke();
            if (night > 0.4) {
              const bl = (now * 0.137) % 1; // a blink every ~7.3s
              const shut = bl < 0.07 ? 1 - Math.sin((bl / 0.07) * Math.PI) : 1;
              const eh = 1.4 * shut;
              ctx.fillStyle = THEME.lamp;
              ctx.fillRect(-8.4, -8.6 + (1.4 - eh) / 2, 1.4, eh);
              ctx.fillRect(-5.9, -8.6 + (1.4 - eh) / 2, 1.4, eh);
            }
          }
          ctx.restore();
        }
      }
    }

    // chimney — brick stub off-ridge; a couple of them still smoke
    if (hash01(seed + bi * 5 + 11) < 0.45) {
      const cx2 = bx + bw * (0.18 + hash01(seed + bi * 5 + 12) * 0.3);
      const ct = top - (roof < 0.4 ? 18 : roof < 0.72 ? 20 : 12) * u;
      const cc = darken(fc, 0.72);
      ctx.fillStyle = cc;
      ctx.fillRect(cx2 - 4 * u, ct, 8 * u, top - ct + 2 * u);
      ctx.fillRect(cx2 - 5.5 * u, ct - 3 * u, 11 * u, 3.5 * u);
      // its shade flank — even a brick stub carries two lights (Law 2)
      ctx.fillStyle = shade(cc);
      ctx.fillRect(cx2 + 1.5 * u, ct, 2.5 * u, top - ct + 2 * u);
      // the stub's ink — an object against the sky wears the line
      ctx.strokeStyle = INK;
      ctx.lineWidth = wMed;
      ctx.strokeRect(cx2 - 4 * u, ct, 8 * u, top - ct + 2 * u);
      ctx.strokeRect(cx2 - 5.5 * u, ct - 3 * u, 11 * u, 3.5 * u);
      // clay pots on most caps — the two-teeth silhouette every old
      // European roofline has
      if (hash01(seed + bi * 5 + 19) < 0.6) {
        ctx.fillStyle = darken(amb("#bd6b52"), 0.92);
        ctx.fillRect(cx2 - 3.6 * u, ct - 7.5 * u, 2.6 * u, 4.5 * u);
        ctx.fillRect(cx2 + u, ct - 7.5 * u, 2.6 * u, 4.5 * u);
      }
      chimneys.push({ x: cx2, y: ct - 3 * u });
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
      ctx.strokeStyle = INK;
      ctx.lineWidth = wMed;
      ctx.stroke();
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
              // panes on the shade side sit one step darker still —
              // the windows obey the light like everything else
              ctx.fillStyle = wx > shadeX ? darken(fc, 0.46) : paneInk;
              ctx.fillRect(wx, wy, 5 * u, 7 * u);
              // the glass glint — one diagonal paper bar, two or three
              // panes per row (Law 4: if it reads as pattern, halve it)
              if (glints < 3 && wx < shadeX && hash01(seed + bi * 211 + r * 13 + c * 5) < 0.04) {
                glints++;
                ctx.fillStyle = withAlpha(THEME.paper, "99");
                ctx.beginPath();
                ctx.moveTo(wx + 3.1 * u, wy);
                ctx.lineTo(wx + 4.5 * u, wy);
                ctx.lineTo(wx + 1.4 * u, wy + 7 * u);
                ctx.lineTo(wx, wy + 7 * u);
                ctx.closePath();
                ctx.fill();
              }
            }
          }
        }
      }
    }

    // the shopfront — one per row: a wide warm window under a striped
    // scalloped awning, the bakery-at-street-level move. Lit from
    // opening time on; the street's one standing invitation.
    if (!shop && bw > 84 * u && wh > 55 * u && roof < 0.72) {
      shop = true;
      const sx0 = bx + 9 * u;
      const sw2 = bw - 18 * u;
      const sy0 = floorY - 16 * u;
      ctx.fillStyle = darken(fc, 0.7);
      ctx.fillRect(sx0 - 1.5 * u, sy0 - 1.5 * u, sw2 + 3 * u, 15 * u);
      ctx.strokeStyle = INK;
      ctx.lineWidth = wMed;
      ctx.strokeRect(sx0 - 1.5 * u, sy0 - 1.5 * u, sw2 + 3 * u, 15 * u);
      const open = night > 0.1 || party;
      ctx.fillStyle = open ? THEME.lamp : amb(THEME.paper);
      if (open) ctx.globalAlpha = Math.min(1, lampA + 0.15);
      ctx.fillRect(sx0, sy0, sw2, 12 * u);
      ctx.globalAlpha = 1;
      // mullions splitting the glass into panes — detail marks, the
      // light line
      ctx.strokeStyle = INK;
      ctx.lineWidth = wLight;
      ctx.beginPath();
      for (let m = 1; m < 3; m++) {
        ctx.moveTo(sx0 + (sw2 * m) / 3, sy0);
        ctx.lineTo(sx0 + (sw2 * m) / 3, sy0 + 12 * u);
      }
      ctx.stroke();
      // the awning — stripes and scallops over the glass; the stripes
      // right of the wall's shade edge drop to their shade value, hard
      // edge on a stripe boundary — cloth obeys the light too
      const ax0 = sx0 - 4 * u;
      const aw = sw2 + 8 * u;
      const ay = sy0 - 9.5 * u;
      const ah = 6 * u;
      const stripes = Math.max(4, Math.round(aw / (11 * u)));
      const stw = aw / stripes;
      for (let s2 = 0; s2 < stripes; s2++) {
        let stc = amb(s2 % 2 ? "#f2e6cf" : "#c85a4e");
        if (ax0 + (s2 + 0.5) * stw > shadeX) stc = shade(stc);
        ctx.fillStyle = stc;
        ctx.beginPath();
        ctx.rect(ax0 + s2 * stw, ay, stw, ah);
        ctx.moveTo(ax0 + (s2 + 1) * stw, ay + ah);
        ctx.arc(ax0 + (s2 + 0.5) * stw, ay + ah, stw / 2, 0, Math.PI);
        ctx.fill();
        // each scallop's underside, one warm step down — cloth has a
        // shadow edge or it reads as paper
        ctx.strokeStyle = shade(stc);
        ctx.lineWidth = 1.2 * u;
        ctx.beginPath();
        ctx.arc(ax0 + (s2 + 0.5) * stw, ay + ah, stw / 2 - 0.6 * u, 0.2, Math.PI - 0.2);
        ctx.stroke();
      }
      // one line around the cloth — the awning is a near object and
      // wears the ink like everything else on the street
      ctx.strokeStyle = INK;
      ctx.lineWidth = wMed;
      ctx.beginPath();
      ctx.moveTo(ax0, ay);
      ctx.lineTo(ax0 + aw, ay);
      for (let s2 = stripes - 1; s2 >= 0; s2--) {
        ctx.arc(ax0 + (s2 + 0.5) * stw, ay + ah, stw / 2, 0, Math.PI);
      }
      ctx.closePath();
      ctx.stroke();
      // the cloth's thrown shadow — the one SHADOW ink banded on the
      // glass under the scallops, pushed right like every shadow (Law 3)
      ctx.fillStyle = SHADOW;
      ctx.fillRect(ax0 + 3 * u, ay + ah + stw / 2, aw - 3 * u, 2 * u);
    }

    // row houses touch; an alley now and then shows the layer behind —
    // and a street tree stands in it, the green the masonry was missing
    // (Koriko is stone punctured by mint; ours was all stone)
    if (hash01(seed + bi * 3 + 4) < 0.24) {
      if (trees.length < 3)
        trees.push({ x: bx + bw + 9 * u, s: hash01(seed + bi * 7 + 21) });
      bx += bw + 18 * u;
    } else {
      bx += bw - 1;
    }
  }

  // ——— the street trees — drawn after the houses so their crowns
  // pucker past the facades the way Koriko's do. Two-tone paper lobes,
  // shade under light, leaning on the same lazy wind as the clouds. ———
  for (const [ti, tr] of trees.entries()) {
    const th2 = (13 + tr.s * 5) * u;
    const cr = (8.5 + tr.s * 3.5) * u;
    const cy2 = floorY - th2 - cr * 0.7;
    const lean = Math.sin(now * 0.4 + ti * 2.1) * 1.4 * u;
    // its shadow pool — the scene's one shadow ink, thrown a step to
    // the right by the upper-left light
    ctx.fillStyle = SHADOW;
    ctx.beginPath();
    ctx.ellipse(tr.x + 2.4 * u, floorY - 1.4 * u, cr * 0.9, 1.5 * u, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = amb("#6b4a34");
    ctx.fillRect(tr.x - 1.8 * u, floorY - th2 - 2 * u, 3.6 * u, th2 + 2 * u);
    ctx.strokeStyle = INK;
    ctx.lineWidth = wMed;
    ctx.strokeRect(tr.x - 1.8 * u, floorY - th2 - 2 * u, 3.6 * u, th2 + 2 * u);
    const lit = amb("#7fcb96");
    const lobes = [
      [0, 0, 1],
      [-0.72, 0.28, 0.62],
      [0.72, 0.28, 0.62],
      [0.08, -0.68, 0.6],
    ] as const;
    const passes = [
      { col: shade(lit), ox: lean * 0.5, oy: 0 },
      { col: lit, ox: lean, oy: -2.4 * u },
    ];
    // the crown's ink first — every lobe of both passes stroked, then
    // the fills laid over: the fill eats the interior ink and leaves
    // one heavy line around the union, which is how a crayon tree gets
    // a single outline out of five circles
    ctx.strokeStyle = INK;
    ctx.lineWidth = wHeavy * 2;
    ctx.beginPath();
    for (const pass of passes) {
      for (const [lx, ly, lr] of lobes) {
        ctx.moveTo(tr.x + pass.ox + (lx + lr) * cr, cy2 + pass.oy + ly * cr);
        ctx.arc(tr.x + pass.ox + lx * cr, cy2 + pass.oy + ly * cr, lr * cr, 0, Math.PI * 2);
      }
    }
    ctx.stroke();
    for (const pass of passes) {
      ctx.fillStyle = pass.col;
      ctx.beginPath();
      // each lobe its own subpath — the clouds' rule
      for (const [lx, ly, lr] of lobes) {
        ctx.moveTo(tr.x + pass.ox + (lx + lr) * cr, cy2 + pass.oy + ly * cr);
        ctx.arc(tr.x + pass.ox + lx * cr, cy2 + pass.oy + ly * cr, lr * cr, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    if (glow > 0) {
      // the sun catches the crown's near cheek
      ctx.fillStyle = mix(lit, THEME.gold, 0.45 * glow);
      ctx.beginPath();
      ctx.arc(tr.x + lean - cr * 0.5, cy2 - 2.4 * u - cr * 0.2, cr * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // contact shadow — one dark seam where the row meets the street, so
  // the houses sit on the ground instead of hovering over it (Law 3:
  // the one shadow ink, shared with every pool in the scene)
  ctx.fillStyle = SHADOW;
  ctx.fillRect(0, floorY - 2.5 * u, W, 2.5 * u);

  // string lights — one wire between the first close pair of chimneys.
  // A bare line by day; at night it's a strand of warm bulbs, the
  // rooftop version of the whole game's arc: the city lights up as you
  // climb.
  {
    let p0: { x: number; y: number } | null = null;
    let p1: { x: number; y: number } | null = null;
    for (let i = 0; i + 1 < chimneys.length; i++) {
      const dx = chimneys[i + 1].x - chimneys[i].x;
      if (dx > 50 * u && dx < 200 * u) {
        p0 = chimneys[i];
        p1 = chimneys[i + 1];
        break;
      }
    }
    if (p0 && p1) {
      const sag = (p1.x - p0.x) * 0.14;
      const cxm = (p0.x + p1.x) / 2;
      const cym = (p0.y + p1.y) / 2 + 2 * sag; // quadratic control: mid sags by `sag`
      ctx.strokeStyle = withAlpha(INK, "59");
      ctx.lineWidth = 1.2 * u;
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.quadraticCurveTo(cxm, cym, p1.x, p1.y);
      ctx.stroke();
      ctx.lineWidth = 1;
      const on = party || night > 0.3;
      for (let i = 0; i < 7; i++) {
        const t = 0.2 + i * 0.1;
        const gx = (1 - t) * (1 - t) * p0.x + 2 * (1 - t) * t * cxm + t * t * p1.x;
        const gy =
          (1 - t) * (1 - t) * p0.y + 2 * (1 - t) * t * cym + t * t * p1.y + 2.5 * u;
        if (on) {
          // every other bulb throws a soft halo — the strand glows
          // instead of just dotting
          if (i % 2 === 0) {
            ctx.fillStyle = THEME.lamp;
            ctx.globalAlpha = lampA * 0.16;
            ctx.beginPath();
            ctx.arc(gx, gy, 4.5 * u, 0, Math.PI * 2);
            ctx.fill();
          }
          // each bulb breathes on its own beat
          ctx.fillStyle = THEME.lamp;
          ctx.globalAlpha = lampA * (0.75 + 0.25 * Math.sin(now * 1.9 + i * 2.4));
        } else {
          ctx.fillStyle = withAlpha(INK, "66");
        }
        ctx.beginPath();
        ctx.arc(gx, gy, (on ? 2.2 : 1.6) * u, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }
}

const kickSpring = createSpring({ stiffness: 320, damping: 14, mass: 1 });

// pennant ceremony timing — a new flag leaves the net HOIST_DELAY after
// the swish and flies for RISE seconds to its slot on the rope. The
// cleared phase holds until the raise lands: nobody misses their own
// ceremony.
const HOIST_DELAY = 0.6;
const RISE = 0.8;

// one flag color per level, flown by the in-game rafter rope AND the
// header's ladder — the same six cloths in both places, never drifting
const FLAG_COLORS = [
  THEME.rim,
  THEME.headband,
  THEME.ball,
  THEME.grass,
  THEME.paper,
  THEME.gold,
] as const;

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
  // clamp in pre-V_SCALE units (the 14-24 bounds were tuned there),
  // then convert — the physical gesture is exactly what it was
  return Math.max(14, Math.min(24, (s * 0.58 * V_SCALE) / MAX_POWER)) / V_SCALE;
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
type Pose = "aim" | "watch" | "panic" | "joy" | "triumph" | "champ" | "rest";

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
    return parseRun(localStorage.getItem(RUN_KEY), localDay());
  } catch {
    return parseRun(null, localDay()); // storage blocked — fresh player
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
    /** trailing drag samples — the release stabilizer's evidence */
    hist: { t: number; x: number; y: number }[];
  } | null>(null);
  const trailRef = useRef<{ x: number; y: number }[]>([]);
  const ballRotRef = useRef(0); // the leather spins in flight
  const sparksRef = useRef<Spark[]>([]);
  const seenTouchesRef = useRef(0);
  const lastRimAtRef = useRef(-Infinity); // panic window
  const madeRef = useRef(false);
  const bestDepthRef = useRef(0); // gates the new-deepest ceremony
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
  // deepest level cleared today — the record that resets overnight. A
  // career best plateaus; this one is beatable again every session.
  const todayBestRef = useRef(0);
  const matchedRef = useRef(false); // this make re-reached the career best today
  // HUD state
  const [phase, setPhase] = useState<Phase>("aim");
  const [levelIdx, setLevelIdx] = useState(0);
  const [runState, setRunState] = useState<RunState | null>(null);
  const [last, setLast] = useState<LastShot | null>(null);
  const [sndOn, setSndOn] = useState(true);
  const [copied, setCopied] = useState(false);
  const [practiceLeft, setPracticeLeft] = useState(0);
  const [practiced, setPracticed] = useState(false); // this death's session, spent
  // the card's choreography clock — a press mid-ceremony completes it
  // instead of advancing, so a masher's double-tap is skip + restart
  const verdictApiRef = useRef<VerdictApi | null>(null);

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
      todayBestRef.current = s.todayDepth;
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
    matchedRef.current = false;
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
      // the cleared level takes its bow — that level's phrase from the
      // transcription, timed to the enter card's slam
      sound.levelClear(ni);
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
          todayDepth: Math.max(prev.todayDepth, depth),
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
      // the death — grief scales with stakes: shallow deaths (levels
      // 1-2) get the dry brick, built to survive 900 straight plays;
      // past that, touched iron gets the rim-out and everything else
      // the Dorian heartbreaker
      if (levelIdxRef.current < 2) sound.brick();
      else if (rims > 0) sound.rimOut();
      else sound.heartbreaker();
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
    // he's even-keeled: only beating the whole game moves his feet.
    // Every other beat he holds his frame — the old idle bob read as
    // aimless bouncing on the death card, and stillness is his register.
    if (pose === "triumph") dy = age < 0.64 ? [-1, 0, -1, 0][Math.floor(age / 0.16)] : 0;
    // holding the ball he's set — crouch into the pull, no bouncing.
    // Only once the pull ARMS: a ghost pull isn't a shot, so bailing
    // out of one can't pop him back up like a hop.
    else if (pose === "aim") {
      const d = dragRef.current;
      dy = d && isArmed(d) ? 1 : 0;
    }

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
    // Law 6: the heaviest silhouette in the scene belongs to him alone —
    // one full tier above the furniture's line
    const lw = Math.max(2.6, k * 0.66);

    // his shadow — stays on the ground when he hops, like the reference's
    // flat unblurred pools under every object; the scene's one shadow ink,
    // thrown a touch right, agreeing with the upper-left light
    ctx.fillStyle = SHADOW;
    ctx.beginPath();
    ctx.ellipse(cx + 1.3 * k, floorY + 2, (side ? 3.6 : 4.5) * k, 1.1 * k, 0, 0, Math.PI * 2);
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
      // the jeans' shade leg — the one away from the upper-left light
      // (in profile the far leg) drops one value, same rule as the city
      ctx.strokeStyle = (side ? lx < 0 : lx > 0) ? shade(FUR) : FUR;
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
    // square bottom corners — the hem over the pants is a straight
    // line. Legs read leg-length by raising the hem; the torso also
    // grows upward (shoulders at -13.2) so the chest isn't a stub
    // either — the head and arms ride up with it. Both views share the
    // proportions; only the chest depth differs.
    const torso = () => {
      ctx.beginPath();
      if (side) ctx.roundRect(cx - 2.1 * k, foot - 15.4 * k, 4.2 * k, 7.0 * k, [1.7 * k, 1.7 * k, 0, 0]);
      else ctx.roundRect(cx - 3.2 * k, foot - 13.2 * k, 6.4 * k, 5.6 * k, [1.7 * k, 1.7 * k, 0, 0]);
    };
    torso();
    ctx.fillStyle = HOODIE;
    ctx.fill();
    // the fleece's shade side — one darker tone, hard edge, the same
    // upper-left light every wall in the city answers to
    ctx.save();
    torso();
    ctx.clip();
    ctx.fillStyle = shade(HOODIE);
    ctx.fillRect(cx + (side ? 0.7 : 1.3) * k, foot - 15.4 * k, 3.6 * k, 7.4 * k);
    ctx.restore();
    // the silhouette carries his heaviest line — hierarchy: contour,
    // then seams, then features
    torso();
    ctx.lineWidth = lw;
    ctx.stroke();
    // the kangaroo pocket — one stop darker, low on the hem; the
    // profile keeps the fleece clean
    if (!side) {
      ctx.fillStyle = POCKET;
      ctx.beginPath();
      ctx.roundRect(cx - 1.7 * k, foot - 9.8 * k, 3.4 * k, 2.2 * k, 0.6 * k);
      ctx.fill();
      ctx.lineWidth = Math.max(1, lw * 0.8); // interior seam — a step lighter
      ctx.stroke();
      ctx.lineWidth = lw;
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
        : pose === "joy" || pose === "rest" || pose === "champ"
          ? [
              [-3.5, -8.8, -3.6, -6.0],
              [3.5, -8.8, 3.6, -6.0],
            ] // both verdicts: arms straight down, nothing performed —
              // the turn and the face carry the reaction
          : pose === "panic"
            ? [
                [-5.0, -10.2, -6.8, -10.2],
                [5.0, -10.2, 6.8, -10.2],
              ] // hands held out, steady — braced, not flailing
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
        // hands take his thinnest line — the hierarchy's bottom rung
        ctx.lineWidth = side ? lw * 0.8 : lw * 0.65;
        ctx.beginPath();
        ctx.arc(handX, handY, (side ? 1.05 : 0.9) * k, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      });
      ctx.lineWidth = lw; // hand back the contour weight
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
      // two small tufts off the crown — the same pair the frontal head
      // wears; without them the profile hair reads helmet, not haircut
      ctx.beginPath();
      ctx.moveTo(cx + 0.2 * k, foot - 18.55 * k);
      ctx.quadraticCurveTo(cx + 0.8 * k, foot - 19.9 * k, cx + 1.6 * k, foot - 18.5 * k);
      ctx.moveTo(cx + 1.9 * k, foot - 18.3 * k);
      ctx.quadraticCurveTo(cx + 2.7 * k, foot - 19.3 * k, cx + 3.2 * k, foot - 17.85 * k);
      ctx.fill();
      ctx.stroke();
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
    // three chunky teeth, matching the profile fringe's scale — the old
    // eight-tooth zigzag read as noise at phone size
    const zig: readonly (readonly [number, number])[] = [
      [-4.6, -15.6],
      [-2.9, -13.9],
      [-1.4, -15.2],
      [0.3, -13.7],
      [1.9, -15.2],
      [3.3, -13.9],
      [4.6, -15.5],
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
    // his signature eyes — the profile's dark glinted oval, worn as a
    // pair. Both reaction faces (joy, rest) use them; the mouth is the
    // only thing the verdict changes.
    const glintOvals = () => {
      ctx.fillStyle = OUTLINE;
      for (const ex of [-1.9, 1.9]) {
        ctx.beginPath();
        ctx.ellipse(cx + ex * k, eyeY, 0.62 * k, 0.75 * k, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = PAPER;
      for (const ex of [-1.9, 1.9]) {
        ctx.beginPath();
        ctx.arc(cx + (ex + 0.15) * k, eyeY - 0.15 * k, 0.2 * k, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = OUTLINE;
    };
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
    } else if (pose === "champ") {
      // the poster champion — 6/6 earns the shades: one wraparound
      // shield in the sunset-mirror colorway, worn nowhere else. Flat
      // translation of the real pair: the mirror gradient posterized
      // into three hard bands (brick heat → gold → teal), a gold brow
      // bar for the neon frame, ink nose notch, paper glint where the
      // light grazes. No logos — features stay small. The small make
      // smile stays under it; the crown still does the talking.
      const gx = cx - 4.7 * k;
      const gw = 9.4 * k;
      const gy = eyeY - 1.3 * k;
      const gh = 2.45 * k;
      const shield = () => {
        ctx.beginPath();
        ctx.roundRect(gx, gy, gw, gh, [0.5 * k, 0.5 * k, 1.2 * k, 1.2 * k]);
      };
      ctx.save();
      shield();
      ctx.clip();
      ctx.fillStyle = THEME.rim;
      ctx.fillRect(gx, gy, gw, 1.05 * k);
      ctx.fillStyle = YELLOW;
      ctx.fillRect(gx, gy + 1.05 * k, gw, 0.7 * k);
      ctx.fillStyle = TEAL;
      ctx.fillRect(gx, gy + 1.75 * k, gw, gh - 1.75 * k);
      // light grazing the mirror — two paper dashes, angled off the
      // scene's upper-left light, and no more
      ctx.strokeStyle = PAPER;
      ctx.lineWidth = Math.max(1, k * 0.4);
      ctx.beginPath();
      ctx.moveTo(cx - 3.3 * k, gy + 1.9 * k);
      ctx.lineTo(cx - 2.2 * k, gy + 0.6 * k);
      ctx.moveTo(cx - 1.9 * k, gy + 2.0 * k);
      ctx.lineTo(cx - 1.35 * k, gy + 1.35 * k);
      ctx.stroke();
      // the nose notch — an ink arch pushing up into the lens
      ctx.fillStyle = OUTLINE;
      ctx.beginPath();
      ctx.moveTo(cx - 0.8 * k, gy + gh);
      ctx.quadraticCurveTo(cx, gy + gh - 1.6 * k, cx + 0.8 * k, gy + gh);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      // the shield's one ink line, then the brow bar over its top edge
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = Math.max(1, lw * 0.8);
      shield();
      ctx.stroke();
      ctx.fillStyle = YELLOW;
      ctx.beginPath();
      ctx.roundRect(gx - 0.25 * k, gy - 0.5 * k, gw + 0.5 * k, 0.85 * k, 0.4 * k);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = OUTLINE;
      ctx.lineWidth = feat;
      ctx.beginPath();
      ctx.arc(cx, foot - 12.1 * k, 0.8 * k, Math.PI * 0.2, Math.PI * 0.8);
      ctx.stroke();
    } else if (pose === "joy") {
      // one make in four he mugs for the camera instead — the smug
      // pout: one eye squinted flat, the other wide, duck lips pushed
      // off-center, and the jawline grown into the silhouette (an
      // interior jaw line just reads as a beard smudge at this size).
      // Hashed off the swish timestamp so it's stable for the whole
      // hold and rerolls each make.
      if (hash01(Math.floor(eventAtRef.current * 997)) < 0.25) {
        // the chin wedge — FACE fill tucked above the head outline's
        // ink band (no seam sliver), only the V sides inked, then the
        // fill restated to clean the stroke's inner edge
        ctx.fillStyle = FACE;
        ctx.beginPath();
        ctx.moveTo(cx - 2.2 * k, foot - 10.75 * k);
        ctx.lineTo(cx - 0.6 * k, foot - 9.4 * k);
        ctx.lineTo(cx + 1.4 * k, foot - 10.75 * k);
        ctx.closePath();
        ctx.fill();
        ctx.lineWidth = lw; // the jaw is silhouette — contour weight
        ctx.beginPath();
        ctx.moveTo(cx - 2.35 * k, foot - 10.45 * k);
        ctx.lineTo(cx - 0.6 * k, foot - 9.4 * k);
        ctx.lineTo(cx + 1.55 * k, foot - 10.45 * k);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx - 2.2 * k, foot - 10.72 * k);
        ctx.lineTo(cx - 0.62 * k, foot - 9.45 * k);
        ctx.lineTo(cx + 1.4 * k, foot - 10.72 * k);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = OUTLINE;
        ctx.lineWidth = feat;
        ctx.beginPath();
        ctx.moveTo(cx - 2.6 * k, eyeY);
        ctx.lineTo(cx - 1.2 * k, eyeY);
        ctx.stroke();
        ctx.beginPath();
        ctx.ellipse(cx + 1.9 * k, eyeY, 0.62 * k, 0.75 * k, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = PAPER;
        ctx.beginPath();
        ctx.arc(cx + 2.05 * k, eyeY - 0.15 * k, 0.2 * k, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = OUTLINE;
        ctx.beginPath();
        ctx.ellipse(cx - 0.8 * k, foot - 11.85 * k, 0.75 * k, 0.45 * k, -0.14, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // the default make face — eyes wide open on the camera, small
        // smile, arms staying down. The mouth is the only thing a
        // make changes; the old fist-pump read as a cheesy wave.
        glintOvals();
        ctx.beginPath();
        ctx.arc(cx, foot - 12.1 * k, 0.8 * k, Math.PI * 0.2, Math.PI * 0.8);
        ctx.stroke();
      }
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
      // the post-miss stare — glinted ovals, flat mouth. Says "again"
      // better than any frown; the stillness is the expression. He
      // stands dead still on the death card now (no bob), so a slow
      // two-frame blink keeps him alive without moving his feet.
      if (now % 3.6 > 3.46) {
        ctx.beginPath();
        for (const ex of [-1.9, 1.9]) {
          ctx.moveTo(cx + (ex - 0.62) * k, eyeY);
          ctx.lineTo(cx + (ex + 0.62) * k, eyeY);
        }
        ctx.stroke();
      } else {
        glintOvals();
      }
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
    if (pose === "triumph" || pose === "champ") {
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

  // the ball — mustard leather in a thick outline, thin dark seams spun
  // by rot, with the scene's hard two-light crescent pinned to the
  // upper-left light (the shade stays put while the seams spin). Shared
  // by the rAF loop (at true physics size so rim reads honest) and the
  // share card.
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
    // the shade crescent — drawn before the spin so it stays fixed to
    // the light: lower-right sliver, hard edge, warm (Law 2)
    ctx.fillStyle = shade(MUSTARD);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.arc(-r * 0.22, -r * 0.22, r * 1.06, 0, Math.PI * 2, true);
    ctx.fill();
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
    // re-ink the leather over the clipped edges — a permanent step up
    // in weight, the motion-audit fix: the mustard fill carries the
    // ball over dark bands and this ink carries it over the sunset
    // skies it nearly matches, so one edge always reads at any altitude
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = Math.max(2, r * 0.13);
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

      // the intro card hands off to aim on its own — no press needed.
      // 1.5s: two lines take two reads — "LEVEL 4 — MATCH POINT" plus
      // its sub — and a press still skips straight to aiming
      if (phaseRef.current === "enter" && now - phaseAtRef.current > 1.5) {
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
      // fit the ACTION SPAN — a breath behind the shooter to a breath
      // past the glass — by both axes and center it. Court outside the
      // span is physics runway, not picture; misses still exit stage
      // right, just off-camera, and the empty sky above 4.7m stays
      // cropped (ceilings live at 4.4-4.5). The pads ARE the
      // composition: 1.5m behind the launch is the shooter's stance
      // (~0.33m back) plus his body plus a real margin of lawn — the
      // frame is allowed past the court's x=0 edge, the ground draws
      // full-width anyway and clamping there pinned him to the bezel;
      // 0.55m past the glass covers the pole plus a matching margin.
      // STRICT fit, no overzoom — an object flush against a phone's
      // bezel reads as a rendering bug, and both edge objects here are
      // protagonists.
      let x0 = level.launch.x - 1.5;
      const spanEnd = Math.min(
        level.w,
        level.rim.x + RIM_GAP + BOARD_OFF + 0.55,
      );
      let spanW = spanEnd - x0;
      let scale = Math.min(W / spanW, (H - 20) / 4.7);
      // ...but the pad is a SCREEN promise, not a world one. On phones
      // the width-fit shrinks 1.5m to ~70-85px on the wide levels (2-6)
      // and the shooter reads pinned to the bezel. Guarantee him ~28% of
      // the width (capped at 125px, which desktop already clears) and
      // zoom out to buy the room. Level 1's short span clears the floor
      // as-is, so it keeps its tight framing.
      const minPad = Math.min(125, 0.32 * W);
      if (W / spanW <= (H - 20) / 4.7 && 1.5 * scale < minPad) {
        const rest = spanEnd - level.launch.x;
        x0 = level.launch.x - (rest * minPad) / (W - minPad);
        spanW = spanEnd - x0;
        scale = Math.min(W / spanW, (H - 20) / 4.7);
      }
      const ox = (W - spanW * scale) / 2 - x0 * scale;
      // wide screens pin the floor near the bottom — leaving room for the
      // 16px asphalt cap plus a band of grass; tall screens sit the court
      // LOW (30% of the leftover below, capped at 64px of foreground) so
      // the arc gets the headroom and the ball plays in the thumb zone —
      // a portrait phone was carrying 100px+ of dead lawn under the court
      const grassBand = Math.min(0.3 * (H - level.h * scale), 64);
      const floorY = Math.min(H - 32, H - grassBand);
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
          // impact speeds wear V_SCALE — divide it out so the volume
          // curves keep their tuning
          if (t.kind === "rim") {
            sound.clank(t.speed / V_SCALE);
            navigator.vibrate?.(12);
            lastRimAtRef.current = now;
            sparksRef.current.push({ x: t.x, y: t.y, at: now, color: MUSTARD });
          } else if (t.kind === "board" || t.kind === "wall") {
            sound.board(t.speed / V_SCALE);
            // ink sparks — paper ones would vanish against the paper board
            sparksRef.current.push({ x: t.x, y: t.y, at: now, color: OUTLINE });
          } else if (t.kind === "floor") {
            sound.bounce(t.speed / V_SCALE);
          }
        }
        // the swish — fires mid-flight, the moment the ball drops through
        if (s.made && !madeRef.current) {
          madeRef.current = true;
          eventAtRef.current = now;
          kickAtRef.current = now;
          const depth = levelIdxRef.current + 1;
          // every make — clean, banked, rattled in — gets the same
          // subtle climb home
          sound.swish();
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
            popRef.current = { text: "THAT'S THE PULL", at: now, color: YELLOW };
          } else {
            // today's ledger — deeper than any make today. Re-reaching the
            // career best is the plateaued player's session summit; the
            // cleared card golds it, once a day by construction.
            const todayFirst = depth > todayBestRef.current;
            if (todayFirst) todayBestRef.current = depth;
            matchedRef.current = todayFirst && depth === bestDepthRef.current;
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
            }
            if (isWin) {
              winsRef.current += 1;
              // the anthem — the b7 every rim-out abandoned, resolved
              // at last. Perfect runs only, nowhere else, ever.
              sound.anthem();
            }
            // the career meter — every make anywhere deposits one, so even a
            // run that dies on level 2 paid into something permanent
            bucketsRef.current += 1;
            const milestone = isBucketMilestone(bucketsRef.current);
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
                      : depth === 3
                        ? "MOGGER'S MOG" // any level-3 make, however ugly
                        : s.touches.length >= 4
                          ? "OFF EVERYTHING"
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
        ctx.globalAlpha = 0.9 * (1 - night);
        for (let i = 0; i < 4; i++) {
          const cw = 60 + hash01(i * 9 + 2) * 80;
          const cy = 20 + hash01(i * 9 + 3) * floorY * 0.32;
          const cx = ((hash01(i * 9 + 4) * W + now * (4 + i * 2)) % (W + cw * 2)) - cw;
          const lean = (hash01(i * 9 + 5) - 0.5) * 0.16; // head sits off-center
          // a barely-darker underside first, then the lit mass a step
          // toward the upper-left — even the clouds obey the light
          for (const pass of [
            { col: mix(PAPER, SKY, 0.2), ox: 0, oy: 0 },
            { col: PAPER, ox: -1.5, oy: -2.2 },
          ]) {
            ctx.fillStyle = pass.col;
            // each lobe gets its own subpath (moveTo) — chained arcs draw
            // connector lines whose self-intersections fill as holes
            ctx.beginPath();
            for (const [lx, ly, lr] of [
              [lean, -0.26, 0.3],
              [-0.32, -0.14, 0.18],
              [0.28, -0.16, 0.2],
            ] as const) {
              ctx.moveTo(cx + pass.ox + (lx + lr) * cw, cy + pass.oy + ly * cw);
              ctx.arc(cx + pass.ox + lx * cw, cy + pass.oy + ly * cw, lr * cw, 0, Math.PI * 2);
            }
            ctx.roundRect(
              cx + pass.ox - 0.46 * cw,
              cy + pass.oy - 0.12 * cw,
              0.92 * cw,
              0.12 * cw,
              0.06 * cw,
            );
            ctx.fill();
          }
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
          // the bird flies at skyline depth, so it wears skyline paint:
          // ink and fills lifted toward the sky, a thinner line — it
          // should be noticed second, not first
          const bInk = mix(OUTLINE, SKY, 0.35);
          const bPaper = mix(PAPER, SKY, 0.25);
          ctx.lineWidth = 1.1;
          ctx.lineJoin = "round";
          ctx.strokeStyle = bInk;
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
            ctx.fillStyle = bPaper;
            // tail
            ctx.beginPath();
            ctx.moveTo(-5.5, -1);
            ctx.lineTo(-10.5, -3.5);
            ctx.lineTo(-9, 1);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            // beak — mustard, like everything worth chasing around here
            ctx.fillStyle = mix(MUSTARD, SKY, 0.25);
            ctx.beginPath();
            ctx.moveTo(5.5, -1.5);
            ctx.lineTo(9.5, 0);
            ctx.lineTo(5.5, 1.5);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            // body — one plump blob, nose up a touch
            ctx.fillStyle = bPaper;
            ctx.beginPath();
            ctx.ellipse(0, 0, 6.5, 4.2, -0.12, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            // the wing — a chunky leaf pivoting off the shoulder. Two
            // snapped frames while flapping; in a glide it folds along
            // the back (the down frame used to hold through glides and
            // read as a freeze, not a glide)
            ctx.beginPath();
            if (!flapping) {
              ctx.moveTo(2, -1.4);
              ctx.quadraticCurveTo(-3, -5.2, -10, -3.6);
              ctx.quadraticCurveTo(-4, -0.9, 2, -1.4);
            } else if (up) {
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
            ctx.fillStyle = bInk;
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
        // the cat tracks a live ball
        gaze: phaseRef.current === "flying",
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
      // slab joints — Law 4's plank marks, translated: ink is invisible
      // on near-ink asphalt, so the ticks are painted a value lighter.
      // Five short verticals, hashed x, and nothing else.
      ctx.strokeStyle = mix(THEME.asphalt, PAPER, 0.35);
      ctx.lineWidth = 1.5;
      ctx.lineCap = "round";
      ctx.beginPath();
      for (let i = 0; i < 5; i++) {
        const jx = (i + 0.15 + hash01(i * 7 + 61) * 0.7) * (W / 5);
        ctx.moveTo(jx, floorY + 4.5);
        ctx.lineTo(jx, floorY + 11.5);
      }
      ctx.stroke();
      ctx.lineCap = "butt";
      ctx.strokeStyle = OUTLINE;
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
      // sits on one. Solid cool ink at low alpha, no blur, thrown a
      // touch to the right: the scene's one light lives upper-left and
      // the shadows all agree with it.
      const shadow = (px: number, rx: number) => {
        ctx.fillStyle = SHADOW;
        ctx.beginPath();
        ctx.ellipse(px + rx * 0.35, floorY + 2, rx, Math.max(2, rx * 0.28), 0, 0, Math.PI * 2);
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
        // the pole — Law 2: a filled object with a lit face and a shade
        // face, not a bar of solid ink. Concrete lit on the left, warm
        // shade on the right, inked silhouette.
        const poleX = boardX + 5;
        shadow(poleX, 9);
        const pw = 7;
        const pTop = bTop + 8;
        const pH = floorY + 4 - pTop;
        ctx.fillStyle = THEME.concrete;
        ctx.fillRect(poleX - pw / 2, pTop, pw, pH);
        ctx.fillStyle = shade(THEME.concrete);
        ctx.fillRect(poleX + pw / 2 - 2.5, pTop, 2.5, pH);
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = 2.5;
        ctx.strokeRect(poleX - pw / 2, pTop, pw, pH);
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
        // the plank face's shade side — right edge, hard, warm (Law 2)
        ctx.fillStyle = shade(THEME.wood);
        ctx.fillRect(boardX + 5.5, bTop + 4, 2.5, bBot - bTop - 8);
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
      // the iron's underside — the same two-light rule as everything
      // else: shade rides the bottom half of the bar
      ctx.strokeStyle = shade(ironC);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(frontX + 1, rimY + 1.2);
      ctx.lineTo(backX - 1, rimY + 1.2);
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
        // the slab's shade edge — lower-right of the bar, warm and hard,
        // so even the obstacles obey the scene's one light
        ctx.strokeStyle = shade(THEME.concrete);
        ctx.lineWidth = 2.6;
        ctx.beginPath();
        ctx.moveTo(sx(wl.x1) + 1.4, sy(wl.y1) + 1.4);
        ctx.lineTo(sx(wl.x2) + 1.4, sy(wl.y2) + 1.4);
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
        // every ladder opens with a faint ink spine under the color —
        // the motion-audit fix: warm trail colors sink into the sunset
        // skies, and the spine keeps the arc legible over every band
        const layers: readonly (readonly [string, number, number])[] =
          heat >= 4
            ? [
                [INK, 8.5, 0.35],
                [THEME.rim, 7, 1],
                [YELLOW, 3, 1],
              ]
            : heat >= 2
              ? [
                  [INK, 7, 0.35],
                  [YELLOW, 5.5, 1],
                  [MUSTARD, 3, 1],
                ]
              : [
                  [INK, 4.5, 0.35],
                  [MUSTARD, 3, 1],
                ];
        for (const [col, lw, aMul] of layers) {
          ctx.strokeStyle = col;
          ctx.lineWidth = lw;
          for (let i = 1; i < tr.length; i++) {
            ctx.globalAlpha = (i / tr.length) * 0.45 * aMul;
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
            ? now - eventAtRef.current < 0.45
              ? "watch" // hold the follow-through while the net snaps —
              // shooters keep their form through the make
              : "joy" // then the turn and the shrug
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
        ctx.strokeStyle = INK;
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
          ctx.globalAlpha = 0.6 + 0.3 * Math.sin(now * 3);
          // a paper halo under the ink — the hint crosses facades that
          // go near-ink after dark, and text is the one mark that must
          // never lose to its band
          ctx.strokeStyle = PAPER;
          ctx.lineWidth = 3;
          ctx.lineJoin = "round";
          ctx.strokeText(hint, hx, by - 16);
          ctx.fillStyle = OUTLINE;
          ctx.fillText(hint, hx, by - 16);
          ctx.globalAlpha = 1;
          ctx.lineWidth = 1;
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
        const flags = FLAG_COLORS;
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
          const cloth = () => {
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
          };
          cloth();
          ctx.fill();
          // the cloth's shade half — the scene's one shade transform on
          // the side away from the light, so the pennants hang, not float
          ctx.fillStyle = shade(color);
          ctx.beginPath();
          if (champ) {
            ctx.moveTo(0, 0);
            ctx.lineTo(5.5, 0);
            ctx.lineTo(5.5, len);
            ctx.lineTo(0, len - 5);
          } else {
            ctx.moveTo(0, 0);
            ctx.lineTo(5, 0);
            ctx.lineTo(0, len);
          }
          ctx.closePath();
          ctx.fill();
          cloth();
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
          newBestRef.current
            ? `LEVEL ${level.id} — NEW BEST`
            : matchedRef.current
              ? `LEVEL ${level.id} — TIED YOUR BEST`
              : `LEVEL ${level.id} CLEARED`,
          `next: level ${nx.id}`,
          newBestRef.current || matchedRef.current ? YELLOW : PAPER,
        );
      } else if (ph === "enter") {
        // level 6 is the last shot; the level past your best puts the
        // record on the line — the run that could set a new best should
        // feel different BEFORE the shot, not just after. Deep runs get
        // their streak counted on the way in.
        const lastOne = level.id === LEVELS.length;
        const recordShot =
          !lastOne && bestDepthRef.current > 0 && level.id === bestDepthRef.current + 1;
        card(
          lastOne
            ? "THE LAST SHOT"
            : recordShot
              ? `LEVEL ${level.id} — BEST ON THE LINE`
              : `LEVEL ${level.id}`,
          lastOne
            ? `level ${level.id} — game ${run}`
            : recordShot
              ? `game ${run} — a make sets a new best`
              : heat >= 2
                ? `game ${run} — ${heat} straight`
                : `game ${run}`,
          lastOne || recordShot ? YELLOW : PAPER,
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
      hist: [{ t: performance.now(), x: e.clientX, y: e.clientY }],
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.id) return;
    d.dx = e.clientX;
    d.dy = e.clientY;
    const t = performance.now();
    d.hist.push({ t, x: e.clientX, y: e.clientY });
    while (d.hist.length > 1 && t - d.hist[0].t > 140) d.hist.shift();
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
    // release stabilizer: a thumb peeling off glass rolls its contact
    // point a few px, and that roll lands straight in the aim (sim:
    // it's most of the mobile σ). If the trailing ~90ms of drag stayed
    // inside a tight circle the player was HOLDING an aim, not
    // flicking — shoot from the settled average, not the liftoff
    // smudge. A real flick blows past the spread gate and keeps its
    // raw release. A mouse settles at zero velocity, so desktop aim
    // averages to itself.
    const t = performance.now();
    const w = d.hist.filter((h) => t - h.t <= 90);
    w.push({ t, x: e.clientX, y: e.clientY });
    if (w.length >= 3) {
      let mx = 0;
      let my = 0;
      for (const h of w) {
        mx += h.x;
        my += h.y;
      }
      mx /= w.length;
      my /= w.length;
      let spread = 0;
      for (const h of w)
        spread = Math.max(spread, Math.hypot(h.x - mx, h.y - my));
      if (spread < 12) {
        d.dx = mx;
        d.dy = my;
      }
    }
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
        // same as a press: mid-choreography space completes the card
        // instead of past it
        const api = verdictApiRef.current;
        if (api && !api.done()) api.skip();
        else advance();
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
  const todayDepth = runState?.todayDepth ?? 0;
  // the daily frontier — one make past this ✗ was today's best (or tied
  // the career mark, the stronger pull). Career frontier outranks it.
  const todayFrontier =
    !frontier && todayDepth > 0 && todayDepth < bestDepth && levelIdx === todayDepth;
  // the next career-bucket rung, for the death card's countdown
  const nextMile = nextBucketMilestone(buckets);
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

    // the one line of text — the same stakes ladder the death card
    // climbs, first person because the poster speaks as the player.
    // Gold when the run earned gold. No stats dashboard; the pips
    // already told the story.
    const verdict = (
      beat
        ? "GOATED AF"
        : shareStakes({
            frontier,
            todayFrontier,
            tiesBest: levelIdx + 1 === bestDepth,
            closestYet: Boolean(last?.closestYet),
            bestDepth,
            total: LEVELS.length,
            level: levelIdx + 1,
          })
    ).toUpperCase();
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
      beat || last?.closestYet || frontier || todayFrontier ? YELLOW : PAPER,
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

    // the little guy — crowned and composed after a win, arms down, ball
    // at his feet; otherwise frozen in the follow-through, the shot rising.
    // snapNow: a fixed clock that lands every pose on its rest frame
    // (no mid-hop feet, no mid-bob offset).
    const k = 21;
    const snapNow = beat ? eventAtRef.current + 1 : 0.001;
    if (beat) {
      drawCreature(ctx, W / 2, grassY, k, "champ", snapNow);
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

  // one artifact, one verb: every share mints the painted poster. On
  // phones the bare link rides along as text so it stays tappable —
  // apps that drop one keep the other. The emoji-pips text artifact
  // survives as the fallback wherever files can't travel.
  const shareRun = async () => {
    const beat = phase === "beat";
    const coarse = matchMedia("(pointer: coarse)").matches;
    // the funnel's other end — run_end measures play, this measures spread
    track("share", { beat, coarse, artifact: "poster" });
    const text = shareArtifact({
      beat,
      total: LEVELS.length,
      makes: runMakes,
      stakes: shareStakes({
        frontier,
        todayFrontier,
        tiesBest: levelIdx + 1 === bestDepth,
        closestYet: Boolean(last?.closestYet),
        bestDepth,
        total: LEVELS.length,
        level: levelIdx + 1,
      }),
    });
    // share() rejects when the user dismisses the sheet — a no-op
    if (navigator.share && coarse) {
      try {
        const file = new File([await renderShareCard(beat)], `hooping-game-${run}.png`, {
          type: "image/png",
        });
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file], text: "hooping.io" });
        } else {
          await navigator.share({ text }); // no file sharing — the text artifact steps in
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
      // clipboard won't take images (or blocked) — the pips still travel
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch {
        // clipboard fully blocked — hand the file over
        const a = document.createElement("a");
        a.href = URL.createObjectURL(await renderShareCard(beat));
        a.download = `hooping-game-${run}.png`;
        a.click();
        URL.revokeObjectURL(a.href);
      }
    }
  };

  // ——— dev-only: the unfurl card. `pnpm dev` + /?og lays the social
  // image (1200×630, drawn 2x) over the page for a headless screenshot;
  // scripts/og.sh captures it into app/opengraph-image.png. Painted with
  // the game's own brushes so the unfurl ages with the art. ———
  const renderOgCanvas = (): HTMLCanvasElement => {
    const { outline: OUTLINE, paper: PAPER, ball: MUSTARD } = THEME;
    const W = 1200;
    const H = 630;
    const cv = document.createElement("canvas");
    cv.width = W * 2;
    cv.height = H * 2;
    const ctx = cv.getContext("2d")!;
    ctx.scale(2, 2);
    const DISPLAY =
      getComputedStyle(document.body).getPropertyValue("--font-plex-serif").trim() ||
      "ui-monospace, Menlo, monospace";
    // the level-4 sky — the swollen sunset, the game's best hour. The
    // sun gets an earlier clock than the city so it hangs above the
    // roofline instead of drowning behind it; the windows keep dusk.
    const night = NIGHT[3];
    const sky = SKIES[3];
    const grassY = H - 110;
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    // nudged left so the full disc clears the clock tower
    ctx.save();
    ctx.translate(-100, 0);
    drawCelestials(ctx, W, grassY, sky, 0.3, 0.35);
    ctx.restore();
    drawSkyline(ctx, W, grassY, sky, night, 0.35, { hScale: 0.85 });

    // the ground — grass with the asphalt cap, same seams as the game
    ctx.fillStyle = THEME.grass;
    ctx.fillRect(0, grassY, W, H - grassY);
    ctx.fillStyle = THEME.asphalt;
    ctx.fillRect(0, grassY, W, 40);
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(0, grassY);
    ctx.lineTo(W, grassY);
    ctx.stroke();
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, grassY + 40);
    ctx.lineTo(W, grassY + 40);
    ctx.stroke();

    // the hoop — board, iron, net, planted at the right edge so the
    // shot has somewhere to land. The iron rides well above the
    // shooter's head: a rim at shoulder height reads as a toy
    const frontX = 880;
    const backX = frontX + 120;
    const rimY = 240;
    const boardX = backX + 14;
    const bTop = rimY - 170;
    const bBot = rimY + 12;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    // pole
    const poleX = boardX + 9;
    const pw = 13;
    ctx.fillStyle = THEME.concrete;
    ctx.fillRect(poleX - pw / 2, bTop + 14, pw, grassY + 6 - bTop - 14);
    ctx.fillStyle = shade(THEME.concrete);
    ctx.fillRect(poleX + pw / 2 - 4.5, bTop + 14, 4.5, grassY + 6 - bTop - 14);
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 4;
    ctx.strokeRect(poleX - pw / 2, bTop + 14, pw, grassY + 6 - bTop - 14);
    // board — the wooden sign: ink line, light bevel, darker face inset
    const bw2 = 20;
    ctx.fillStyle = darken(THEME.wood, 1.14);
    ctx.lineWidth = 4.5;
    ctx.beginPath();
    ctx.roundRect(boardX, bTop, bw2, bBot - bTop, 5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = THEME.wood;
    ctx.beginPath();
    ctx.roundRect(boardX + 5, bTop + 5, bw2 - 10, bBot - bTop - 10, 3);
    ctx.fill();
    ctx.fillStyle = shade(THEME.wood);
    ctx.fillRect(boardX + 10, bTop + 7, 4, bBot - bTop - 14);
    // mount
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(backX, rimY);
    ctx.lineTo(boardX, rimY);
    ctx.stroke();
    // net — the diamond mesh, ink under paper
    const netLen = 92;
    const midXc = (frontX + backX) / 2;
    const topW = backX - frontX;
    const midW = topW * 0.72;
    const botW = topW * 0.55;
    const midY = rimY + netLen * 0.52;
    const botY = rimY + netLen;
    const at = (w: number, t: number) => midXc - w / 2 + w * t;
    ctx.beginPath();
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
    for (let j = 0; j < 3; j++) {
      const mx = at(midW, (j + 0.5) / 3);
      ctx.moveTo(mx, midY);
      ctx.lineTo(at(botW, j / 3), botY);
      ctx.moveTo(mx, midY);
      ctx.lineTo(at(botW, (j + 1) / 3), botY);
    }
    ctx.moveTo(at(botW, 0), botY);
    ctx.lineTo(at(botW, 1), botY);
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.strokeStyle = PAPER;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    // iron last, over the mesh
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 13;
    ctx.beginPath();
    ctx.moveTo(frontX, rimY);
    ctx.lineTo(backX, rimY);
    ctx.stroke();
    ctx.strokeStyle = THEME.rim;
    ctx.lineWidth = 8;
    ctx.stroke();

    // the little guy mid-shot, eyes on the ball — mid-frame, clear of
    // the clock tower and the sun's shoulder of the sky
    const k = 12;
    const feetX = 430;
    drawCreature(ctx, feetX, grassY, k, "watch", 0.001, true);
    // ghost beats trailing from his hand to the ball on its arc
    const handX = feetX + 6.6 * k;
    const handY = grassY - 16.2 * k;
    const ballX = 710;
    const ballY = 205;
    ctx.fillStyle = OUTLINE;
    for (let i = 1; i <= 5; i++) {
      const t = i / 6;
      const gx = handX + (ballX - handX) * t;
      const gy = handY + (ballY - handY) * (1 - (1 - t) * (1 - t));
      ctx.globalAlpha = 0.2 + 0.35 * t;
      ctx.fillRect(gx - 5, gy - 5, 10, 10);
    }
    ctx.globalAlpha = 1;
    drawBall(ctx, ballX, ballY, 40, 2.2);

    // sticker lettering — wordmark and the one line of copy
    ctx.textAlign = "center";
    ctx.lineJoin = "round";
    ctx.font = `700 100px ${DISPLAY}`;
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 18;
    ctx.strokeText("HOOPING", 600, 150);
    ctx.fillStyle = MUSTARD;
    ctx.fillText("HOOPING", 600, 150);
    // the one line of copy rides the grass, like the court's painted
    // lines — the sky belongs to the shot
    ctx.font = `600 30px ui-monospace, Menlo, monospace`;
    ctx.lineWidth = 6;
    ctx.strokeText("one shot. a miss ends the game.", 600, 602);
    ctx.fillStyle = PAPER;
    ctx.fillText("one shot. a miss ends the game.", 600, 602);
    return cv;
  };

  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    if (!new URLSearchParams(location.search).has("og")) return;
    let gone = false;
    (async () => {
      await document.fonts.ready;
      if (gone) return;
      const cv = renderOgCanvas();
      cv.id = "og-card";
      // z-index over everything, dev badge included — the screenshot
      // must be the card and nothing else
      cv.style.cssText =
        "position:fixed;left:0;top:0;width:1200px;height:630px;z-index:2147483647";
      document.body.appendChild(cv);
    })();
    return () => {
      gone = true;
      document.getElementById("og-card")?.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // a verdict press: completes a running choreography, else advances —
  // so an impatient double-tap reads skip + run it back
  const verdictPress = () => {
    const api = verdictApiRef.current;
    if (api && !api.done()) api.skip();
    else advance();
  };

  return (
    <div className="relative flex h-dvh flex-col">
      {/* readout bar — the only chrome above the game, drawn with the
          scene's own pen: the one ink, darker than every sky, with the
          ball's mustard as the single hot line under it — the scoreboard
          hangs over the court on the same leather the game is played with */}
      <div
        className="flex items-center justify-between border-b-2 pb-2.5 pt-[calc(0.625rem+env(safe-area-inset-top))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]"
        style={{ backgroundColor: INK, borderColor: THEME.ball }}
      >
        <div className="flex items-center gap-4">
          {/* the logo — the favicon's ball beside the wordmark, one paper
              word with the leather to its left */}
          <h1 className="flex items-center gap-1.5 font-display text-base font-semibold text-[#fdfaf2]">
            {/* the ball shrunk inside a ring of lighter leather (#ebc887,
                matches app/icon.svg), dribbble style — 19px keeps the
                ball itself at its old 15px optical size */}
            <svg viewBox="0 0 32 32" className="h-[19px] w-[19px]" aria-hidden>
              <defs>
                <clipPath id="hdr-ball">
                  <circle cx="16" cy="16" r="14" />
                </clipPath>
              </defs>
              <g transform="translate(16 16) scale(0.78) translate(-16 -16)">
                <circle cx="16" cy="16" r="14" fill={THEME.ball} />
                <g
                  clipPath="url(#hdr-ball)"
                  stroke={INK}
                  strokeWidth="1.8"
                  fill="none"
                >
                  <path d="M2 16 Q16 21 30 16" />
                  <path d="M16 2 Q21 16 16 30" />
                  <circle cx="-5" cy="16" r="14.7" />
                  <circle cx="37" cy="16" r="14.7" />
                </g>
              </g>
              <circle cx="16" cy="16" r="14.6" fill="none" stroke="#ebc887" strokeWidth="2.4" />
            </svg>
            Hooping
          </h1>
          {/* the ladder — six hand-drawn pennants on a rope, the game's
              own reward object in the game's own colors: each level
              flies the same cloth here as on the in-game rafter rope
              (FLAG_COLORS). Made flags fill with their color plus the
              warm shade half (Law 2 — ink outlines can't read on the
              ink bar) and POP in on their own beat; the live one hangs
              hollow in its destined color and sways like the champion's
              banner; the rest wait as faint empty outlines. */}
          <span className="relative flex items-start gap-[6px]" aria-hidden>
            <span className="absolute left-[-3px] right-[-3px] top-[1px] h-[1.5px] rounded bg-[#fdfaf2]/30" />
            {LEVELS.map((l, i) => {
              const made = i < levelIdx || phase === "beat";
              const current = i === levelIdx && phase !== "beat";
              const c = FLAG_COLORS[i];
              return (
                <svg
                  key={l.id}
                  viewBox="0 0 10 13"
                  className={`h-[13px] w-[10px] origin-top ${
                    made
                      ? "animate-[letter-pop_0.35s_ease-out_both]"
                      : current
                        ? "animate-[banner-sway_2.4s_ease-in-out_infinite]"
                        : ""
                  }`}
                  style={{
                    animationDelay: made ? `${i * 70}ms` : undefined,
                    // hand-hung: each flag holds its own slight tilt
                    rotate: made ? `${[-3, 2, -2, 3, -1.5, 2.5][i]}deg` : undefined,
                  }}
                >
                  {made ? (
                    <>
                      <path d="M1 1 H9 L5 12 Z" fill={c} />
                      <path d="M5 1 H9 L5 12 Z" fill={shade(c)} />
                    </>
                  ) : (
                    <path
                      d="M1 1 H9 L5 12 Z"
                      fill="none"
                      stroke={current ? c : "#fdfaf2"}
                      strokeOpacity={current ? 0.9 : 0.35}
                      strokeWidth="1.3"
                      strokeLinejoin="round"
                    />
                  )}
                </svg>
              );
            })}
          </span>
          <span className="flex items-baseline gap-1.5 rounded-[3px] border border-[#fdfaf2]/15 px-2 py-[5px] font-mono leading-none max-sm:hidden">
            <span className="text-[9px] tracking-[0.14em] text-[#fdfaf2]/45">
              LVL
            </span>
            <span className="text-[11px] text-[#fdfaf2]/90">
              {levelIdx + 1}/{LEVELS.length}
            </span>
          </span>
        </div>
        {/* the records as scoreboard cells — quiet label, loud number —
            and the sound toggle wearing the same cell so it reads as a
            button. Fresh players get one dash: no scoreboard before the
            first make. */}
        <div className="flex items-center gap-2 font-mono leading-none">
          {bestDepth > 0 && (
            <span className="flex items-baseline gap-1.5 rounded-[3px] border border-[#fdfaf2]/15 px-2 py-[5px]">
              <span className="text-[9px] tracking-[0.14em] text-[#fdfaf2]/45">
                TODAY
              </span>
              <span className="text-[11px] text-[#fdfaf2]/90">{todayDepth}</span>
            </span>
          )}
          <span className="flex items-baseline gap-1.5 rounded-[3px] border border-[#fdfaf2]/15 px-2 py-[5px]">
            <span className="text-[9px] tracking-[0.14em] text-[#fdfaf2]/45">
              BEST
            </span>
            <span className="text-[11px] text-[#fdfaf2]/90">
              {bestDepth > 0 ? `${bestDepth}/${LEVELS.length}` : "—"}
            </span>
          </span>
          {/* the sound knob — a drawn object, not a UI glyph: rim-brick
              rounded square wearing the ink outline and the warm shade,
              like a dial on the back-room TV. Muted, the set goes cold
              concrete and the waves stop. Springy on touch. */}
          <button
            onClick={toggleSound}
            // before:-inset-2: a finger-sized hit area past the small knob
            className="relative flex items-center transition-transform duration-100 before:absolute before:-inset-2 before:content-[''] hover:-rotate-6 hover:scale-110 active:scale-90"
            aria-pressed={sndOn}
            aria-label="sound"
          >
            <svg viewBox="0 0 26 26" className="h-[23px] w-[23px]" aria-hidden>
              <defs>
                <clipPath id="hdr-knob">
                  <rect x="2" y="2" width="22" height="22" rx="6.5" />
                </clipPath>
              </defs>
              <rect
                x="2"
                y="2"
                width="22"
                height="22"
                rx="6.5"
                fill={sndOn ? THEME.rim : THEME.concrete}
              />
              {/* the warm hard shade along the lower-right, Law 2 */}
              <path
                d="M24 8 v16 h-16 q10 2 14-2 t2-14 z"
                fill={shade(sndOn ? THEME.rim : THEME.concrete)}
                clipPath="url(#hdr-knob)"
              />
              <rect
                x="2"
                y="2"
                width="22"
                height="22"
                rx="6.5"
                fill="none"
                stroke={INK}
                strokeWidth="2"
              />
              {/* the little paper speaker cone */}
              <path
                d="M7.5 10.5 h2.8 l3.7-3 v11 l-3.7-3 h-2.8 z"
                fill="#fdfaf2"
                stroke={INK}
                strokeWidth="1.2"
                strokeLinejoin="round"
              />
              {sndOn ? (
                <g
                  stroke="#fdfaf2"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  fill="none"
                >
                  <path d="M16.8 10.2 a4 4 0 0 1 0 5.6" />
                  <path d="M19.3 8.4 a6.6 6.6 0 0 1 0 9.2" />
                </g>
              ) : (
                <g stroke="#fdfaf2" strokeWidth="1.6" strokeLinecap="round">
                  <path d="M16.5 10.5 l4.5 5" />
                  <path d="M21 10.5 l-4.5 5" />
                </g>
              )}
            </svg>
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
            (including the panel) starts the next game; a tap during the
            card's choreography completes it instead. The share button
            stops the tap from advancing. */}
        {(phase === "beat" || phase === "dead") && (
          <div
            className={`absolute inset-0 z-10 flex touch-none items-center justify-center animate-[fade-in_0.2s_ease-out_0.1s_both] ${
              // death dims the world in ink; victory keeps it bright under
              // a gold wash so the confetti rain stays lit
              phase === "beat" ? "bg-[#f2b32e]/10" : "bg-[#3a2e2a]/40"
            }`}
            onPointerDown={verdictPress}
          >
            <VerdictCard
              ref={verdictApiRef}
              phase={phase === "beat" ? "beat" : "dead"}
              headline={missLine ?? (last ? autopsy(last) : "game over")}
              goldHeadline={Boolean(last?.closestYet || frontier)}
              levelIdx={levelIdx}
              bestDepth={bestDepth}
              closestYet={Boolean(last?.closestYet)}
              frontier={frontier}
              todayFrontier={todayFrontier}
              nextLevel={nextLevel}
              run={run}
              buckets={buckets}
              runMakes={runMakes}
              nextMile={nextMile}
              wins={wins}
              practiced={practiced}
              copied={copied}
              onAdvance={advance}
              onPractice={startPractice}
              onShare={shareRun}
            />
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
          <span>
            {LEVELS.length} for {LEVELS.length}
          </span>
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
          {/* the tip jar — phones get just the star, the line is full */}
          <a
            href="https://github.com/douvy/hooping"
            target="_blank"
            rel="noreferrer"
            aria-label="star hooping on github"
            className="underline underline-offset-2"
          >
            ★<span className="max-sm:hidden"> github</span>
          </a>
        </span>
      </div>
    </div>
  );
}

