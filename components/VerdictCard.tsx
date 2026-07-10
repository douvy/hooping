"use client";

// The verdict card — the epilogue after the death replay, staged like
// one. Every element on the death card derives its style from a single
// clock t (seconds since the card mounted) through lib/spring.ts beats
// from lib/choreo.ts: the death word stamps, the run's dots refill one
// tick apart, the ✗ strikes and shakes the row, a held breath, then the
// stakes land — and only then the button. A press mid-ceremony skips
// (clamps t to Infinity, same final layout); the next press advances.
// prefers-reduced-motion mounts at t=∞ outright. The win card keeps its
// CSS-keyframe banner (panel chrome, per globals.css) and borrows only
// the career roll from the clock.

import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
} from "react";
import { Check, Share2 } from "lucide-react";
import {
  BOARD_H,
  BOARD_OFF,
  LEVELS,
  RIM_GAP,
  type Level,
} from "@/lib/hoop";
import { countAt, deathBeats } from "@/lib/choreo";
import { createSpring, presets, type Spring } from "@/lib/spring";
import * as sound from "@/lib/sound";
import { THEME, mix } from "@/lib/theme";

// ——— springs, all pure functions of elapsed time ———
const pop = createSpring(presets.snappy); // stamps, dots, buttons
const glide = createSpring(presets.gentle); // small drifts and dims
// the dot row's rattle when the ✗ hits — underdamped on purpose
const shake = createSpring({ stiffness: 320, damping: 7, mass: 1 });
// the CTA's breath — a soft swell that springs back
const breath = createSpring({ stiffness: 170, damping: 14, mass: 1 });

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const fade = (e: number, dur: number) => clamp01(e / dur);
// spring lerp with elapsed time capped: these springs are settled well
// before 4s, and the skip clock (t = Infinity) must never reach cos/sin
const sv = (s: Spring, from: number, to: number, e: number) =>
  s.value(from, to, Math.min(Math.max(e, 0), 4));

const COUNT_STEP = 0.09; // one career bucket per tick
const LOOP = 3.5; // the CTA breath / ghost-arc shared rhythm

// mini-preview coordinates — 40px of court height, y flipped
const miniMap = (level: Level) => {
  const s = 40 / level.h;
  return {
    W: level.w * s,
    H: level.h * s,
    X: (x: number) => x * s,
    Y: (y: number) => level.h * s - y * s,
  };
};

// The death-panel tease: the court the miss cost you, in miniature.
// Drawn from the real level geometry — floor, iron, glass, walls, and
// the launch spot — so dying on level 3 shows exactly what 4 asks.
// ghostRef seats the taunt ball; VerdictCard's clock flies it.
function MiniCourt({
  level,
  ghostRef,
}: {
  level: Level;
  ghostRef?: Ref<SVGCircleElement>;
}) {
  const m = miniMap(level);
  const { W, H, X, Y } = m;
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
      {ghostRef && (
        <circle
          ref={ghostRef}
          r={2.5}
          fill={THEME.ball}
          stroke={THEME.outline}
          strokeWidth={1}
          opacity={0}
        />
      )}
    </svg>
  );
}

export interface VerdictApi {
  /** true once the choreography has played (or been skipped) */
  done(): boolean;
  /** complete the choreography instantly — the next press advances */
  skip(): void;
}

interface Props {
  phase: "dead" | "beat";
  /** the death word — the miss named in ball-widths */
  headline: string;
  goldHeadline: boolean;
  levelIdx: number;
  bestDepth: number;
  closestYet: boolean;
  frontier: boolean;
  todayFrontier: boolean;
  nextLevel: Level | null;
  run: number;
  buckets: number;
  runMakes: number;
  nextMile: number;
  wins: number;
  practiced: boolean;
  copied: boolean;
  onAdvance: () => void;
  onPractice: () => void;
  onShare: () => void;
  ref?: Ref<VerdictApi>;
}

export default function VerdictCard({
  phase,
  headline,
  goldHeadline,
  levelIdx,
  bestDepth,
  closestYet,
  frontier,
  todayFrontier,
  nextLevel,
  run,
  buckets,
  runMakes,
  nextMile,
  wins,
  practiced,
  copied,
  onAdvance,
  onPractice,
  onShare,
  ref,
}: Props) {
  const dead = phase === "dead";
  const hasStakes = dead && (closestYet || frontier || todayFrontier);
  const beats = useMemo(() => deathBeats(runMakes, hasStakes), [runMakes, hasStakes]);
  const from = buckets - runMakes; // the pre-run career total
  const countStart = dead ? beats.career + 0.4 : 1.0;

  const reduced = useMemo(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );
  // a revisit (back from the gym) skips the ceremony but keeps the loops
  const instant = reduced || (dead && practiced);

  const [t, setT] = useState(instant ? Infinity : 0);
  const tRef = useRef(t);
  const doneAtRef = useRef<number | null>(null); // real time the ceremony ended
  const ctaRef = useRef<HTMLButtonElement>(null);
  const ghostRef = useRef<SVGCircleElement>(null);
  // sound cursors — which beats have already spoken
  const cur = useRef({ stamped: false, fills: 0, struck: false, counted: from });

  useImperativeHandle(
    ref,
    () => ({
      done: () => !dead || tRef.current >= beats.end,
      skip: () => {
        if (tRef.current >= beats.end) return;
        // skipped beats stay silent — the skip is the player talking
        cur.current = { stamped: true, fills: runMakes, struck: true, counted: buckets };
        tRef.current = Infinity;
        setT(Infinity);
      },
    }),
    [dead, beats, runMakes, buckets],
  );

  // the taunt's flight plan: launch → the front iron's lip, in mini px
  const ghost = useMemo(() => {
    if (!dead || !nextLevel) return null;
    const m = miniMap(nextLevel);
    const fromLeft = nextLevel.launch.x < nextLevel.rim.x;
    const x0 = m.X(nextLevel.launch.x);
    const y0 = m.Y(nextLevel.launch.y);
    const x1 =
      m.X(fromLeft ? nextLevel.rim.x : nextLevel.rim.x + RIM_GAP) +
      (fromLeft ? -1.5 : 1.5);
    const y1 = m.Y(nextLevel.rim.y) - 1.5;
    return {
      x0,
      y0,
      x1,
      y1,
      cx: (x0 + x1) / 2,
      cy: Math.min(y0, y1) - 13, // the apex — a real shot's rainbow
      back: fromLeft ? 1 : -1, // clanks off the lip, falls back out
      floor: m.H - 2,
    };
  }, [dead, nextLevel]);

  // ——— the clock ———
  useEffect(() => {
    if (reduced) return; // static card — the layout is the message
    const t0 = performance.now() / 1000;
    const countEnd = countStart + Math.max(0, buckets - from) * COUNT_STEP;
    // React can sleep once the last one-shot settles (the tap line's
    // 2s dim on death); the loops below write refs directly
    const freezeAt = (dead ? beats.footer + 2 : countEnd) + 1.5;
    let raf = 0;
    const frame = () => {
      const now = performance.now() / 1000;
      const tt = tRef.current === Infinity ? Infinity : now - t0;
      tRef.current = tt;
      // sounds — at most one per frame, so a lag spike can't burst
      if (tt !== Infinity) {
        const c = cur.current;
        if (dead && !c.stamped && tt >= beats.stamp) {
          c.stamped = true;
          sound.bounce(3); // the word thuds in
        } else if (dead && c.fills < runMakes && tt >= beats.fills[c.fills]) {
          sound.tick(c.fills); // the run replays up the ladder
          c.fills += 1;
        } else if (dead && !c.struck && tt >= beats.strike) {
          c.struck = true;
          sound.clank(2.5); // the ✗ is an iron moment
        } else if (countAt(tt, from, buckets, countStart, COUNT_STEP) > c.counted) {
          sound.tick(c.counted - from); // the odometer climbs the same ladder
          c.counted += 1;
        }
      }
      setT(tt < freezeAt ? tt : Infinity);
      if (!dead) {
        if (tt >= freezeAt) return; // no loops on the win card — stop
      } else {
        if (doneAtRef.current === null && tt >= beats.end) doneAtRef.current = now;
        // CTA breath + ghost arc ride one rhythm: the pulse tops the
        // cycle, the taunt fires right behind it — never both at once
        const lt = doneAtRef.current === null ? -1 : now - doneAtRef.current - 1.0;
        const ph = lt >= 0 ? lt % LOOP : -1;
        if (ctaRef.current && tt >= beats.end + 0.6) {
          const s = ph >= 0 && ph < 1.4 ? 1 + 0.035 * breath.at(ph) : 1;
          ctaRef.current.style.transform = `scale(${s.toFixed(4)})`;
        }
        if (ghostRef.current && ghost && ph >= 0) {
          const el = ghostRef.current;
          const a = ph - 0.55; // right after the pulse settles
          const T1 = 0.9; // the flight
          const T2 = 0.5; // the drop off the lip
          if (a >= 0 && a < T1) {
            const u = a / T1;
            const iu = 1 - u;
            el.setAttribute(
              "cx",
              (iu * iu * ghost.x0 + 2 * iu * u * ghost.cx + u * u * ghost.x1).toFixed(1),
            );
            el.setAttribute(
              "cy",
              (iu * iu * ghost.y0 + 2 * iu * u * ghost.cy + u * u * ghost.y1).toFixed(1),
            );
            el.setAttribute("opacity", "0.4");
          } else if (a >= T1 && a < T1 + T2) {
            const v = a - T1;
            el.setAttribute("cx", (ghost.x1 - ghost.back * 10 * v).toFixed(1));
            el.setAttribute(
              "cy",
              Math.min(ghost.y1 + 90 * v * v, ghost.floor).toFixed(1),
            );
            el.setAttribute("opacity", (0.4 * (1 - v / T2)).toFixed(2));
          } else {
            el.setAttribute("opacity", "0");
          }
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // every dep is fixed for the card's lifetime — it remounts per verdict
  }, [dead, beats, buckets, from, countStart, runMakes, ghost, reduced]);

  // ——— death styles: each element a pure function of the clock.
  // Hidden is opacity-only — the layout never changes, which is also
  // what makes the reduced-motion card identical. ———
  const at = (
    b: number,
    make: (e: number) => CSSProperties,
  ): CSSProperties | undefined =>
    !dead ? undefined : t < b ? { opacity: 0 } : make(t - b);

  const stampStyle = at(beats.stamp, (e) => ({
    opacity: fade(e, 0.08),
    // the rubber stamp: presses in big with a tilt, lands straight
    transform: `scale(${sv(pop, 1.9, 1, e).toFixed(4)}) rotate(${sv(pop, -7, 0, e).toFixed(2)}deg)`,
  }));
  const rowStyle = at(beats.frame, (e) => ({
    opacity: fade(e, 0.15),
    transform:
      t < beats.strike
        ? undefined
        : `translateX(${(5 * shake.at(Math.min(t - beats.strike, 4))).toFixed(2)}px)`,
  }));
  const fillStyle = (i: number) =>
    at(beats.fills[i], (e) => ({
      opacity: fade(e, 0.08),
      transform: `scale(${sv(pop, 0.3, 1, e).toFixed(4)})`,
    }));
  const xStyle = at(beats.strike, (e) => ({
    opacity: fade(e, 0.06),
    transform: `scale(${sv(pop, 2.4, 1, e).toFixed(4)})`,
  }));
  const stakesStyle = at(beats.stakes, (e) => ({
    opacity: fade(e, 0.12),
    transform: `scale(${sv(pop, 1.35, 1, e).toFixed(4)})`,
  }));
  const ctaStyle = at(beats.cta, (e) => ({
    opacity: fade(e, 0.12),
    transform: `scale(${sv(pop, 1.2, 1, e).toFixed(4)})`,
  }));
  const careerStyle = at(beats.career, (e) => ({
    opacity: fade(e, 0.15),
    transform: `translateY(${sv(glide, 5, 0, e).toFixed(2)}px)`,
  }));
  const footStyle = at(beats.footer, (e) => ({ opacity: fade(e, 0.15) }));
  // the tap hint dims once the CTA has had its 2 seconds
  const tapStyle = at(beats.footer, (e) => ({
    opacity: e < 2 ? 0.9 * fade(e, 0.15) : sv(glide, 0.9, 0.35, e - 2),
  }));
  const plusStyle = at(countStart - 0.2, (e) => ({
    opacity: fade(e, 0.08),
    transform: `scale(${sv(pop, 1.6, 1, e).toFixed(4)})`,
  }));

  // ——— the career odometer and its bar ———
  const count = countAt(t, from, buckets, countStart, COUNT_STEP);
  const sinceInc =
    count > from ? t - (countStart + (count - from - 1) * COUNT_STEP) : Infinity;
  const flash = clamp01(1 - sinceInc / 0.45);
  // gold flash on the total — mirrors --warning / --muted in globals.css
  const countColor = flash > 0 ? mix("#8a8377", "#cf8f0e", flash) : undefined;
  const frac = (n: number) => Math.min(1, n / nextMile);
  const barStart = dead ? beats.career + 0.15 : 0.6;
  const barW =
    t < barStart
      ? 0
      : count <= from
        ? sv(glide, 0, frac(from), t - barStart) // fill to the pre-run mark
        : sv(pop, frac(Math.max(from, count - 1)), frac(count), sinceInc); // the nudge

  const choreoDone = !dead || t >= beats.end;

  return (
    <div
      className="flex w-96 max-w-[94%] flex-col items-center gap-4 rounded-2xl border-[3px] border-foreground bg-background px-6 py-7 text-center font-mono shadow-[5px_5px_0_rgba(58,46,42,0.55)] animate-[verdict-in_0.3s_ease-out_0.15s_both] sm:px-8"
      // mid-ceremony every press belongs to the overlay: it completes
      // the choreography; only then do the buttons come alive
      style={{ pointerEvents: choreoDone ? undefined : "none" }}
    >
      {dead ? (
        <>
          {/* the verdict is the story, not the genre — the miss named
              in ball-widths wears the headline. Gold when the death set
              a record or brushed the frontier; iron red otherwise. */}
          <h2
            className={`font-display text-2xl font-bold leading-tight text-balance ${
              goldHeadline ? "text-warning" : "text-accent-negative"
            }`}
            style={stampStyle}
          >
            {headline}
          </h2>
          {/* the run, replayed — each make refills on its own tick, the
              ✗ lands last and rattles the row, and the record's pennant
              hangs over the slot it guards. The gap between ✗ and flag
              IS the pitch. */}
          <div
            className="flex justify-center gap-2.5"
            style={rowStyle}
            aria-label={`died on level ${levelIdx + 1}${
              bestDepth > 0 ? `, best level ${bestDepth}` : ""
            }`}
          >
            {LEVELS.map((_, i) => (
              <span key={i} aria-hidden className="flex flex-col items-center gap-[3px]">
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
                  <span
                    className="h-5 w-5 rounded-full border-2 border-foreground bg-[#dfa63f]"
                    style={fillStyle(i)}
                  />
                ) : i === levelIdx ? (
                  <span
                    className="flex h-5 w-5 items-center justify-center text-xl font-bold leading-none text-accent-negative"
                    style={xStyle}
                  >
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
          {/* the stakes land last and a size up — the whole ceremony
              was the wind-up for this line, right above the button
              that cashes it */}
          {closestYet && (
            <p className="text-sm font-bold text-warning" style={stakesStyle}>
              your closest yet
            </p>
          )}
          {frontier && (
            <p className="text-sm font-bold text-warning" style={stakesStyle}>
              one make from a new best
            </p>
          )}
          {todayFrontier && (
            <p className="text-sm font-bold text-warning" style={stakesStyle}>
              {levelIdx + 1 === bestDepth
                ? "one make ties your best"
                : "one make from today's best"}
            </p>
          )}
          {/* the retry is the reward — the next court rides the button
              itself, a tease you cash by pressing it. Tap-anywhere still
              works; this is the same verb with a face. stopPropagation
              so the overlay's pointerdown doesn't advance before the
              click. The clock breathes it every ~3.5s and flies the
              ghost taunt right after the pulse. */}
          <button
            ref={ctaRef}
            onClick={onAdvance}
            onPointerDown={(e) => e.stopPropagation()}
            className="w-full overflow-hidden rounded-xl border-2 border-foreground bg-well text-foreground shadow-[4px_4px_0_#3a2e2a] transition-[translate,box-shadow] duration-100 ease-out hover:-translate-x-px hover:-translate-y-px hover:shadow-[5px_5px_0_#3a2e2a] active:translate-x-[4px] active:translate-y-[4px] active:shadow-none"
            style={ctaStyle}
          >
            {nextLevel && (
              <span className="flex flex-col items-center gap-1.5 px-3 pb-2.5 pt-3">
                <span className="label">next up — level {nextLevel.id}</span>
                <MiniCourt level={nextLevel} ghostRef={ghostRef} />
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
          {/* the banner — champion lettering. each letter stamps in on
              its own beat with a hand-set tilt, then the whole line
              hangs from its nail and sways. */}
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
          <div className="relative w-full rotate-[-2deg] rounded-sm border border-border bg-surface px-4 pb-2 pt-3 shadow-[2px_2px_0_rgba(58,46,42,0.12)] animate-[note-in_0.4s_cubic-bezier(0.34,1.56,0.64,1)_1s_both]">
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
      {/* the career line earns instead of reports — the total holds at
          the pre-run figure, the +N stamps in, then the deposits tick
          up one gold flash at a time while the bar nudges toward the
          next rung, which sits quiet at its end. */}
      <div className="flex w-full flex-col items-center gap-1.5" style={careerStyle}>
        <p className="text-xs text-muted">
          GAME {run} · <span style={{ color: countColor }}>{count}</span> CAREER{" "}
          {buckets === 1 ? "BUCKET" : "BUCKETS"}
          {runMakes > 0 && (
            <span
              className={`font-bold text-warning ${
                dead ? "" : "animate-[letter-pop_0.3s_ease-out_1s_both]"
              }`}
              style={plusStyle}
            >
              {" "}
              +{runMakes}
            </span>
          )}
        </p>
        {buckets > 0 && (
          <div className="flex w-full items-center gap-2">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-[#ebe3ce]">
              <div
                className="h-full rounded-full bg-[#dfa63f]"
                style={{ width: `${(barW * 100).toFixed(2)}%` }}
              />
            </div>
            <span className="text-[10px] leading-none text-muted">{nextMile}</span>
          </div>
        )}
      </div>
      {/* share is the primary verb only on a win — a death screen's
          verb is retry, so there it goes ghost. min-w so the copied
          swap doesn't jiggle the width. Death cards seat the gym pass
          beside it: three free balls on the shot that killed the run,
          one session per death — enough to find the answer, not enough
          to groove it. */}
      <div className="flex items-center gap-2.5" style={footStyle}>
        {dead && !practiced && (
          <button
            onClick={onPractice}
            onPointerDown={(e) => e.stopPropagation()}
            className="flex items-center justify-center rounded-lg border border-border px-4 py-2 text-xs font-bold text-muted transition-colors hover:border-foreground hover:text-foreground"
          >
            practice it
          </button>
        )}
        <button
          onClick={onShare}
          onPointerDown={(e) => e.stopPropagation()}
          className={
            dead
              ? "flex min-w-24 items-center justify-center gap-1.5 rounded-lg border border-border px-4 py-2 text-xs font-bold text-muted transition-colors hover:border-foreground hover:text-foreground"
              : "flex min-w-28 items-center justify-center gap-2 rounded-lg border-2 border-foreground bg-[#dfa63f] px-5 py-2.5 text-xs font-bold text-foreground shadow-[3px_3px_0_#3a2e2a] transition-[transform,box-shadow] duration-100 ease-out hover:-translate-x-px hover:-translate-y-px hover:shadow-[4px_4px_0_#3a2e2a] active:translate-x-[3px] active:translate-y-[3px] active:shadow-none"
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
      <p
        className={`text-[11px] text-muted ${dead ? "" : "animate-pulse"}`}
        style={tapStyle}
      >
        tap anywhere to play again
      </p>
    </div>
  );
}
