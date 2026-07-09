import { test } from "node:test";
import assert from "node:assert/strict";
import { darken, withAlpha } from "./theme.ts";

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
