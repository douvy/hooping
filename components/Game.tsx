"use client";

// The lake. One canvas, one gesture: pull back, release. Everything on
// the canvas derives from the physics stepper each rAF; React state only
// carries the HUD (scores, phase, share). All rules live in lib/game.ts —
// this file is presentation and gesture.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Contact,
  type Lake,
  type ThrowResult,
  type Thrower,
  createThrow,
  dailySeed,
  dayNumber,
  makeLake,
  shareString,
  MIN_POWER,
  MAX_POWER,
} from "@/lib/physics";
import { type Aim, beats, computePar, safeDefault, score } from "@/lib/game";
import { createSpring, presets } from "@/lib/spring";
import * as sound from "@/lib/sound";

// juice springs — closed-form, evaluated per frame from an event timestamp
const popSpring = createSpring(presets.snappy); // counter punch: 1 → 0
const kickSpring = createSpring({ stiffness: 320, damping: 14, mass: 1 }); // screen kick

// --- daily state, persisted ---

interface DayState {
  day: number;
  throws: number;
  best: ThrowResult | null;
  streak: number;
}

const STORE_KEY = "skip-state-v1";

function loadDayState(day: number): DayState {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as DayState;
      if (s.day === day) return s;
      // new lake: carry the streak only if they played yesterday
      return { day, throws: 0, best: null, streak: s.day === day - 1 && s.throws > 0 ? s.streak : 0 };
    }
  } catch {
    // fresh player
  }
  return { day, throws: 0, best: null, streak: 0 };
}

// --- rendering constants ---

const WATER_FRAC = 0.72; // waterline as fraction of canvas height
const VIEW_METERS = 24; // meters across the screen at rest
const VISUAL_WAVE = 6; // waves are physically centimeters; draw them bigger
const STEEP_WARN = 12; // aim readout turns orange past this angle

const PAPER = "#eceae0";
const ORANGE = "#d45a2b";
const YELLOW = "#ffffc9";
const MUTED = "#7b7e8a";
const GRID = "#232323";

interface Splash {
  x: number;
  at: number; // wall-clock seconds
  tier: number;
}

interface FriendFlag {
  distance: number;
  skips: number;
  name: string | null;
}

const CANVAS_FONT = "10px ui-monospace, Menlo, monospace";

// pull back, throw opposite: drag left/down = throw right/up
function aimFromDrag(d: { sx: number; sy: number; dx: number; dy: number }): Aim {
  const pull = Math.hypot(d.dx - d.sx, d.dy - d.sy);
  const vx = d.sx - d.dx;
  const vy = d.dy - d.sy; // screen y down: pulling down aims up
  const a = (Math.atan2(vy, Math.max(vx, 1)) * 180) / Math.PI;
  return {
    p: Math.min(MAX_POWER, Math.max(MIN_POWER, pull / 9)),
    a: Math.max(-10, Math.min(35, a)),
  };
}

export function Game() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // world — created once on mount (needs the client's UTC date)
  const worldRef = useRef<{
    lake: Lake;
    day: number;
    defaultAim: Aim;
  } | null>(null);

  // rAF-mutable state, no React involvement
  const simRef = useRef<Thrower | null>(null);
  const dragRef = useRef<{ sx: number; sy: number; dx: number; dy: number } | null>(null);
  const trailRef = useRef<{ x: number; y: number }[]>([]);
  const splashesRef = useRef<Splash[]>([]);
  const cameraRef = useRef(0);
  const seenContactsRef = useRef(0);
  const freezeUntilRef = useRef(0); // hitstop
  const slowUntilRef = useRef(0); // near-miss slow-mo
  const crossedPBRef = useRef(false);
  const crossedFriendRef = useRef(false);
  const friendCrossedAtRef = useRef(-Infinity); // challenger flag flash
  const milestoneRef = useRef(0); // last milestone line crossed
  const phaseRef = useRef<"aim" | "flying" | "done">("aim");
  // juice event timestamps (wall-clock seconds; -Infinity = never)
  const popAtRef = useRef(-Infinity); // skip counter punch
  const kickAtRef = useRef(-Infinity); // screen kick on tier-up
  const crossedAtRef = useRef(-Infinity); // PB flag flash
  const prevTierRef = useRef(0);
  const plunkFxRef = useRef<{ x: number; deg: number; at: number } | null>(null);
  const skipsElRef = useRef<HTMLSpanElement>(null);

  // HUD state
  const [day, setDay] = useState<number | null>(null);
  const [dayState, setDayState] = useState<DayState | null>(null);
  const [par, setPar] = useState<ThrowResult | null>(null);
  const [friend, setFriend] = useState<FriendFlag | null>(null);
  const [phase, setPhase] = useState<"aim" | "flying" | "done">("aim");
  const [liveSkips, setLiveSkips] = useState(0);
  const [liveDist, setLiveDist] = useState(0);
  const [last, setLast] = useState<ThrowResult | null>(null);
  const [isPB, setIsPB] = useState(false);
  const [copied, setCopied] = useState(false);

  const setPhaseBoth = useCallback((p: "aim" | "flying" | "done") => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  // --- mount: build today's world. Everything here is client-only (UTC
  // clock, localStorage, URL params), so it lands in one deferred batch
  // after first paint rather than synchronously in the effect body.
  useEffect(() => {
    const t = setTimeout(() => {
      const dateStr = new Date().toISOString().slice(0, 10); // UTC day — one lake, whole planet
      const d = dayNumber(dateStr);
      const lake = makeLake(dailySeed(dateStr));
      worldRef.current = { lake, day: d, defaultAim: safeDefault(lake) };
      setDay(d);
      setDayState(loadDayState(d));
      setPar(computePar(lake)); // ~400 sims, sub-100ms
      // challenge flag from the URL — only valid on the lake it was set on
      const q = new URLSearchParams(location.search);
      const qd = Number(q.get("d"));
      const qb = Number(q.get("b"));
      const qs = Number(q.get("s"));
      if (qd === d && qb > 0) {
        setFriend({ distance: qb / 10, skips: qs || 0, name: q.get("n") });
      }
    }, 0);
    return () => clearTimeout(t);
  }, []);

  // --- throwing ---
  const throwStone = useCallback(
    (aim: Aim) => {
      const w = worldRef.current;
      if (!w || phaseRef.current === "flying") return;
      simRef.current = createThrow(w.lake, aim.p, aim.a);
      trailRef.current = [];
      splashesRef.current = [];
      seenContactsRef.current = 0;
      crossedPBRef.current = false;
      crossedFriendRef.current = false;
      milestoneRef.current = 0;
      freezeUntilRef.current = 0;
      slowUntilRef.current = 0;
      prevTierRef.current = 0;
      plunkFxRef.current = null;
      setLiveSkips(0);
      setLiveDist(0);
      setIsPB(false);
      setCopied(false);
      setPhaseBoth("flying");
    },
    [setPhaseBoth],
  );

  const finishThrow = useCallback(() => {
    const s = simRef.current!.state;
    const r: ThrowResult = { skips: s.skips, distance: s.x, contacts: s.contacts, plunk: s.plunk };
    setLast(r);
    setPhaseBoth("done");
    if (r.plunk) {
      sound.plunk();
      navigator.vibrate?.(50); // one dull thud
      // the comically vertical splash — steeper death, taller spray
      const c = r.contacts[r.contacts.length - 1];
      if (c) plunkFxRef.current = { x: c.x, deg: c.impactDeg, at: performance.now() / 1000 };
    } else sound.sink();
    setDayState((prev) => {
      if (!prev) return prev;
      const first = prev.throws === 0;
      const pb = !r.plunk && beats(r, prev.best);
      if (pb) setIsPB(true);
      const next: DayState = {
        ...prev,
        throws: prev.throws + 1,
        best: pb ? r : prev.best,
        streak: first ? prev.streak + 1 : prev.streak,
      };
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(next));
      } catch {
        // storage blocked — play on
      }
      return next;
    });
  }, [setPhaseBoth]);

  // --- contact events: sound + juice, fired as the stepper produces them ---
  const onContact = useCallback(
    (c: Contact, index: number, now: number) => {
      if (c.kind === "skip") {
        sound.tick(index);
        navigator.vibrate?.(8); // a tick you can feel — Android, phone muted
        const tier = index >= 7 ? 3 : index >= 5 ? 2 : index >= 3 ? 1 : 0;
        splashesRef.current.push({ x: c.x, at: now, tier });
        if (index === 0) freezeUntilRef.current = now + 0.04; // the verdict hitstop
        else if (c.quality > 0.85) slowUntilRef.current = now + 0.25; // barely survived
        popAtRef.current = now; // counter punch
        if (tier > prevTierRef.current) {
          prevTierRef.current = tier;
          kickAtRef.current = now; // the screen feels the escalation
        }
        setLiveSkips(index + 1);
      }
    },
    [],
  );

  // --- the rAF loop ---
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d")!;

    let raf = 0;
    let lastT = performance.now() / 1000;
    const dpr = Math.min(devicePixelRatio || 1, 2);

    const resize = () => {
      const { width } = wrap.getBoundingClientRect();
      const height = Math.min(Math.max(width * 0.52, 260), 480);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.height = `${height}px`;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const frame = () => {
      raf = requestAnimationFrame(frame);
      const now = performance.now() / 1000;
      let dt = Math.min(now - lastT, 0.05);
      lastT = now;

      const w = worldRef.current;
      if (!w) return;
      const W = canvas.width / dpr;
      const H = canvas.height / dpr;
      const scale = W / VIEW_METERS;
      const waterY = H * WATER_FRAC;

      // step the sim
      const sim = simRef.current;
      if (phaseRef.current === "flying" && sim) {
        if (now < freezeUntilRef.current) dt = 0;
        else if (now < slowUntilRef.current) dt *= 0.3;
        sim.step(dt);
        const s = sim.state;
        trailRef.current.push({ x: s.x, y: s.y });
        if (trailRef.current.length > 90) trailRef.current.shift();
        setLiveDist(s.x);

        // new contacts → events
        while (seenContactsRef.current < s.contacts.length) {
          onContact(s.contacts[seenContactsRef.current], seenContactsRef.current, now);
          seenContactsRef.current++;
        }
        // the flag race — crossing your PB mid-flight, stone still alive.
        // Only after the first skip: a 0-skip flight that crosses and then
        // plunks scores zero, and a fanfare for it would be a lie.
        const bestD = dayState?.best?.distance ?? 0;
        if (!crossedPBRef.current && s.skips > 0 && bestD > 0 && s.x > bestD) {
          crossedPBRef.current = true;
          crossedAtRef.current = now; // the flag celebrates too — half the phones are muted
          sound.fanfare();
          navigator.vibrate?.([20, 30, 20, 30, 40]);
        }
        // overtaking the challenger — the moment the link exists for
        if (friend && !crossedFriendRef.current && s.skips > 0 && s.x > friend.distance) {
          crossedFriendRef.current = true;
          friendCrossedAtRef.current = now;
          sound.overtake();
          navigator.vibrate?.(30);
        }
        const nextLine = (milestoneRef.current + 1) * 25;
        if (s.x > nextLine) {
          milestoneRef.current++;
          sound.milestone();
        }
        if (s.done) finishThrow();
      }

      // camera: keep the stone at 38% of the screen once it passes it
      const targetCam = sim && phaseRef.current !== "aim"
        ? Math.max(0, sim.state.x - VIEW_METERS * 0.38)
        : 0;
      cameraRef.current += (targetCam - cameraRef.current) * Math.min(1, dt * 8);
      const cam = cameraRef.current;
      const sx = (x: number) => (x - cam) * scale + W * 0.12;
      const sy = (y: number) => waterY - y * scale;

      // --- draw ---
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.font = CANVAS_FONT;

      // screen kick on tier-up — a vertical jolt that rings out on a spring
      const kt = now - kickAtRef.current;
      if (kt < 0.5) ctx.translate(0, 4 * kickSpring.at(kt));

      // counter punch — the skips numeral scales on the same spring family
      const el = skipsElRef.current;
      if (el) {
        const pt = now - popAtRef.current;
        el.style.transform = pt < 0.6 ? `scale(${1 + 0.35 * popSpring.at(pt)})` : "";
      }

      // milestone verticals every 25m — drafting guides
      for (let m = 25; m < cam + VIEW_METERS + 25; m += 25) {
        const x = sx(m);
        if (x < -20 || x > W + 20) continue;
        ctx.strokeStyle = GRID;
        ctx.setLineDash([3, 5]);
        ctx.beginPath();
        ctx.moveTo(x, 8);
        ctx.lineTo(x, H - 8);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = MUTED;
        ctx.fillText(`${m}m`, x + 4, 16);
      }

      // water surface — the physics waves, visually exaggerated
      ctx.strokeStyle = "#474b56";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let px = 0; px <= W; px += 3) {
        const wx = cam + (px - W * 0.12) / scale;
        const y = waterY - w.lake.height(wx) * scale * VISUAL_WAVE;
        if (px === 0) ctx.moveTo(px, y);
        else ctx.lineTo(px, y);
      }
      ctx.stroke();
      // the depth beneath
      ctx.fillStyle = "#14161b";
      ctx.fillRect(0, waterY + 4, W, H - waterY - 4);

      // flags: yours (paper) and the challenger's (warning yellow)
      const flags: { d: number; color: string; label: string; flash: boolean }[] = [];
      const bestD = dayState?.best?.distance;
      // your PB flag flashes and waves for a beat after you blow past it
      const flashing = now - crossedAtRef.current < 1.2;
      if (bestD) flags.push({ d: bestD, color: PAPER, label: `PB ${bestD.toFixed(1)}m`, flash: flashing });
      if (friend) flags.push({ d: friend.distance, color: YELLOW, label: `${friend.name ?? "them"} ${friend.distance.toFixed(1)}m`, flash: now - friendCrossedAtRef.current < 1.2 });
      for (const f of flags) {
        const x = sx(f.d);
        if (x < -40 || x > W + 40) continue;
        const color = f.flash ? YELLOW : f.color;
        const wave = f.flash ? Math.sin(now * 22) * 3 : 0;
        if (f.flash) {
          ctx.shadowColor = YELLOW;
          ctx.shadowBlur = 10;
        }
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(x, waterY);
        ctx.lineTo(x, waterY - 26);
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(x, waterY - 26);
        ctx.lineTo(x + 10 + wave, waterY - 22);
        ctx.lineTo(x, waterY - 18);
        ctx.fill();
        ctx.fillText(f.label, x + 3, waterY - 30);
        ctx.shadowBlur = 0;
      }

      // splashes — expanding double-ticks at each skip; size grows with tier
      const alive: Splash[] = [];
      for (const sp of splashesRef.current) {
        const age = now - sp.at;
        if (age > 0.45) continue;
        alive.push(sp);
        const k = age / 0.45;
        const r = (4 + sp.tier * 3) * (0.3 + k);
        ctx.strokeStyle = sp.tier >= 2 ? YELLOW : PAPER;
        ctx.globalAlpha = 1 - k;
        ctx.beginPath();
        ctx.ellipse(sx(sp.x), waterY, r, r * 0.35, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      splashesRef.current = alive;

      // the plunk spray — comically vertical, taller the steeper the death
      const pf = plunkFxRef.current;
      if (pf) {
        const age = now - pf.at;
        if (age > 0.7) plunkFxRef.current = null;
        else {
          const env = Math.sin(Math.min(age / 0.45, 1) * Math.PI); // up, hang, down
          const base = Math.min(52, pf.deg * 1.4);
          const px = sx(pf.x);
          ctx.strokeStyle = PAPER;
          ctx.globalAlpha = Math.max(0, 1 - age / 0.7);
          for (const [off, h] of [[-4, 0.55], [0, 1], [4, 0.7]] as const) {
            ctx.beginPath();
            ctx.moveTo(px + off, waterY);
            ctx.lineTo(px + off, waterY - base * h * env);
            ctx.stroke();
          }
          ctx.strokeStyle = ORANGE;
          ctx.beginPath();
          ctx.ellipse(px, waterY, 6 + age * 20, 2 + age * 5, 0, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }

      // the stone + trail
      if (sim && phaseRef.current !== "aim") {
        const s = sim.state;
        const tier = s.skips >= 8 ? 3 : s.skips >= 6 ? 2 : s.skips >= 4 ? 1 : 0;
        // trail — thickens with tier, burns past tier 2
        if (trailRef.current.length > 1) {
          ctx.strokeStyle = tier >= 2 ? YELLOW : PAPER;
          ctx.lineWidth = 1 + tier * 0.75;
          ctx.globalAlpha = 0.5;
          if (tier >= 3) {
            ctx.shadowColor = YELLOW;
            ctx.shadowBlur = 8;
          }
          ctx.beginPath();
          trailRef.current.forEach((p, i) => {
            if (i === 0) ctx.moveTo(sx(p.x), sy(p.y));
            else ctx.lineTo(sx(p.x), sy(p.y));
          });
          ctx.stroke();
          ctx.shadowBlur = 0;
          ctx.globalAlpha = 1;
          ctx.lineWidth = 1;
        }
        if (!s.done) {
          ctx.fillStyle = tier >= 2 ? YELLOW : PAPER;
          if (tier >= 3) {
            ctx.shadowColor = YELLOW;
            ctx.shadowBlur = 12;
          }
          ctx.beginPath();
          ctx.arc(sx(s.x), sy(Math.max(s.y, 0.02)), 3.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
        } else if (s.plunk || s.contacts[s.contacts.length - 1]?.kind === "sink") {
          // the sink mark
          const cx = sx(s.x);
          ctx.strokeStyle = s.plunk ? ORANGE : MUTED;
          ctx.beginPath();
          ctx.ellipse(cx, waterY, 7, 2.5, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // aiming — the stone at rest and the pull
      if (phaseRef.current === "aim") {
        let ox = sx(0);
        let oy = sy(0.5);
        // the drawn-bowstring tremble: past ~60% power the stone shakes
        const dragNow = dragRef.current;
        if (dragNow) {
          const p01 = (aimFromDrag(dragNow).p - MIN_POWER) / (MAX_POWER - MIN_POWER);
          if (p01 > 0.6) {
            const j = (p01 - 0.6) * 4;
            ox += (Math.random() - 0.5) * 2 * j;
            oy += (Math.random() - 0.5) * 2 * j;
          }
        }
        ctx.fillStyle = PAPER;
        ctx.beginPath();
        ctx.arc(ox, oy, 3.5, 0, Math.PI * 2);
        ctx.fill();

        const drag = dragRef.current;
        const aim = drag ? aimFromDrag(drag) : w.defaultAim;
        const steep = aim.a > STEEP_WARN || aim.a < -3;
        const rad = (aim.a * Math.PI) / 180;
        const len = 14 + ((aim.p - MIN_POWER) / (MAX_POWER - MIN_POWER)) * 52;
        ctx.strokeStyle = steep ? ORANGE : PAPER;
        ctx.setLineDash([4, 4]);
        ctx.globalAlpha = drag ? 1 : 0.45;
        ctx.beginPath();
        ctx.moveTo(ox, oy);
        ctx.lineTo(ox + Math.cos(rad) * len, oy - Math.sin(rad) * len);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        if (drag) {
          ctx.fillStyle = steep ? ORANGE : PAPER;
          ctx.fillText(
            `${aim.p.toFixed(1)} m/s · ${aim.a.toFixed(0)}°${steep ? " — too steep" : ""}`,
            ox + 14,
            oy - 14,
          );
        }
      }
    };

    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [dayState, friend, onContact, finishThrow]);

  // --- gesture: pull back, release. Tap = the safe default throw. ---
  const onPointerDown = (e: React.PointerEvent) => {
    sound.unlock(); // a real gesture — the only chance iOS gives us
    if (phaseRef.current === "flying") return;
    if (phaseRef.current === "done") {
      setPhaseBoth("aim"); // instant retry: this press is already the next aim
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
    const w = worldRef.current;
    if (!w) return;
    // a tap is a throw — the safe default. First tap can't fail.
    throwStone(pull < 10 ? w.defaultAim : aimFromDrag(d));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      e.preventDefault();
      sound.unlock();
      if (phaseRef.current === "done") setPhaseBoth("aim");
      const w = worldRef.current;
      if (w && phaseRef.current === "aim") throwStone(w.defaultAim);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [throwStone, setPhaseBoth]);

  // --- share ---
  const onShare = async () => {
    if (!dayState?.best || day === null) return;
    const url = `${location.origin}/?d=${day}&b=${Math.round(dayState.best.distance * 10)}&s=${dayState.best.skips}`;
    const text = `${shareString(day, dayState.best, dayState.throws, par?.distance)}\n${url}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard blocked — show the text instead
      prompt("copy your result:", text);
    }
  };

  // --- the autopsy line: why the stone died ---
  const autopsy = (r: ThrowResult): string => {
    const c = r.contacts[r.contacts.length - 1];
    if (!c) return "";
    if (r.plunk) {
      return c.impactDeg >= 22
        ? `${c.impactDeg.toFixed(0)}° at contact — ${(c.impactDeg - 22).toFixed(0)}° too steep`
        : "too soft — the water kept it";
    }
    return `out of speed at ${r.distance.toFixed(1)}m`;
  };

  // the one-more-throw trigger: dying just short of the flag
  const nearMiss = (r: ThrowResult): string | null => {
    const bestD = dayState?.best?.distance ?? 0;
    const gap = bestD - r.distance;
    return gap > 0 && gap < 3 ? `${gap.toFixed(1)}m short of your best` : null;
  };

  const bigNum = phase === "flying" ? liveDist : (last ? score(last) : 0);
  const friendBeaten =
    friend !== null && (dayState?.best?.distance ?? 0) > friend.distance;

  return (
    <div ref={wrapRef} className="w-full">
      {/* top readout row */}
      <div className="flex items-baseline justify-between border-x border-t border-border px-4 py-2">
        <div className="flex items-baseline gap-6 font-mono">
          <span>
            <span className="text-2xl text-header-text">{bigNum.toFixed(1)}</span>
            <span className="ml-1 text-xs text-muted">m</span>
          </span>
          <span>
            <span ref={skipsElRef} className="inline-block text-2xl text-header-text">
              {phase === "flying" ? liveSkips : (last?.skips ?? 0)}
            </span>
            <span className="ml-1 text-xs text-muted">skips</span>
          </span>
        </div>
        <div className="flex items-baseline gap-4 font-mono text-xs text-muted">
          <span>BEST {dayState?.best ? `${dayState.best.distance.toFixed(1)}m` : "—"}</span>
          <span>PAR {par ? `${par.distance.toFixed(1)}m` : "…"}</span>
          <span>THROW {(dayState?.throws ?? 0) + (phase === "flying" ? 1 : 0)}</span>
          {(dayState?.streak ?? 0) > 1 && <span className="text-accent">STREAK {dayState!.streak}</span>}
        </div>
      </div>

      {/* the lake — touch-none so Safari can't scroll mid-pull */}
      <canvas
        ref={canvasRef}
        className="block w-full cursor-crosshair touch-none select-none border border-border bg-[#111318]"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (dragRef.current = null)}
      />

      {/* result strip */}
      <div className="flex min-h-12 items-center justify-between border-x border-b border-border px-4 py-2 font-mono text-sm">
        {phase === "done" && last ? (
          <span className={last.plunk ? "text-accent-negative" : isPB ? "text-accent" : "text-foreground"}>
            {last.plunk
              ? autopsy(last)
              : isPB
                ? `new best — ${last.distance.toFixed(1)}m`
                : (nearMiss(last) ?? autopsy(last))}
            {!last.plunk && par && last.distance > par.distance ? " · beat par" : ""}
          </span>
        ) : phase === "flying" ? (
          <span className="text-muted">…</span>
        ) : (
          <span className="text-muted">
            pull back and release · tap for a safe throw ·{" "}
            <kbd className="border border-border px-1 text-xs">space</kbd>
          </span>
        )}
        <div className="flex items-center gap-3">
          {friend && (
            <span className="text-xs text-warning">
              {friendBeaten
                ? `${friend.name ?? "them"} beaten — send it back`
                : `flag war: beat ${friend.name ?? "them"} at ${friend.distance.toFixed(1)}m`}
            </span>
          )}
          {dayState?.best && (
            <button
              onClick={onShare}
              className="border border-border px-3 py-1 text-xs uppercase tracking-wider text-header-text hover:bg-hover-bg"
            >
              {copied ? "copied" : "share"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
