# CubScore

Web-first, AI-native music notation editor, player, and practice platform. Built and hosted on CubCloud sovereign infrastructure in Missoula, Montana.

See [PLAN.md](./PLAN.md) for the full product plan. The repo keeps the original CubGuitar slug; the product name is CubScore.

## Status

Phase 1 mostly done, Phase 2 started. Working today:

- **Editor** — fret entry on a semantic score model with a full operation log. Type `0`-`9` for frets (two digits combine into 10-24 the way Guitar Pro does), arrows to move the caret, `+`/`-` for beats, `Enter` for a bar, `Ctrl+Z`/`Ctrl+Shift+Z` for undo and redo, plus durations, dots, and articulations. Work autosaves to the library and reopens in the editor.
- **Player** — multitrack notation and tablature rendering with playback, click-to-seek, drag-to-select loop regions, speed trainer (presets, slider, and a ramp mode that raises speed after each loop pass), metronome, count-in, zoom, and a per-track mixer with mute, solo, and volume.
- **Library** — local-first score library on IndexedDB. Import, search, open, delete; survives reload. This is the offline layer the desktop shell needs, and the cloud library will sync on top of it rather than replace it.
- **Import** — Guitar Pro (`.gp`, `.gp3`, `.gp4`, `.gp5`, `.gpx`), MusicXML, CapXML, alphaTex, by file picker or drag-and-drop.
- **Export** — Guitar Pro `.gp`, alphaTex, MIDI, and print/PDF.
- **Responsive** — full controls down to phone width.

Not built yet: accounts and cloud sync, real-time collaboration, and all AI features.

Two current limitations worth knowing. Imported Guitar Pro files are play-only: editing needs an alphaTab-model-to-core importer that does not exist yet, so only scores authored in CubScore are editable. And undo uses document snapshots rather than inverse operations; the op log is recorded but not yet replayed, which is the work that lands with sync.

Rendering and playback come from [alphaTab](https://github.com/CoderLine/alphaTab); PLAN.md Phase 2 replaces it with our own engine. Its license needs a legal check before launch.

## Architecture

The semantic score model in `packages/core` is the source of truth for authored documents, and every edit is a serializable operation in a log. That one decision is what later buys undo, version history, real-time sync, and fork lineage without a retrofit. The model carries no layout data; `toAlphaTex()` projects it for rendering today and becomes an export format once our own engine exists.

## Layout

- `packages/core` — semantic score model, operation log, op application, and the alphaTex serializer
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
