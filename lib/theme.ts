// The palette — one fixed theme, tuned by hand. Flat cartoon streetball:
// every shape wears a thick warm-dark outline, the world is pastel, the
// ball is the hottest thing on screen. The HUD's CSS variables in
// app/globals.css are drawn from the same family; change one, check both.

export const THEME = {
  /** the thick cartoon line everything wears — also the text ink */
  outline: "#312d28",
  /** clouds, the board, the net, painted lines */
  paper: "#fdfaf2",
  /** the ball — flat mustard leather */
  ball: "#dfa63f",
  /** the iron — muted brick, reads against the mustard ball */
  rim: "#c15b4c",
  /** gold — new bests, the crown, the game winner */
  gold: "#f2b32e",
  /** the court cap the game is played on */
  asphalt: "#67788a",
  /** the backboard's plank face */
  wood: "#df9a4e",
  /** the grass the court sits in */
  grass: "#7ec850",
  /** obstacle slabs */
  concrete: "#93a5b8",
  /** the floodlight, and the city's lit windows */
  lamp: "#ffc95e",
  /** the creature */
  fur: "#49505d",
  hair: "#2b303c",
  face: "#d3d7dd",
  headband: "#3f8fdd",
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
