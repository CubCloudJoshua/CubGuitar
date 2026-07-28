# CubScore

Web-first, AI-native music notation editor, player, and practice platform. Built and hosted on CubCloud sovereign infrastructure in Missoula, Montana.

See [PLAN.md](./PLAN.md) for the full product plan. The repo keeps the original CubGuitar slug; the product name is CubScore.

## Status

Phase 0. Working spike: alphaTab-based score rendering and playback in the browser.

## Layout

- `packages/core` – semantic score model and operation log (v0 sketch)
- `apps/web` – React app with the alphaTab spike

## Develop

```sh
pnpm install
pnpm dev        # start the web app
pnpm build      # typecheck and build everything
```

Open the dev server, press PLAY, or drop any `.gp3`/`.gp4`/`.gp5`/`.gpx`/`.gp` file onto the page to open it.
