// The game's voice — synthesized in WebAudio, no audio files.
//
// Every melodic phrase is transcribed bar-by-bar from Trey Anastasio's
// Gotta Jibboo solo (12/30/1999); each cites its source bar below.
// One governing idea, taken from the solo's own architecture: the b7
// (D5) is left unresolved by every miss, and resolved to E5 by exactly
// one sound in the game — the perfect-run anthem. Rim-outs hang on D5
// forever; only 6/6 brings it home.
//
// Engine law: one note() voice — square wave (triangle where marked),
// lowpass 2400Hz Q 0.7, 7ms attack, sustain to 62% of duration, ramp
// to silence. Two oscillators per note: primary plus a double detuned
// +2-4 cents (randomized per note) at 40% gain. Per-note humanization:
// timing ±12ms, duration ±7%, velocity ±12% — no sound ever repeats
// identically. Slides are 55-60ms linear ramps (hammer-on speed)
// unless a bar tabs a longer bend. Vibrato ONLY on terminal held
// notes, arriving ≥180ms into the hold, ~5.4Hz, depth ~0.009 of
// frequency. Themes get ornaments, SFX get statements — nothing under
// one second gets decoration.
//
// The ball's impact sounds (clank/board/bounce) stay outside the
// engine — physics, not music. Everything sits under a quiet ambient
// bed (room tone plus a low E drone); level-clear phrases duck the
// bed ~30% for their duration.

let ctx: BaseAudioContext | null = null;
let master: GainNode | null = null;
let bound = false; // an injected (offline) context — never resume it
let muted = false;

function ensure(): BaseAudioContext {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.5;
    master.connect(ctx.destination);
  }
  if (!bound && ctx.state === "suspended") {
    void (ctx as AudioContext).resume();
  }
  return ctx;
}

/** Render/test hook: point the module at an OfflineAudioContext.
 * Resets the singletons so a fresh graph builds against it. */
export function bind(c: BaseAudioContext) {
  ctx = c;
  bound = true;
  bedGain = null;
  master = c.createGain();
  master.gain.value = muted ? 0 : 0.5;
  master.connect(c.destination);
}

/** The scoreboard's mute switch — flips the master gain, keeps the
 * context alive so unmuting is instant. */
export function setMuted(m: boolean) {
  muted = m;
  if (master) master.gain.value = m ? 0 : 0.5;
}

// iOS unlock. Two Safari rules the lazy context breaks: (1) an
// AudioContext only starts inside a real tap's call stack; (2) the
// ring/silent switch mutes WebAudio unless the session declares itself
// playback. Called from pointerdown — aiming is a real gesture.
export function unlock() {
  const session = (navigator as Navigator & { audioSession?: { type: string } })
    .audioSession;
  if (session) session.type = "playback";
  ensure();
  startBed();
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

// --- The ambient bed ---
// Gym room tone: looped noise through a dark lowpass, breathing on a
// slow LFO, over a barely-there low E drone (the game's key). Starts
// on unlock, lives under everything, and gets ducked ~30% while a
// level-clear phrase plays.
let bedGain: GainNode | null = null;

export function startBed() {
  const c = ensure();
  if (bedGain) return;
  bedGain = c.createGain();
  bedGain.gain.value = 1; // the duck handle — sources carry the level
  bedGain.connect(master!);
  // the room — two seconds of noise, looped
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * 2), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const lp = c.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 260;
  lp.Q.value = 0.5;
  const ng = c.createGain();
  ng.gain.value = 0.018;
  const lfo = c.createOscillator(); // the breath
  lfo.frequency.value = 0.08;
  const lg = c.createGain();
  lg.gain.value = 0.006;
  lfo.connect(lg).connect(ng.gain);
  src.connect(lp).connect(ng).connect(bedGain);
  src.start();
  lfo.start();
  // the drone — E2 and its fifth, at the edge of hearing
  for (const [f, v] of [
    [82.41, 0.006],
    [123.47, 0.0035],
  ]) {
    const osc = c.createOscillator();
    osc.type = "sine";
    osc.frequency.value = f;
    const g = c.createGain();
    g.gain.value = v;
    osc.connect(g).connect(bedGain);
    osc.start();
  }
}

/** Duck the bed ~30% for `dur` seconds — level-clear phrases clear
 * their own stage. */
function duckBed(dur: number) {
  if (!bedGain || !ctx) return;
  const p = bedGain.gain;
  const t = ctx.currentTime;
  p.cancelScheduledValues(t);
  p.setValueAtTime(p.value, t);
  p.linearRampToValueAtTime(0.7, t + 0.08);
  p.setValueAtTime(0.7, t + dur);
  p.linearRampToValueAtTime(1, t + dur + 0.3);
}

// --- The engine ---

type NoteOpts = {
  /** Slide start (Hz). Default speed is a hammer-on; a bar can tab a
   * longer bend via `slide`. */
  from?: number;
  /** Slide seconds. Omit for hammer-on speed (55-60ms). */
  slide?: number;
  /** Terminal held notes only. */
  vibrato?: boolean;
  /** Seconds into the hold before it arrives. ≥0.18 by law. */
  vibratoAt?: number;
  vibratoHz?: number;
  /** Fraction of the note's frequency. */
  vibratoDepth?: number;
  /** Round-trip bend target: freq → bendTo → freq over `bendDur`. */
  bendTo?: number;
  bendDur?: number;
  triangle?: boolean;
  /** Lowpass override. */
  cutoff?: number;
};

/** The voice. Square (triangle where marked) through a fixed lowpass;
 * 7ms attack, flat sustain to 62% of duration, linear ramp to
 * silence. A detuned double (+2-4 cents, rolled per note) rides at
 * 40% under the primary. Timing/duration/velocity are humanized every
 * play — no note ever lands twice the same. */
function note(
  freq: number,
  at: number,
  dur: number,
  vol = 0.14,
  opts: NoteOpts = {},
) {
  const c = ensure();
  const t = c.currentTime + Math.max(0, at + rnd(-0.012, 0.012));
  dur *= rnd(0.93, 1.07);
  vol *= rnd(0.88, 1.12);
  const g = c.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.007);
  g.gain.setValueAtTime(vol, t + dur * 0.62);
  g.gain.linearRampToValueAtTime(0, t + dur);
  const lp = c.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = opts.cutoff ?? 2400;
  lp.Q.value = 0.7;
  lp.connect(g);
  g.connect(master!);
  let vib: GainNode | null = null;
  if (opts.vibrato) {
    const lfo = c.createOscillator();
    lfo.frequency.value = (opts.vibratoHz ?? 5.4) * rnd(0.97, 1.03);
    vib = c.createGain();
    const arrive = t + (opts.vibratoAt ?? 0.18) * rnd(1, 1.12);
    vib.gain.setValueAtTime(0, t);
    vib.gain.setValueAtTime(0, arrive);
    vib.gain.linearRampToValueAtTime(
      freq * (opts.vibratoDepth ?? 0.009) * rnd(0.9, 1.1),
      arrive + 0.09,
    );
    lfo.connect(vib);
    lfo.start(t);
    lfo.stop(t + dur);
  }
  // primary + the detuned double at 40% (0.71 : 0.29 keeps the sum at vol)
  for (const [detune, share] of [
    [0, 0.71],
    [rnd(2, 4), 0.29],
  ]) {
    const osc = c.createOscillator();
    osc.type = opts.triangle ? "triangle" : "square";
    osc.detune.value = detune;
    if (opts.from) {
      osc.frequency.setValueAtTime(opts.from, t);
      osc.frequency.linearRampToValueAtTime(
        freq,
        t + (opts.slide ?? rnd(0.055, 0.06)),
      );
    } else if (opts.bendTo) {
      const bd = opts.bendDur ?? 0.12;
      osc.frequency.setValueAtTime(freq, t);
      osc.frequency.linearRampToValueAtTime(opts.bendTo, t + bd / 2);
      osc.frequency.linearRampToValueAtTime(freq, t + bd);
    } else {
      osc.frequency.setValueAtTime(freq, t);
    }
    if (vib) vib.connect(osc.frequency);
    const og = c.createGain();
    og.gain.value = share;
    osc.connect(og).connect(lp);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }
}

// The solo's alphabet.
const B3 = 246.94;
const DS4 = 311.13;
const E4 = 329.63;
const FS4 = 369.99;
const G4 = 392.0;
const GS4 = 415.3;
const A4 = 440.0;
const AS4 = 466.16;
const B4 = 493.88;
const CS5 = 554.37;
const D5 = 587.33;
const E5 = 659.26;

// --- Gameplay SFX ---

/** Shallow death (levels 1-2) — bars 1-3's punctuation figure: the
 * low B3·B3 double thump. Dry, no decoration, built to survive 900
 * consecutive plays; the deeper griefs stay rare because deep deaths
 * are rare. */
export function brick() {
  note(B3, 0, 0.09, 0.11);
  note(B3, 0.105, 0.09, 0.11);
}

/** A burst of filtered noise — nothing synthetic says "nylon". */
function nylon(
  at: number,
  len: number,
  f0: number,
  f1: number,
  peak: number,
  q: number,
) {
  const c = ensure();
  const t = c.currentTime + at;
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * len), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = "bandpass";
  f.Q.value = q;
  f.frequency.setValueAtTime(f0, t);
  f.frequency.exponentialRampToValueAtTime(f1, t + len);
  const g = c.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  src.connect(f).connect(g).connect(master!);
  src.start(t);
  src.stop(t + len);
}

/** The make — every way it goes in, just the net, built like the
 * real thing in three soft moments, all cloth and no bass: the catch
 * (two hushed layers as the cords accept the ball), the pull-through
 * (a slow-swelling, gently darkening shhh with a ~28Hz flutter —
 * cords slipping over leather), and the quiet settle of the net
 * after the ball is gone. Every weave hangs a little different — the
 * whole sound is re-randomized per play. No notes: the melody
 * belongs to the level-clear phrase. */
export function swish() {
  const w = rnd(0.94, 1.06); // the weave
  // the catch — soft, the cords accepting the ball, not a whipcrack
  nylon(0, 0.09, 4200 * w, 2400 * w, 0.06, 1.6);
  nylon(0.015, 0.11, 3000 * w, 1700 * w, 0.05, 1.2);
  // the pull-through, swelling in slow and carrying the sound
  const c = ensure();
  const t = c.currentTime + 0.04;
  const len = 0.32 * rnd(0.95, 1.08);
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * len), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = "bandpass";
  f.Q.value = 0.8;
  f.frequency.setValueAtTime(1900 * w, t);
  f.frequency.exponentialRampToValueAtTime(700 * w, t + len);
  const g = c.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.11 * rnd(0.9, 1.1), t + 0.06);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  const lfo = c.createOscillator(); // the cord flutter, gentle
  lfo.frequency.value = rnd(24, 32);
  const lg = c.createGain();
  lg.gain.value = 0.03;
  lfo.connect(lg).connect(g.gain);
  lfo.start(t);
  lfo.stop(t + len);
  src.connect(f).connect(g).connect(master!);
  src.start(t);
  src.stop(t + len);
  // the net settles back up
  nylon(0.28, 0.07, 2600 * w, 1500 * w, 0.035, 1.4);
}

/** Near-miss death — bar 5's opening: swung E5·E5·C#5 stabs, then a
 * real bend C#5→D5 held long, vibrato arriving late. The b7 hangs
 * unresolved — half of the game's central musical sentence; only the
 * anthem answers it. */
export function rimOut() {
  note(E5, 0, 0.11, 0.15);
  note(E5, 0.13, 0.09, 0.13);
  note(CS5, 0.25, 0.14, 0.15);
  note(D5, 0.41, 0.65, 0.16, {
    from: CS5,
    slide: 0.14,
    vibrato: true,
    vibratoAt: 0.26,
  });
}

/** Death — the game's one Dorian phrase. Five notes exactly, no
 * slides, no other decoration: B4·D5·C#5·A4 at ~170-190ms spacings,
 * then G4 held 600ms, vibrato from ~200ms. */
export function heartbreaker() {
  note(B4, 0, 0.16);
  note(D5, 0.18, 0.16);
  note(CS5, 0.355, 0.15);
  note(A4, 0.545, 0.16);
  note(G4, 0.72, 0.6, 0.16, {
    vibrato: true,
    vibratoAt: 0.2,
    vibratoDepth: 0.01, // grief shakes a little wider
  });
}

// --- Level-clear phrases ---
// Each ducks the ambient bed ~30% for its duration. Clears 1-5 never
// resolve D5→E5 — that gesture belongs to the anthem alone.

/** 1 — "the arch": climb E4·G#4·A4, hold B4, touch C#5, walk back
 * down, resolve to a long E4. */
function arch() {
  note(E4, 0, 0.14);
  note(GS4, 0.17, 0.14);
  note(A4, 0.34, 0.14);
  note(B4, 0.51, 0.24);
  note(CS5, 0.77, 0.105);
  note(B4, 0.9, 0.13);
  note(A4, 1.06, 0.13);
  note(GS4, 1.22, 0.13);
  note(E4, 1.4, 0.39, 0.16, { vibrato: true });
}

/** 2 — "the bounce" (bar 2): E4·E4 double-hit, F#4, slide into G#4,
 * A4, held B4, dip A4·G#4, then the bar's true resolve — the
 * half-step approach into the root from below, D#4→E4. */
function bounce2() {
  note(E4, 0, 0.1);
  note(E4, 0.11, 0.1);
  note(FS4, 0.22, 0.11);
  note(GS4, 0.35, 0.12, 0.14, { from: G4 });
  note(A4, 0.49, 0.12);
  note(B4, 0.63, 0.21);
  note(A4, 0.87, 0.11);
  note(GS4, 1.0, 0.11);
  note(E4, 1.15, 0.34, 0.16, { from: DS4, vibrato: true });
}

/** 3 — "the exclamation" (bar 3): slide into G#4, A4, B4, held C#5,
 * descend, the low B3 punctuation, then the octave leap — the first
 * clear that touches E5. */
function exclamation() {
  note(GS4, 0, 0.12, 0.14, { from: G4 });
  note(A4, 0.14, 0.11);
  note(B4, 0.27, 0.11);
  note(CS5, 0.4, 0.225);
  note(B4, 0.65, 0.11);
  note(A4, 0.78, 0.11);
  note(GS4, 0.91, 0.11);
  note(B3, 1.04, 0.09, 0.13); // the drop that makes the leap read
  note(E5, 1.16, 0.33, 0.16, { vibrato: true });
}

/** 4 — "one note, three ways" (bar 6): E4·F#4, then G#4 three times
 * with three articulations exactly as tabbed — staccato, held with
 * vibrato, bent round-trip to A4 — then F#4·G#4, the B3·B3
 * punctuation, resolve to E4. */
function oneNoteThreeWays() {
  note(E4, 0, 0.11);
  note(FS4, 0.13, 0.11);
  note(GS4, 0.27, 0.07); // staccato, dry
  note(GS4, 0.38, 0.25, 0.14, { vibrato: true }); // held, shaken
  note(GS4, 0.66, 0.26, 0.14, { bendTo: A4, bendDur: 0.12 }); // bent
  note(FS4, 0.95, 0.11);
  note(GS4, 1.08, 0.11);
  note(B3, 1.21, 0.09, 0.11);
  note(B3, 1.315, 0.09, 0.11);
  note(E4, 1.44, 0.35, 0.16);
}

/** 5 — "the cascade" (bar 5): E5·E5·E5 stabs, C#5, a quick
 * C#5-D5-C#5 hammer-pull (the one clear allowed ornaments — it runs
 * 2s+), the descending hammer-pull triplets, the chromatic recovery
 * A#4→B4, C#5, land on a held B4. */
function cascade() {
  note(E5, 0, 0.1, 0.15);
  note(E5, 0.11, 0.1, 0.13);
  note(E5, 0.22, 0.1, 0.15);
  note(CS5, 0.34, 0.12);
  note(CS5, 0.48, 0.05); // ┐
  note(D5, 0.53, 0.05); // ├ the hammer-pull ornament
  note(CS5, 0.58, 0.12); // ┘
  note(B4, 0.74, 0.06); // ┐
  note(CS5, 0.8, 0.06); // ├ B4-C#5-B4
  note(B4, 0.86, 0.09); // ┘
  note(A4, 0.95, 0.06);
  note(B4, 1.01, 0.06);
  note(A4, 1.07, 0.09);
  note(GS4, 1.16, 0.06);
  note(A4, 1.22, 0.06);
  note(GS4, 1.28, 0.09);
  note(B4, 1.4, 0.12, 0.14, { from: AS4 }); // the chromatic recovery
  note(CS5, 1.54, 0.12);
  note(B4, 1.68, 0.42, 0.16, { vibrato: true });
}

const CLEARS = [arch, bounce2, exclamation, oneNoteThreeWays, cascade];
const CLEAR_LEN = [1.9, 1.6, 1.6, 1.9, 2.2];

/** Clearing level 1-5 — that level's phrase from the transcription. */
export function levelClear(level: number) {
  const i = Math.min(Math.max(level, 1), CLEARS.length) - 1;
  duckBed(CLEAR_LEN[i]);
  CLEARS[i]();
}

/** 6/6 — "the anthem": the full statement plus bar 8's ending. Slide
 * into a long G#4, climb through a held C#5 and the D5·C#5 turn,
 * walk down to F#4 — then the solo's actual final gesture: C#5,
 * hammer to D5, D5 staccato, and E5 held long with slow wide
 * vibrato. The b7 every rim-out abandoned, finally brought home.
 * Plays exclusively on perfect runs, nowhere else, ever. */
export function anthem() {
  duckBed(4.6);
  note(GS4, 0, 0.68, 0.17, { from: G4, vibrato: true, vibratoAt: 0.3 });
  note(A4, 0.74, 0.16);
  note(B4, 0.93, 0.16);
  note(CS5, 1.12, 0.34);
  note(D5, 1.5, 0.1); // ┐ the turn
  note(CS5, 1.62, 0.215); // ┘
  note(B4, 1.88, 0.16);
  note(A4, 2.07, 0.16);
  note(GS4, 2.26, 0.16);
  note(FS4, 2.45, 0.18);
  note(CS5, 2.7, 0.14);
  note(D5, 2.87, 0.24, 0.15, { from: CS5 }); // hammered to the b7
  note(D5, 3.15, 0.08, 0.15); // spoken once more, staccato
  note(E5, 3.28, 0.9, 0.18, {
    vibrato: true,
    vibratoAt: 0.3,
    vibratoHz: 5.2,
    vibratoDepth: 0.012,
  });
}

// --- The ball's physics voice (outside the engine — impacts, not music) ---

function blip(
  freq: number,
  at: number,
  dur: number,
  peak: number,
  glideTo?: number,
  type: OscillatorType = "square",
) {
  const c = ensure();
  const t = c.currentTime + at;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t + dur);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(master!);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

// Pentatonic — the verdict card's replay ladder.
const SCALE = [392, 440, 523, 587, 659, 784, 880, 1046, 1175, 1318, 1568, 1760];

/** One step of the verdict card's replays — dot fills and the career
 * odometer climb the same ladder. */
export function tick(step: number) {
  const f = SCALE[Math.min(step, SCALE.length - 1)];
  blip(f, 0, 0.05, 0.032, f * 1.15); // a count-in is felt, not heard
}

/** Ball on iron. Three inharmonic sine partials — a knock, a ring, a
 * shimmer — like a bell, because a rim IS a bell. Each hit lands ±2%
 * detuned so a rattle sounds like a ball fighting the iron, not a
 * sample looping. Louder when harder. */
export function clank(speed: number) {
  const v = Math.min(0.05, 0.013 + speed * 0.006);
  const d = 1 + (Math.random() - 0.5) * 0.04;
  blip(523 * d, 0, 0.03, v * 0.7, 480 * d, "triangle"); // the knock
  blip(1244 * d, 0, 0.09, v, 1175 * d, "sine"); // the ring
  blip(3136 * d, 0, 0.05, v * 0.35, 2900 * d, "sine"); // the shimmer
}

/** Ball on glass — dull, boxy, slightly different every time. */
export function board(speed: number) {
  const v = Math.min(0.05, 0.015 + speed * 0.005);
  const d = 1 + (Math.random() - 0.5) * 0.03;
  blip(196 * d, 0, 0.07, v, 130, "sine");
  blip(590 * d, 0, 0.035, v * 0.4, 400, "triangle");
}

/** Floor bounce — quiet thup, fades as the ball dies. */
export function bounce(speed: number) {
  const d = 1 + (Math.random() - 0.5) * 0.03;
  blip(140 * d, 0, 0.06, Math.min(0.04, 0.01 + speed * 0.004), 90, "sine");
}

/** A pennant snapping onto the rafter rope — a short cloth whip and a
 * bright ring. */
export function pennant() {
  nylon(0, 0.06, 3800, 1600, 0.08, 1.4); // rope through the pulley
  blip(1318, 0.04, 0.14, 0.028, undefined, "sine"); // the flag settles home
}
