# CubScore

Web-first, AI-native music notation editor, player, and practice platform. Built and hosted on CubCloud sovereign infrastructure in Missoula, Montana.

See [PLAN.md](./PLAN.md) for the full product plan. The repo keeps the original CubGuitar slug; the product name is CubScore.

## Status

Phase 1 functionally complete, Phase 2 under way, and realtime collaboration landed early from Phase 4. Working today:

- **Editor** — fret entry on a semantic score model with a full operation log. Type `0`-`9` for frets (two digits combine into 10-24 the way Guitar Pro does), arrows to move the caret, `+`/`-` for beats, `Enter` for a bar, `Ctrl+Z`/`Ctrl+Shift+Z` for undo and redo, plus durations, dots, and articulations. Tracks are an instrument rail beside the score; tempo and meter are chips on the caret's bar, which is framed in the score so you can see where you are. Work autosaves to the library and reopens in the editor.
- **Player** — multitrack notation and tablature rendering with playback, a scrubbable position bar and a play control that wears the progress as a ring, click-to-seek, drag-to-select loop regions, speed trainer (presets, slider, and a ramp mode that raises speed after each loop pass), metronome, count-in, zoom, and a per-track mixer with mute, solo, and volume.
- **Library** — local-first score library on IndexedDB. Import, search, open, delete; survives reload. This is the offline layer the desktop shell needs, and the cloud library will sync on top of it rather than replace it. Entries belong to an account, so two people sharing a browser profile do not see or sync each other's scores; work done while signed out is adopted by the first account to sign in rather than lost.
- **Realtime collaboration** — COLLAB in the editor opens a live session; anyone with the link joins and edits the same score simultaneously, with presence (who is at which bar and beat) in the session banner. Opening a different score ends the session rather than silently forking it. Every edit streams as an op batch through `services/sync`, which orders them and echoes them to everyone including the sender. That echo is the convergence story: a client shows its own edit right away but treats it as provisional until the room says where it landed, so the document is always (server-confirmed state) + (our unacknowledged batches). Without it, each client applied its own edit first and everyone else's second, and two people who edited the same note at the same moment kept two different documents forever. Undo works inside a session: Ctrl+Z sends the inverse of your own last edit as an ordinary batch, so the room applies it in the server's order and a collaborator's work made in between survives it. v1 limits, on purpose: rooms are in-memory (a restart ends live sessions), guests do not autosave (the host's copy owns the document), and there is no offline merge yet — that is the CRDT work this protocol grows into.
- **Accounts and cloud library** — email/password accounts (scrypt, HttpOnly session cookies, no external auth service). SYNC LIBRARY pushes every local score to the cloud and pulls down ones this device is missing; policy is local-wins, cloud as backup and transfer, until CRDT sync lands. Sessions expire server-side, and each account has an entry and byte quota so one account cannot fill the disk for everyone. No email verification yet.
- **Share links** — SHARE uploads the current score to the API and returns a link. The recipient gets a read-only player with the full practice toolbar (seek, loop, speed trainer, mixer) and no library or editing, nothing to install. Shares created while signed in are owned: they appear in the account panel and can be revoked, which kills the link. Anonymous shares still work but cannot be revoked.
- **Import** — Guitar Pro (`.gp`, `.gp3`, `.gp4`, `.gp5`, `.gpx`), MusicXML, CapXML, alphaTex, by file picker or drag-and-drop.
- **Export** — Guitar Pro `.gp`, alphaTex, MIDI, and print/PDF.
- **Perform mode** — PERFORM switches to a stage view: true black, engraving at full white, notation 40% larger, a position readout readable across a room, page turns on tap zones a fifth of the screen wide or on PageUp/PageDown for a foot pedal, and a setlist filmstrip that hides while the music plays. Playback turns the pages itself, keeping the playing bar high in the frame so you are reading ahead of the beat rather than at it. Escape leaves and puts everything back. The stage palette doubles as a high-contrast theme.
- **Fretboard reader** — FRETBOARD draws the neck in isometric projection with the music coming at you: each note a marker on the string and fret it is actually played on, sliding toward a strike line as playback advances. Notation tells you which fret; this tells you where your hand goes. It is also the first thing here that alphaTab does not draw — every position comes from `packages/core/src/timeline.ts` and the track's own tuning, nothing measured off an engraved canvas.
- **Responsive** — full controls down to phone width.
- **Keyboard and screen readers** — every action is in the command palette, controls keep their own key handling (the editor's shortcuts step aside for whatever has focus), a closed drawer is inert rather than an invisible row of tab stops, and state changes that used to be conveyed by colour alone — a copied link, a sync result, a live session, an error — are announced.

Not built yet: offline collaboration merge (CRDT), email verification and password reset, and all AI features.

Two planning documents cover what comes next: [STANDALONE.md](STANDALONE.md) on owning the engraver, the playback engine and the file parsers rather than renting them from alphaTab, and [INTEROP.md](INTEROP.md) on MIDI, MusicXML, Guitar Pro, ASCII tab and every other kind of tablature.

Imported Guitar Pro files are editable, and editing one never costs you the file. The library row keeps the original bytes, filename, and import report untouched — autosave only ever writes the fields the editor owns — so an import carries both the original and your working edit. "Show imported original" in the palette switches which one opening shows; EDIT resumes the edit.

An import is converted to the semantic model, and pressing EDIT opens it with a report of anything the model could not carry. Multiple voices per bar and ties survive the conversion and round-trip exactly. Percussion is the notable gap — drum tracks play faithfully in the player but are dropped from the editable version rather than converted into notation that would be wrong. Alternate endings, chord diagrams, section markers, and detailed bend curves are reported the same way.

A file with nothing CubScore can edit — a drum-only transcription, since percussion is not in the model yet — stays play-only and says so in the player. It used to offer EDIT and then hand you a blank guitar staff where your music had been.

Staves with no strings — a piano or vocal part — are carried pitch-exact and are not reported as lost, because they are not. They are read-only in the editor: fret entry needs a tuning to turn a digit into a pitch, and there is none, so the editor refuses rather than inventing notes. `fixtures/09-pitched-staff.altex` guards the round trip and `e2e/suites/pitched-staff.mjs` guards the refusal.

The op log is replayed for real now: a live session's whole history is what a late joiner is handed, and `packages/core/src/session.ts` rebuilds the document from it on every acknowledgement. Undo is inverse operations rather than document snapshots (`packages/core/src/invert.ts`), which is what lets it work in a session — Ctrl+Z sends the inverse of your own edit through the server like any other batch, so it converges and it cannot reach past the edit it inverts. Snapshot undo could not be made to do either: a snapshot describes a document nobody shares the instant a collaborator types, and restoring one after a session ended reinstated a pre-collab document and autosaved it over everything the session had produced.

Rendering and playback come from [alphaTab](https://github.com/CoderLine/alphaTab); PLAN.md Phase 2 replaces it with our own engine. Its license needs a legal check before launch.

## Architecture

The semantic score model in `packages/core` is the source of truth for authored documents, and every edit is a serializable operation in a log. That one decision is what later buys undo, version history, real-time sync, and fork lineage without a retrofit. The model carries no layout data; `toAlphaTex()` projects it for rendering today and becomes an export format once our own engine exists.

## Layout

- `packages/core` — semantic score model, operation log, op application, and the alphaTex serializer
- `packages/formats` — alphaTab-model-to-core import, with a report of what the model cannot carry
- `packages/design` — design tokens (UI-DESIGN.md) and the UI primitives every component is built from
- `apps/web` — the React app
- `services/api` — accounts, cloud library, and share links (Fastify, node:crypto scrypt, no auth dependencies). Storage is behind interfaces; the dev drivers write JSON to `services/api/data/`, production swaps in Postgres + object storage without touching routes. Records are written by rename so a crash cannot leave a fragment, and an unreadable record is contained to itself rather than failing every login
- `services/sync` — realtime collaboration rooms over WebSocket (`ws`), assigning the order that every client's document follows
- `fixtures/` — original alphaTex scores, committed, run in CI
- `corpus/` — real Guitar Pro files for import testing, gitignored (see `corpus/README.md`)
- `e2e/` — browser-driven journey suites and their runner
- `tools/corpus-check.mjs` — the Phase 0 exit test

## Develop

```sh
pnpm install
pnpm api        # start the accounts/library/share API on :8787
pnpm sync       # start the realtime collaboration service on :8788
pnpm dev        # start the web app (proxies /api and /ws)
pnpm build      # typecheck and build everything
pnpm test       # unit tests (packages/core, packages/formats, services/api)
pnpm corpus     # load and render every score in fixtures/ and corpus/
pnpm audio      # synthesize every score to samples and confirm it makes sound
pnpm e2e        # drive the built app in a browser across ten journeys
```

CI runs build, unit tests, the corpus suite (including import round-trip pitch
fidelity), the audio check, and the end-to-end suites on every push.

`pnpm audio` exists because nobody involved has heard this app. It is built and
tested in headless browsers with no audio device, so every other gate checks the
notation and assumes the sound. alphaTab can synthesize to raw samples instead of
to a speaker, so this measures what actually came out: peak, RMS, clipping, and
the share of 100ms windows containing anything audible.

What it proves, precisely: the soundfont is served at the path the app configures,
and every score in `fixtures/` and `corpus/` synthesizes to audible, unclipped
audio with it. Remove the soundfont and all of them go silent and the check
fails. What it does not prove is the app's own player instance being wired
correctly, because the harness constructs its own synthesizer rather than
capturing the live player's output — that would need Web Audio interception. The
e2e suites cover the near half of that gap: they wait for the app's player to
report ready, which only happens once it has loaded that soundfont, and they
drive playback to a running state and back.

`pnpm e2e` needs `pnpm build` first. It stands up the API and sync services on
isolated ports against a throwaway data directory, so it never touches a running
dev stack or its data, then drives the real app in headless Chromium: editing,
track and meter changes, the command palette, phone-width layout, whether an
imported file survives being edited, share-and-save, two-browser realtime
collaboration including a conflicting simultaneous edit, accounts with
cross-device sync and revocation, and two people sharing one browser profile.
Pass suite names to run a subset (`pnpm e2e collab accounts`). Every UI regression in
this project so far was caught here rather than by unit tests — focus races,
double-committed operations, a semantic element lost in a refactor — which is why
these journeys are version-controlled and gated in CI rather than kept as
throwaway scripts.

`pnpm corpus` runs the built app in headless Chromium, so run `pnpm build` first. It
reports track, bar, and note counts per score, prints alphaTab diagnostics for
failures, and exits non-zero if any score fails to parse or render.

It also measures import fidelity by round-tripping every score through
alphaTab → core → alphaTex → alphaTab and comparing note counts *and* the
multiset of MIDI pitches on both sides. The pitch comparison exists because
counts alone hide the failures that matter: it is what caught a string-numbering
inversion that left every note transposed two octaves while all the counts
matched. Any pitch drift fails the run.
