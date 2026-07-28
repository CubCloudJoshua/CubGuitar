# CubScore

Web-first, AI-native music notation editor, player, and practice platform. Built and hosted on CubCloud sovereign infrastructure in Missoula, Montana.

See [PLAN.md](./PLAN.md) for the full product plan. The repo keeps the original CubGuitar slug; the product name is CubScore.

## Status

Phase 1, in progress. Working today:

- **Player** — multitrack notation and tablature rendering with playback, click-to-seek, drag-to-select loop regions, speed trainer (presets, slider, and a ramp mode that raises speed after each loop pass), metronome, count-in, zoom, and a per-track mixer with mute, solo, and volume.
- **Library** — local-first score library on IndexedDB. Import, search, open, delete; survives reload. This is the offline layer the desktop shell needs, and the cloud library will sync on top of it rather than replace it.
- **Import** — Guitar Pro (`.gp`, `.gp3`, `.gp4`, `.gp5`, `.gpx`), MusicXML, CapXML, alphaTex, by file picker or drag-and-drop.
- **Export** — Guitar Pro `.gp`, alphaTex, MIDI, and print/PDF.
- **Responsive** — full controls down to phone width.

Not built yet: the editor, accounts and cloud sync, and all AI features. Rendering and playback currently come from [alphaTab](https://github.com/CoderLine/alphaTab); PLAN.md Phase 2 replaces it with our own engine. Its license needs a legal check before launch.

## Layout

- `packages/core` — semantic score model and operation log (v0 sketch, not yet wired to the app)
- `apps/web` — the React app
- `fixtures/` — original alphaTex scores, committed, run in CI
- `corpus/` — real Guitar Pro files for import testing, gitignored (see `corpus/README.md`)
- `tools/corpus-check.mjs` — the Phase 0 exit test

## Develop

```sh
pnpm install
pnpm dev        # start the web app
pnpm build      # typecheck and build everything
pnpm corpus     # load and render every score in fixtures/ and corpus/
```

`pnpm corpus` runs the built app in headless Chromium, so run `pnpm build` first. It
reports track, bar, and note counts per score, prints alphaTab diagnostics for
failures, and exits non-zero if any score fails to parse or render.
