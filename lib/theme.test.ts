import { test } from "node:test";
import assert from "node:assert/strict";
import { INK, LINE_WEIGHTS, SHADOW, THEME, darken, mix, saturate, shade, withAlpha } from "./theme.ts";

test("darken scales each channel, clamped", () => {
  assert.equal(darken("#ffffff", 0.5), "#808080");
  assert.equal(darken("#000000", 0.5), "#000000");
  assert.equal(darken("#ffffff", 1.5), "#ffffff"); // lighten clamps at the byte
  // the ball's seam derivation lands near the hand-picked original
  assert.equal(darken("#d45a2b", 0.65), "#8a3b1c");
});

test("withAlpha appends the alpha byte", () => {
  assert.equal(withAlpha("#e8641f", "00"), "#e8641f00");
});

test("mix blends linearly, endpoints exact", () => {
  assert.equal(mix("#000000", "#ffffff", 0), "#000000");
  assert.equal(mix("#000000", "#ffffff", 1), "#ffffff");
  assert.equal(mix("#000000", "#ffffff", 0.5), "#808080");
  assert.equal(mix("#ff0000", "#0000ff", 0.5), "#800080");
});

test("the system tokens hold — one ink, one shadow, three descending weights", () => {
  assert.equal(INK, THEME.outline);
  assert.match(SHADOW, /^#[0-9a-f]{8}$/); // translucent by construction
  assert.ok(LINE_WEIGHTS.heavy > LINE_WEIGHTS.med);
  assert.ok(LINE_WEIGHTS.med > LINE_WEIGHTS.light);
});

test("shade darkens toward warm, never gray — snapshot of the one transform", () => {
  assert.equal(shade(THEME.wood), "#b47a3f");
  assert.equal(shade(THEME.hoodie), "#a09b99");
  assert.equal(shade(THEME.concrete), "#7e828b");
  // darker than the lit face for every mid-tone in the palette
  const lum = (h: string) =>
    [1, 3, 5].reduce((s, i) => s + parseInt(h.slice(i, i + 2), 16), 0);
  for (const c of [THEME.wood, THEME.ball, THEME.concrete, THEME.hoodie, THEME.fur, THEME.grass]) {
    assert.ok(lum(shade(c)) < lum(c), `${c} shade must be darker`);
  }
});

test("saturate pushes channels off the mean, clamped; grays are fixed points", () => {
  assert.equal(saturate("#808080", 2), "#808080"); // no hue to deepen
  assert.equal(saturate("#804040", 1), "#804040"); // s=1 is identity
  // s>1 spreads channels away from the mean, s<1 pulls toward gray
  assert.equal(saturate("#805050", 2), "#a04040");
  assert.equal(saturate("#805050", 0), "#606060");
  assert.equal(saturate("#ff0000", 2), "#ff0000"); // clamps at the byte
});
