import { test } from "node:test";
import assert from "node:assert/strict";
import { darken, mix, saturate, withAlpha } from "./theme.ts";

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

test("saturate pushes channels off the mean, clamped; grays are fixed points", () => {
  assert.equal(saturate("#808080", 2), "#808080"); // no hue to deepen
  assert.equal(saturate("#804040", 1), "#804040"); // s=1 is identity
  // s>1 spreads channels away from the mean, s<1 pulls toward gray
  assert.equal(saturate("#805050", 2), "#a04040");
  assert.equal(saturate("#805050", 0), "#606060");
  assert.equal(saturate("#ff0000", 2), "#ff0000"); // clamps at the byte
});
