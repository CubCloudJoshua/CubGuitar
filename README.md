# CubScore

Web-first, AI-native music notation editor, player, and practice platform. Built and hosted on CubCloud sovereign infrastructure in Missoula, Montana.

See [PLAN.md](./PLAN.md) for the full product plan. The repo keeps the original CubGuitar slug; the product name is CubScore.

## Status

Phase 1 mostly done, Phase 2 started. Working today:

- **Editor** — fret entry on a semantic score model with a full operation log. Type `0`-`9` for frets (two digits combine into 10-24 the way Guitar Pro does), arrows to move the caret, `+`/`-` for beats, `Enter` for a bar, `Ctrl+Z`/`Ctrl+Shift+Z` for undo and redo, plus durations, dots, and articulations. Work autosaves to the library and reopens in the editor.
- **Player** — multitrack notation and tablature rendering with playback, click-to-seek, drag-to-select loop regions, speed trainer (presets, slider, and a ramp mode that raises speed after each loop pass), metronome, count-in, zoom, and a per-track mixer with mute, solo, and volume.
- **Library** — local-first score library on IndexedDB. Import, search, open, delete; survives reload. This is the offline layer the desktop shell needs, and the cloud library will sync on top of it rather than replace it.
- **Accounts and cloud library** — email/password accounts (scrypt, HttpOnly session cookies, no external auth service). SYNC LIBRARY pushes every local score to the cloud and pulls down ones this device is missing; policy is local-wins, cloud as backup and transfer, until CRDT sync lands. No email verification yet.
- **Share links** — SHARE uploads the current score to the API and returns a link. The recipient gets a read-only player with the full practice toolbar (seek, loop, speed trainer, mixer) and no library or editing, nothing to install. Shares created while signed in are owned: they appear in the account panel and can be revoked, which kills the link. Anonymous shares still work but cannot be revoked.
- **Import** — Guitar Pro (`.gp`, `.gp3`, `.gp4`, `.gp5`, `.gpx`), MusicXML, CapXML, alphaTex, by file picker or drag-and-drop.
- **Export** — Guitar Pro `.gp`, alphaTex, MIDI, and print/PDF.
- **Responsive** — full controls down to phone width.

Not built yet: real-time collaboration, email verification and password reset, and all AI features.

Imported Guitar Pro files are editable: an import is converted to the semantic model, and pressing EDIT opens it with a report of anything the model could not carry. Multiple voices per bar and ties survive the conversion and round-trip exactly. Percussion is the notable gap — drum tracks play faithfully in the player but are dropped from the editable version rather than converted into notation that would be wrong. Alternate endings, chord diagrams, section markers, and detailed bend curves are reported the same way.

Undo uses document snapshots rather than inverse operations; the op log is recorded but not yet replayed, which is the work that lands with sync.

Rendering and playback come from [alphaTab](https://github.com/CoderLine/alphaTab); PLAN.md Phase 2 replaces it with our own engine. Its license needs a legal check before launch.

## Architecture

The semantic score model in `packages/core` is the source of truth for authored documents, and every edit is a serializable operation in a log. That one decision is what later buys undo, version history, real-time sync, and fork lineage without a retrofit. The model carries no layout data; `toAlphaTex()` projects it for rendering today and becomes an export format once our own engine exists.

## Layout

- `packages/core` — semantic score model, operation log, op application, and the alphaTex serializer
- `packages/formats` — alphaTab-model-to-core import, with a report of what the model cannot carry
- `apps/web` — the React app
- `services/api` — accounts, cloud library, and share links (Fastify, node:crypto scrypt, no auth dependencies). Storage is behind interfaces; the dev drivers write JSON to `services/api/data/`, production swaps in Postgres + object storage without touching routes
- `fixtures/` — original alphaTex scores, committed, run in CI
- `corpus/` — real Guitar Pro files for import testing, gitignored (see `corpus/README.md`)
- `tools/corpus-check.mjs` — the Phase 0 exit test

## Develop

```sh
pnpm install
pnpm api        # start the share-link API on :8787
pnpm dev        # start the web app (proxies /api to :8787)
pnpm build      # typecheck and build everything
pnpm test       # unit tests (packages/core)
pnpm corpus     # load and render every score in fixtures/ and corpus/
```

CI runs build, unit tests, and the corpus suite (including import round-trip
pitch fidelity) on every push.

`pnpm corpus` runs the built app in headless Chromium, so run `pnpm build` first. It
reports track, bar, and note counts per score, prints alphaTab diagnostics for
failures, and exits non-zero if any score fails to parse or render.

It also measures import fidelity by round-tripping every score through
alphaTab → core → alphaTex → alphaTab and comparing note counts *and* the
multiset of MIDI pitches on both sides. The pitch comparison exists because
counts alone hide the failures that matter: it is what caught a string-numbering
inversion that left every note transposed two octaves while all the counts
matched. Any pitch drift fails the run.
