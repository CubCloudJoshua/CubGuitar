# CubScore

Web-first, AI-native music notation editor, player, and practice platform. Built and hosted on CubCloud sovereign infrastructure in Missoula, Montana.

See [PLAN.md](./PLAN.md) for the full product plan. The repo keeps the original CubGuitar slug; the product name is CubScore.

## Status

Phase 1 functionally complete, Phase 2 under way, and realtime collaboration landed early from Phase 4. Working today:

- **Editor** — fret entry on a semantic score model with a full operation log. Type `0`-`9` for frets (two digits combine into 10-24 the way Guitar Pro does), arrows to move the caret, `+`/`-` for beats, `Enter` for a bar, `Ctrl+Z`/`Ctrl+Shift+Z` for undo and redo, plus durations, dots, and articulations. Tracks are an instrument rail beside the score; tempo and meter are chips on the caret's bar, which is framed in the score so you can see where you are. Work autosaves to the library and reopens in the editor.
- **Player** — multitrack notation and tablature rendering with playback, a scrubbable position bar and a play control that wears the progress as a ring, click-to-seek, drag-to-select loop regions, speed trainer (presets, slider, and a ramp mode that raises speed after each loop pass), metronome, count-in, zoom, and a per-track mixer with mute, solo, and volume.
- **Library** — local-first score library on IndexedDB. Import, search, open, delete; survives reload. This is the offline layer the desktop shell needs, and the cloud library will sync on top of it rather than replace it. Entries belong to an account, so two people sharing a browser profile do not see or sync each other's scores; work done while signed out is adopted by the first account to sign in rather than lost.
- **Realtime collaboration** — COLLAB in the editor opens a live session; anyone with the link joins and edits the same score simultaneously, with presence (who is at which bar and beat) in the session banner. Opening a different score ends the session rather than silently forking it. Every edit streams as an op batch through `services/sync`, which orders them and echoes them to everyone including the sender. That echo is the convergence story: a client shows its own edit right away but treats it as provisional until the room says where it landed, so the document is always (server-confirmed state) + (our unacknowledged batches). Without it, each client applied its own edit first and everyone else's second, and two people who edited the same note at the same moment kept two different documents forever. **One playhead for the room.** Pressing play, pausing, stopping or seeking moves everybody's playhead, so five people read the same bar instead of hunting for it when the leader says "from bar 33". Whoever presses play is driving, and the banner says who. FOLLOWING can be turned off, because working on your own part in the middle of a rehearsal is a normal thing to want. Not sample-accurate — two browsers cannot agree on a clock that precisely without a real clock-sync protocol, and they do not need to; the driver states its position every two seconds and a follower corrects only past a third of a second of drift, so nobody reads the wrong bar and nobody's playhead twitches. Undo works inside a session: Ctrl+Z sends the inverse of your own last edit as an ordinary batch, so the room applies it in the server's order and a collaborator's work made in between survives it. v1 limits, on purpose: rooms are in-memory (a restart ends live sessions), guests do not autosave (the host's copy owns the document), and there is no offline merge yet — that is the CRDT work this protocol grows into.
- **Accounts and cloud library** — email/password accounts (scrypt, HttpOnly session cookies, no external auth service). SYNC LIBRARY pushes every local score to the cloud and pulls down ones this device is missing; policy is local-wins, cloud as backup and transfer, until CRDT sync lands. Sessions expire server-side, and each account has an entry and byte quota so one account cannot fill the disk for everyone. No email verification yet.
- **Share links** — SHARE uploads the current score to the API and returns a link. The recipient gets a read-only player with the full practice toolbar (seek, loop, speed trainer, mixer) and no library or editing, nothing to install. Shares created while signed in are owned: they appear in the account panel and can be revoked, which kills the link. Anonymous shares still work but cannot be revoked.
- **Import** — Guitar Pro (`.gp`, `.gp3`, `.gp4`, `.gp5`, `.gpx`), MusicXML, CapXML, MIDI (`.mid`, `.midi`), alphaTex, and ASCII tablature (`.txt`, `.tab`), by file picker or drag-and-drop. ASCII tab is read by CubScore itself: it recovers strings, frets and bars from a file somebody typed by hand, ignores the lyrics and chord names around the staff, reads the tuning off the string labels or out of the prose, and reports that rhythm was not carried — because the format records none, and a plausible wrong rhythm is worse than an honest even one.
- **Export** — Guitar Pro `.gp`, alphaTex, MIDI, and print/PDF. ASCII tablature is written by CubScore too, to the clipboard as well as a file, because pasting is the whole point of that format — with spacing proportional to duration, since spacing is the only rhythm information ASCII tab can carry. MIDI is written by CubScore itself (`packages/formats/src/to-midi.ts`) from the semantic model, so the file carries the document you edited — repeats expanded, tempo and meter mapped, ties held rather than re-articulated. `pnpm midi` grades it against alphaTab's own MIDI on every score in the corpus.
- **Perform mode** — PERFORM switches to a stage view: true black, engraving at full white, notation 40% larger, a position readout readable across a room, page turns on tap zones a fifth of the screen wide or on PageUp/PageDown for a foot pedal, and a setlist filmstrip that hides while the music plays. Playback turns the pages itself, keeping the playing bar high in the frame so you are reading ahead of the beat rather than at it. Escape leaves and puts everything back. The stage palette doubles as a high-contrast theme.
- **Fretboard reader** — FRETBOARD draws the neck in isometric projection with the music coming at you: each note a marker on the string and fret it is actually played on, sliding toward a strike line as playback advances. Notation tells you which fret; this tells you where your hand goes. It is also the first thing here that alphaTab does not draw — every position comes from `packages/core/src/timeline.ts` and the track's own tuning, nothing measured off an engraved canvas. A staff with no fingering of its own — an imported piano or vocal part — is fingered onto the neck by `packages/core/src/fingering.ts`, which solves the whole phrase at once so the hand stays put instead of leaping about.
- **Responsive** — full controls down to phone width.
- **Keyboard and screen readers** — every action is in the command palette, controls keep their own key handling (the editor's shortcuts step aside for whatever has focus), a closed drawer is inert rather than an invisible row of tab stops, and state changes that used to be conveyed by colour alone — a copied link, a sync result, a live session, an error — are announced.

Not built yet: offline collaboration merge (CRDT), email verification and password reset, and all AI features.

[DIFFERENTIATION.md](DIFFERENTIATION.md) is the case for what CubScore can do that nothing else in the category can, filtered to things we can build because of something we already own. Two further planning documents cover what comes next: [STANDALONE.md](STANDALONE.md) on owning the engraver, the playback engine and the file parsers rather than renting them from alphaTab, and [INTEROP.md](INTEROP.md) on MIDI, MusicXML, Guitar Pro, ASCII tab and every other kind of tablature.

Imported Guitar Pro files are editable, and editing one never costs you the file. The library row keeps the original bytes, filename, and import report untouched — autosave only ever writes the fields the editor owns — so an import carries both the original and your working edit. "Show imported original" in the palette switches which one opening shows; EDIT resumes the edit.

An import is converted to the semantic model, and pressing EDIT opens it with a report of anything the model could not carry. Multiple voices per bar and ties survive the conversion and round-trip exactly. Percussion is carried now: drum tracks come into the semantic model as General MIDI drum voices and are written to MIDI on channel 10, which `pnpm midi` grades against alphaTab's own channel-10 output. Drum *notation* is still the gap — alphaTex takes an articulation index rather than a drum number, and only five of the 47 General MIDI voices resolve under its default list — so a drum-only file stays play-only and the player says which half works. Alternate endings, chord diagrams, section markers, and detailed bend curves are reported the same way.

A file with nothing CubScore can edit — a drum-only transcription, since percussion is not in the model yet — stays play-only and says so in the player. It used to offer EDIT and then hand you a blank guitar staff where your music had been.

**Arrange for guitar** turns a staff with no strings into playable tablature: "Arrange this staff for guitar" (or bass) in the palette fingers the whole part with `packages/core/src/fingering.ts`, shifts it by octaves if it sits outside the instrument's range, and reports what it could not place. It is one op batch, so one Ctrl+Z takes it back — which is why it can be a button rather than a destructive command with a warning.

**MIDI files come in as notation, not as a piano roll.** A MIDI file states pitches and times and nothing a reader needs: no note values, no bar lines anyone would agree with, no idea which channel is which instrument, and for a guitar part no position on the neck. `packages/formats/src/from-midi-score.ts` decides all of it — quantising against the file's own tempo and meter maps, splitting parts by track *and* channel (which is the only thing separating instruments in a format-0 file), rescaling the file's division to ours, and fingering the fretted parts. A guitar program becomes a fretted track and a bass program a bass; everything else stays pitched and keeps its program, because a piano part is editable as notation and "Arrange this staff for guitar" already exists for when the user actually wants that. Every guess is in the import notice: a tuning General MIDI has no way to state, a channel that changes instrument mid-piece, bends not reconstructed, drum notation still a gap.

Graded by a round trip through our own writer, which is a stronger check than it sounds: `to-midi.ts` was written to export and the quantiser was written for audio transcription, so a disagreement between them is a real one rather than one implementation confirming itself.

**Audio to tablature, measured before it is claimed.** The flagship (see [DIFFERENTIATION.md](DIFFERENTIATION.md) §2) is four stages: separate the guitar from the mix, get pitches and onsets, turn pitches into a rhythm, turn pitches into a fretboard. The first two are off-the-shelf models and GPU time. The last two are ours, and both are now built: `packages/core/src/fingering.ts` and `packages/core/src/quantise.ts`, which is `timeline()` in reverse — tempo estimation, grid snapping, notatable durations with ties across bar lines, and a bar that always sums to its meter.

What makes this measurable ahead of the GPU work is that we own both ends. `timeline()` turns any score into the notes a perfect detector would report, so every file in the corpus is a labelled example with *exact* labels and no annotation cost. `pnpm transcribe` plays each score, adds detector-shaped timing error, pushes it back through the quantiser and the fingering solver, and grades the result against the score it came from. On the 13-score corpus it recovers 100% of notes at 0ms and 15ms of jitter and 99% at 40ms, and every fingering it writes sounds the note it is written for — that last one is gated at 100%, because there is exactly one right answer. Whether our fingering matches the *transcriber's* choice runs 63%, and that is reported rather than gated: A2 is string 5 open or string 6 fret 5, a guitarist plays either, and grading agreement would be grading taste.

Two limits it states rather than hides. Tuplets are not written yet, so a triplet passage is snapped straight and the count of onsets that wanted one is reported (`tripletsWanted`). And one tempo and one meter are written per transcription, so a score that changes either says so in the row. This is a claim about the two stages that are ours, not about transcribing a recording: when the GPU stages land, their error compounds with this, and the two are measured apart so a regression has one owner.

**Songwriting is on the music, not in a dialog.** Press `C` on a beat and type the chord ("Am7", "C/G"); press `L` and type the syllable; Tab commits and moves to the next beat with the input still open, so a chart or a lyric line goes in as one pass along the bar. Sections ("Verse", "Chorus") are a chip beside tempo and meter on the caret's bar. Under the chord input, suggestions from `packages/core/src/harmony.ts` are ranked by what usually follows the previous chord in the key, each carrying its roman numeral and, on hover, why it is offered; a writer who knows what they want ignores them at no cost. The harmony engine parses symbols rather than matching shapes, so "Insert chord voicing" finds correct fingerings in DADGAD, drop D, or under a capo, not just in standard tuning. A symbol the parser cannot read is warned about once and then kept on purpose, because the model stores what you typed and you may mean something the grammar does not know. **Compose accompaniment** (strummed, held, or arpeggiated) builds a backing track from the chart as a single op, so one Ctrl+Z takes the whole track back. Chords, lyrics and sections are ops like every other edit: they collaborate live, they undo, and they survive alphaTex, MusicXML, and ASCII export (`pnpm musicxml` and the corpus grade the round trips).

**LISTEN** grades what you actually played. The microphone goes through our own pitch and onset detection (`packages/core/src/pitch.ts`, YIN rather than plain autocorrelation, because the second harmonic of a plucked string is frequently louder than the fundamental and autocorrelation answers with the octave above), and `listen.ts` compares what it heard against `timeline()`. Each bar gets a band under it coloured by how it went, and a strip above the score says the same thing in numbers: how many notes were played, how many were wrong, how many missed, and whether you rush or drag. That last number is signed on purpose — rushing and dragging are different problems with different fixes, and it is the one thing a metronome cannot tell you about your own playing.

Two things it refuses to do. A note it cannot judge is reported as *not checked* rather than missed: a single-pitch detector hears a strummed chord as one note, and scoring the other five as missed would tell you that you failed to play notes you played. And a wrong note is reported separately from a missing note, because those have different fixes. Two limitations it states rather than hides: a microphone hears CubScore's own playback too, so this only measures a person through headphones, and the latency from string to frame is accounted for in part and cannot be fully known, so the timing figure carries an unknown constant offset. The detector takes a plain `Float32Array`, which is what lets it be tested against synthesized waveforms at known frequencies with no browser in the loop — `packages/core/src/listen.test.ts` synthesizes a performance from a timeline and grades it back against the score it came from, and `e2e/suites/listening.mjs` drives the real thing in Chromium with a WAV file as its microphone.

**MusicXML in and out**, which is how a part leaves here for an arranger, a teacher, or a school's existing software. Written from the semantic model with the staff's tuning and every note's string and fret, so a guitar part arrives in MuseScore as tablature rather than as pitches somebody has to finger again. Import goes through our own reader (`packages/formats/src/from-musicxml.ts`) rather than being handed to alphaTab, which is what makes a report of what the file could not carry possible at all. `pnpm musicxml` grades our file against alphaTab's own MusicXML reader on every score in the corpus, counting how many notes came back still fingered: 11,029 and 5,721 on the two real files, and 12 of 12 scores agree.

**Practice is remembered.** Each graded take is stored, and the strip above the score says how many takes you have done, which bars to work on now, and the tempo you can actually play the piece at. That last number is the tempo of the passage's *worst* bar, not its best, because "I can play it at 120" means all of it. A bar's due date doubles with each consecutive clean pass, so getting something right once does not mark it learned. `packages/core/src/practice.ts` holds the analysis and takes the clock as an argument, so the same history always produces the same plan.

**RECORDING plays a record with the score.** Attach an audio file, press play, and tap SYNC on a beat you can hear; the notation follows the recording from then on. Two taps is enough for a steady tempo and more taps buy accuracy through a performance that moves. The recording leads and the synth is silenced, because two independent clocks nudging each other is how a scroll ends up half a bar out. The alignment is straight lines between marks (`packages/core/src/sync.ts`): a curve fitted through taps invents accelerations nobody played, and where a performance moves the answer is more marks, which is something a user can act on. The app also says what rate it thinks the two clocks run at and names a mark that looks mistapped, because a wrong mark is a failure only the user can fix. The recording and its marks last for the session and are not stored yet: the audio is an object URL that dies with the tab, and keeping marks that outlive the file they align would leave a user with an alignment against a recording the app cannot find. Storing both together is the next step and belongs with the audio, not ahead of it.

Staves with no strings — a piano or vocal part — are carried pitch-exact and are not reported as lost, because they are not. Until they are arranged they are read-only in the editor: fret entry needs a tuning to turn a digit into a pitch, and there is none, so the editor refuses rather than inventing notes. `fixtures/09-pitched-staff.altex` guards the round trip and `e2e/suites/pitched-staff.mjs` guards the refusal.

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
pnpm transcribe # play every score, hear it back, and grade the recovered notation
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
