// The palette — one fixed theme, tuned by hand. Flat cartoon streetball:
// every shape wears a thick warm-dark outline, the world is pastel, the
// ball is the hottest thing on screen. The HUD's CSS variables in
// app/globals.css are drawn from the same family; change one, check both.

export const THEME = {
  /** the one ink — every line in the scene is this warm dark umber,
   * never pure black, never gray. Also the text ink. */
  outline: "#3a2e2a",
  /** clouds, the board, the net, painted lines */
  paper: "#fdfaf2",
  /** the ball — flat mustard leather */
  ball: "#dfa63f",
  /** the iron — muted brick, reads against the mustard ball */
  rim: "#c15b4c",
  /** gold — new bests, the crown, the game winner */
  gold: "#f2b32e",
  /** the court cap the game is played on — black asphalt, held a hair
   * above the outline ink so the seam strokes still read */
  asphalt: "#3a3d42",
  /** the backboard's plank face */
  wood: "#df9a4e",
  /** the grass the court sits in — nudged golden: the foreground band
   * lives in the warm zone of the scene's single upper-left light */
  grass: "#89c94c",
  /** obstacle slabs */
  concrete: "#93a5b8",
  /** the floodlight, and the city's lit windows */
  lamp: "#ffc95e",
  /** the creature — palette traced off the running-boy reference:
   * blue mop, warm tan skin, white fleece, dark denim legs */
  fur: "#31648e",
  hair: "#293243",
  face: "#edb078",
  headband: "#3f8fdd",
  /** his hoodie — grey heather fleece */
  hoodie: "#c3c7cb",
  /** the hoodie's kangaroo pocket — the same fleece, one stop darker */
  pocket: "#a9adb3",
  /** his sneakers — grape 5s: the midsole purple and the teal of the
   * shark teeth and collar; the upper is paper white */
  grape: "#4b34a5",
  teal: "#3fd0c5",
} as const;

/** one sky per level — afternoon cooling through sunset into night.
 * advancement reads as travel: you started playing at four and you're
 * still out there after dark. */
export const SKIES = [
  "#bde4f0",
  "#abd6ec",
  "#f5c98b",
  "#e79b78",
  "#77719f",
  "#2b3252",
] as const;

/** Linear blend a→b in RGB — ambient light lives here: paint mixed
 * toward the sky it stands under. */
export function mix(a: string, b: string, t: number): string {
  let out = "#";
  for (let i = 1; i < 7; i += 2) {
    const ca = parseInt(a.slice(i, i + 2), 16);
    const cb = parseInt(b.slice(i, i + 2), 16);
    out += Math.round(ca + (cb - ca) * t)
      .toString(16)
      .padStart(2, "0");
  }
  return out;
}

/** Push a hex color's channels away from their mean — s>1 deepens the
 * hue instead of graying it. Darkened-sky silhouettes go muddy without
 * this; saturate-then-darken keeps a blue city blue and a golden city
 * ochre. */
export function saturate(hex: string, s: number): string {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const m = (ch[0] + ch[1] + ch[2]) / 3;
  let out = "#";
  for (const c of ch) {
    const v = Math.max(0, Math.min(255, Math.round(m + (c - m) * s)));
    out += v.toString(16).padStart(2, "0");
  }
  return out;
}

/** Scale a hex color's channels — f<1 darkens (skyline layers, seams),
 * f>1 lightens, clamped to the byte. */
export function darken(hex: string, f: number): string {
  let out = "#";
  for (let i = 1; i < 7; i += 2) {
    const c = Math.min(255, Math.round(parseInt(hex.slice(i, i + 2), 16) * f));
    out += c.toString(16).padStart(2, "0");
  }
  return out;
}

/** #rrggbb → #rrggbbaa — gradient endpoints need a transparent twin. */
export function withAlpha(hex: string, aa: string): string {
  return hex + aa;
}

/** The shade face of a lit fill — one step darker AND one step warmer,
 * hard edge, never gray-darkened. Every two-light object in the scene
 * (roofs, the hoodie, the ball, the pole) mixes its shade here so the
 * whole world's shadow physics match. */
export function shade(hex: string): string {
  return darken(mix(hex, "#8a4f2c", 0.16), 0.86);
}

/** The one ground-shadow ink — cool and translucent, shared by every
 * contact shadow in the scene: pools under verticals, the seam under
 * the row houses. One color, one direction (lower-right). */
export const SHADOW = withAlpha(mix(THEME.outline, "#2e4166", 0.5), "2e");
