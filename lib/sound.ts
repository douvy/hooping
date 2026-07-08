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

/** The swish — a filtered noise burst falling through the net. The only
 * non-oscillator sound in the game; nothing synthetic says "nylon". */
export function swish() {
  const c = ensure();
  const t = c.currentTime;
  const len = 0.22;
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * len), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = "bandpass";
  f.Q.value = 1.2;
  f.frequency.setValueAtTime(3400, t);
  f.frequency.exponentialRampToValueAtTime(800, t + len);
  const g = c.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.14, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  src.connect(f).connect(g).connect(master!);
  src.start(t);
  src.stop(t + len);
}

/** New personal best today. The only fanfare in the game. */
export function fanfare() {
  blip(523, 0, 0.07, 0.04);
  blip(659, 0.07, 0.07, 0.04);
  blip(784, 0.14, 0.07, 0.04);
  blip(1046, 0.21, 0.16, 0.04);
}
