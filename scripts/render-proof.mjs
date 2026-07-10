// Renders the game's full audio life to one WAV, in order: brick,
// rim-out, swish, clears 1-5, heartbreaker, the anthem — over
// the ambient bed, with the clears ducking it, mixed exactly as the
// game mixes it. OfflineAudioContext suspend/resume walks the same
// realtime code the browser runs.
//
// usage: node --experimental-strip-types scripts/render-proof.mjs [out.wav]

import { writeFileSync } from "node:fs";
import { OfflineAudioContext } from "node-web-audio-api";
import * as sound from "../lib/sound.ts";

const RATE = 44100;
const out = process.argv[2] ?? "proof-audio-life.wav";

// [name, fire, seconds of stage time before the next cue]
const CUES = [
  ["brick", () => sound.brick(), 1.2],
  ["rim-out", () => sound.rimOut(), 2.0],
  ["swish", () => sound.swish(), 1.6],
  ["clear 1 — the arch", () => sound.levelClear(1), 2.6],
  ["clear 2 — the bounce", () => sound.levelClear(2), 2.3],
  ["clear 3 — the exclamation", () => sound.levelClear(3), 2.3],
  ["clear 4 — one note, three ways", () => sound.levelClear(4), 2.6],
  ["clear 5 — the cascade", () => sound.levelClear(5), 3.0],
  ["heartbreaker", () => sound.heartbreaker(), 2.2],
  ["the anthem", () => sound.anthem(), 5.8],
];

const LEAD_IN = 0.6;
const total = LEAD_IN + CUES.reduce((s, [, , gap]) => s + gap, 0) + 0.6;
const ctx = new OfflineAudioContext(1, Math.ceil(total * RATE), RATE);
sound.bind(ctx);
sound.startBed();

let t = LEAD_IN;
for (const [name, fire, gap] of CUES) {
  const at = t;
  ctx.suspend(at).then(() => {
    console.log(`${at.toFixed(2).padStart(5)}s  ${name}`);
    fire();
    ctx.resume();
  });
  t += gap;
}

const buf = await ctx.startRendering();
const ch = buf.getChannelData(0);
let peak = 0;
for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));

// 16-bit PCM mono WAV
const wav = Buffer.alloc(44 + ch.length * 2);
wav.write("RIFF", 0);
wav.writeUInt32LE(36 + ch.length * 2, 4);
wav.write("WAVE", 8);
wav.write("fmt ", 12);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); // PCM
wav.writeUInt16LE(1, 22); // mono
wav.writeUInt32LE(RATE, 24);
wav.writeUInt32LE(RATE * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(ch.length * 2, 40);
for (let i = 0; i < ch.length; i++) {
  wav.writeInt16LE(
    Math.max(-32768, Math.min(32767, Math.round(ch[i] * 32767))),
    44 + i * 2,
  );
}
writeFileSync(out, wav);
console.log(`\n${out} — ${total.toFixed(1)}s, peak ${peak.toFixed(3)}`);
