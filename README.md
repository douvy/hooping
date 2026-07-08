# Hooping

Six trick shots, one ball. Make the shot to advance. Miss and you start
over. There is no luck — the ball bounces the same way every time.

Play it at [hooping.io](https://hooping.io).

## How to Play

Drag back anywhere and let go to shoot. Pull further for more power.
You get one shot per level. Space repeats your exact last shot.

The physics are deterministic. The same pull always produces the same
bounce, so every level has an answer and your hands are the only
variable.

## Development

```sh
pnpm install
pnpm dev       # game at localhost:3000
pnpm test      # physics + level tests
pnpm hoopsim   # run-depth simulation: does depth track skill?
```

The simulation in `lib/hoop.ts` is RNG-free. Levels are verified by
tests: every level is solvable, no level is too generous, and no
level's answer sits on the power cap. `scripts/gauntlet.mjs` models a
practiced player with gaussian finger noise to check that full runs
feel like skill rather than dice.
