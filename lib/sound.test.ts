import { test } from "node:test";
import assert from "node:assert/strict";
import { OfflineAudioContext } from "node-web-audio-api";
import * as sound from "./sound.ts";

const RATE = 44100;

/** Render `seconds` of audio with the module bound to a fresh offline
 * context. `fire` runs at t=0 (or per-cue via `cues`). */
async function render(
  seconds: number,
  fire: () => void,
  cues?: Array<[at: number, fire: () => void]>,
): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, Math.ceil(seconds * RATE), RATE);
  sound.bind(ctx);
  fire();
  for (const [at, f] of cues ?? []) {
    void ctx.suspend(at).then(() => {
      f();
      void ctx.resume();
    });
  }
  const buf = await ctx.startRendering();
  return buf.getChannelData(0);
}

const peak = (ch: Float32Array, from = 0, to = ch.length) => {
  let p = 0;
  for (let i = from; i < to; i++) p = Math.max(p, Math.abs(ch[i]));
  return p;
};

test("brick: a short dry statement, silent by half a second", async () => {
  const ch = await render(1, () => sound.brick());
  const hit = peak(ch, 0, Math.floor(0.4 * RATE));
  assert.ok(hit > 0.005, `inaudible (peak ${hit})`);
  assert.ok(hit < 0.15, `too hot (peak ${hit})`);
  // jitter can push the second thump late, but not past 350ms + release
  assert.ok(peak(ch, Math.floor(0.5 * RATE)) < 0.001, "rings past its welcome");
});

test("brick endurance: 20 consecutive plays never clip", async () => {
  const cues: Array<[number, () => void]> = [];
  for (let i = 0; i < 20; i++) cues.push([0.1 + i * 0.25, () => sound.brick()]);
  const ch = await render(5.5, () => {}, cues);
  assert.ok(peak(ch) < 0.2, `stacked bricks too hot (peak ${peak(ch)})`);
  assert.ok(peak(ch, Math.floor(4.8 * RATE)) > 0.003, "the 20th brick went missing");
});

test("rim-out endurance: 20 consecutive plays never clip", async () => {
  const cues: Array<[number, () => void]> = [];
  for (let i = 0; i < 20; i++) cues.push([0.1 + i * 0.9, () => sound.rimOut()]);
  const ch = await render(19, () => {}, cues);
  assert.ok(peak(ch) < 0.3, `stacked rim-outs too hot (peak ${peak(ch)})`);
});

test("humanization: no swish ever repeats identically", async () => {
  const a = await render(1, () => sound.swish());
  const b = await render(1, () => sound.swish());
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
  assert.ok(diff > 1e-4, "two swishes rendered sample-identical");
});

test("anthem: the long E5 is still singing past 3.5s", async () => {
  const ch = await render(5, () => sound.anthem());
  assert.ok(peak(ch, Math.floor(3.6 * RATE), Math.floor(4.0 * RATE)) > 0.01);
});

test("every phrase renders sound and stays under the ceiling", async () => {
  const fires = [
    () => sound.swish(),
    () => sound.heartbreaker(),
    () => sound.levelClear(1),
    () => sound.levelClear(2),
    () => sound.levelClear(3),
    () => sound.levelClear(4),
    () => sound.levelClear(5),
  ];
  for (const fire of fires) {
    const ch = await render(3, fire);
    const p = peak(ch);
    assert.ok(p > 0.005, "inaudible phrase");
    assert.ok(p < 0.3, `phrase too hot (peak ${p})`);
  }
});

test("mute: the master gain silences everything, bed included", async () => {
  sound.setMuted(true);
  try {
    const ch = await render(1, () => {
      sound.startBed();
      sound.swish();
    });
    assert.equal(peak(ch), 0);
  } finally {
    sound.setMuted(false);
  }
});

test("bed: quiet room tone, well under the SFX", async () => {
  const ch = await render(2, () => sound.startBed());
  const p = peak(ch, Math.floor(0.5 * RATE));
  assert.ok(p > 0.0005, "bed inaudible");
  assert.ok(p < 0.03, `bed too loud (peak ${p})`);
});
