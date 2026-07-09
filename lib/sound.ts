// The lake's voice — tiny blips synthesized in WebAudio, no audio files.
// Same synth foundation as how-agents-think's mascot: one lazy
// AudioContext (created inside a real gesture, satisfying the browser
// rule), whisper-quiet master gain, fast attack, exponential tail.
//
// The tick-tick-tick IS the game: each skip climbs a pentatonic ladder,
// so a long run plays a rising phrase that accelerates as the hops
// shorten. The plunk is a dead low thud. Scarcity rule as in the house
// style: the fanfare only fires on a new personal best.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;

function ensure(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.5;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

/** The scoreboard's mute switch — flips the master gain, keeps the
 * context alive so unmuting is instant. */
export function setMuted(m: boolean) {
  muted = m;
  if (master) master.gain.value = m ? 0 : 0.5;
}

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

// iOS unlock. Two Safari rules the lazy context breaks: (1) an
// AudioContext only starts inside a real tap's call stack; (2) the
// ring/silent switch mutes WebAudio unless the session declares itself
// playback. Called from pointerdown — aiming is a real gesture.
export function unlock() {
  const session = (navigator as Navigator & { audioSession?: { type: string } })
    .audioSession;
  if (session) session.type = "playback";
  ensure();
}

// Pentatonic — no wrong notes however long the run goes.
const SCALE = [392, 440, 523, 587, 659, 784, 880, 1046, 1175, 1318, 1568, 1760];

/** One skip. Pitch climbs the ladder with the skip index. */
export function tick(skipIndex: number) {
  const f = SCALE[Math.min(skipIndex, SCALE.length - 1)];
  blip(f, 0, 0.05, 0.04, f * 1.15);
}

/** The stone catches water and goes down. Low, dead, final. */
export function plunk() {
  blip(196, 0, 0.2, 0.05, 82, "sine");
  blip(330, 0, 0.05, 0.02, 165);
}

/** End of a good run — the stone settles rather than dies. */
export function sink() {
  blip(523, 0, 0.16, 0.03, 262, "sine");
}

/** Crossing a 25m milestone line mid-flight. One soft high ping. */
export function milestone() {
  blip(1568, 0, 0.09, 0.025, undefined, "sine");
}

/** Overtaking the challenger's flag mid-flight. Two quick rising notes —
 * cheekier than a milestone, smaller than the fanfare. */
export function overtake() {
  blip(659, 0, 0.06, 0.035);
  blip(988, 0.06, 0.12, 0.035);
}

// --- HOOP: the ball's voice ---

/** Ball on iron. Two inharmonic partials = metallic; louder when harder.
 * A rattle is this firing three times in 200ms — the agony bell. */
export function clank(speed: number) {
  const v = Math.min(0.055, 0.015 + speed * 0.006);
  blip(1046, 0, 0.04, v, 880);
  blip(2793, 0, 0.06, v * 0.4, 2400, "triangle");
}

/** Ball on glass — dull, boxy. */
export function board(speed: number) {
  const v = Math.min(0.05, 0.015 + speed * 0.005);
  blip(196, 0, 0.07, v, 130, "sine");
  blip(590, 0, 0.03, v * 0.5, 400, "triangle");
}

/** Floor bounce — quiet thup, fades as the ball dies. */
export function bounce(speed: number) {
  blip(140, 0, 0.06, Math.min(0.04, 0.01 + speed * 0.004), 90, "sine");
}

/** The swish — the bucket's dopamine hit, built like the real thing:
 * a bright snap as the ball catches the cords, a longer darker whoosh
 * as it pulls through, a low pat as the hem kicks, and a two-note
 * pentatonic rise on top. Noise bursts because nothing synthetic says
 * "nylon"; the reward notes climb with level depth — deeper buckets
 * ring higher. */
export function swish(depth = 1) {
  const c = ensure();
  const t = c.currentTime;
  const nylon = (
    at: number,
    len: number,
    f0: number,
    f1: number,
    peak: number,
    q: number,
  ) => {
    const buf = c.createBuffer(1, Math.ceil(c.sampleRate * len), c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = "bandpass";
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t + at);
    f.frequency.exponentialRampToValueAtTime(f1, t + at + len);
    const g = c.createGain();
    g.gain.setValueAtTime(0, t + at);
    g.gain.linearRampToValueAtTime(peak, t + at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + at + len);
    src.connect(f).connect(g).connect(master!);
    src.start(t + at);
    src.stop(t + at + len);
  };
  nylon(0, 0.08, 5200, 2600, 0.16, 2.2); // the snap
  nylon(0.05, 0.3, 2400, 500, 0.2, 1.0); // the pull-through
  // the hem's kick — a low pat under the nylon
  blip(180, 0.1, 0.1, 0.035, 120, "sine");
  // the reward — two notes, the second leaping a minor 7th to the
  // root's flat 7. The old polite 4th was meh; the b7 leap struts,
  // and it hands off to the level-up's dominant-7 arpeggio.
  const base = Math.min(2 + depth, SCALE.length - 3);
  blip(SCALE[base], 0.08, 0.09, 0.035, undefined, "sine");
  blip(SCALE[base] * 1.7818, 0.17, 0.18, 0.045, undefined, "sine");
}

/** A pennant snapping onto the rafter rope — a short cloth whip and a
 * bright ring, quieter than the fanfare that preceded it. */
export function pennant() {
  const c = ensure();
  const t = c.currentTime;
  // the whip — a hiss of nylon rope through the pulley
  const len = 0.06;
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * len), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = "bandpass";
  f.Q.value = 1.4;
  f.frequency.setValueAtTime(3800, t);
  f.frequency.exponentialRampToValueAtTime(1600, t + len);
  const g = c.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.08, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  src.connect(f).connect(g).connect(master!);
  src.start(t);
  src.stop(t + len);
  // the ring — the flag settles home
  blip(1318, 0.04, 0.14, 0.028, undefined, "sine");
}

// G Mixolydian — the major ladder with its 7th flattened. The b7 is what
// makes a climb strut instead of resolve.
const MIXO = [
  392, 440, 493.9, 523.3, 587.3, 659.3, 698.5, 784, 880, 987.8, 1046.5,
];

/** Advancing to the next level — an unhurried major-triad walk-up:
 * 1, 3, then the 5th held clean while it exhales. Root walks up the
 * Mixolydian ladder two steps per level cleared, so the phrase itself
 * rises as you do. Bigger than the swish, smaller than the fanfare. */
export function levelUp(depth = 1) {
  const f0 = MIXO[Math.min((depth - 1) * 2, MIXO.length - 1)];
  // the walk-up — root, then the major 3rd
  blip(f0, 0, 0.07, 0.026);
  blip(f0 * 1.2599, 0.09, 0.07, 0.03);
  // the peak — the 5th, held, let it breathe out
  blip(f0 * 1.4983, 0.2, 0.32, 0.038);
  // the halo — a quiet sine an octave over the peak
  blip(f0 * 2.9966, 0.2, 0.2, 0.01, undefined, "sine");
}

/** New personal best today. The only fanfare in the game. */
export function fanfare() {
  blip(523, 0, 0.07, 0.04);
  blip(659, 0.07, 0.07, 0.04);
  blip(784, 0.14, 0.07, 0.04);
  blip(1046, 0.21, 0.16, 0.04);
}
