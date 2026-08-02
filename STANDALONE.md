# Standing alone

CubScore renders, plays and parses music through alphaTab today. This is the plan
for owning those three things ourselves, why it is worth doing, what it costs, and
what order to do it in.

The short version: we already own the model and the edit semantics, which are the
parts that are hard to get right and expensive to change. What we rent is the
engraver, the synthesiser, and the file parsers — three well-bounded pieces, each
replaceable on its own, each testable against the thing it replaces.

## 1. Where we stand

alphaTab 1.8.4, MPL-2.0. Read the licence section below before assuming that is
a problem or that it is not.

**What we already own, with no alphaTab in it:**

| Piece | Where | What it means |
| --- | --- | --- |
| Semantic score model | `packages/core/src/score.ts` | Ids, rational durations, tunings. No layout, no presentation. |
| Operation log and application | `ops.ts`, `apply.ts` | Every edit is a serialisable op. The document is derived. |
| Inverse operations | `invert.ts` | Undo and redo, and why they work in a live session. |
| Convergence rule | `session.ts` | Server-ordered ordering, tested against a model of the sync server. |
| Timeline | `timeline.ts` | When each note sounds, in seconds. Repeats expanded, tempo and meter followed. |
| Sync server and protocol | `services/sync` | Ours entirely. |
| Accounts, library, sharing | `services/api`, `apps/web/src/library` | Ours entirely. |
| Design system | `packages/design` | Ours entirely. |
| Fretboard reader | `apps/web/src/iso` | The first view drawn from our model rather than alphaTab's. |
| Fingering solver and arranger | `fingering.ts`, `arrange.ts` | Where a pitch goes on a neck, as an op batch. |
| Pitch and onset detection | `pitch.ts` | YIN over a `Float32Array`. No Web Audio, no DOM, no alphaTab. |
| Practice grading | `listen.ts` | What was heard against what `timeline()` says. Ours entirely. |
| Practice history | `practice.ts` | Which bars you fail, and the tempo you can play them at. |
| Recording alignment | `sync.ts` | The map between a record's clock and the score's. |
| MusicXML, both directions | `to-musicxml.ts`, `from-musicxml.ts`, `xml.ts` | Including the XML parser, so neither half needs a dependency. |

**What alphaTab does for us:**

| Job | Where we call it | Replaceable by |
| --- | --- | --- |
| Engraving tab and standard notation to SVG | `apps/web/src/useAlphaTab.ts` | Phase R, our own engraver |
| Layout geometry (bar, beat, staff-system bounds) | same, consumed by `BarMarkings`, `PeerCarets`, `JoinReveal` | Falls out of Phase R for free — the engraver knows where it put things |
| Playback: soundfont synthesis, transport, cursor | `useAlphaTab.ts` | Phase P, Web Audio |
| Audio export | `corpus-harness.ts`, `tools/audio-check.mjs` | Phase P |
| Parsing GP3/GP4/GP5/GPX/GP7 | `useLibrary.ts` via `api.load` | Phase I |
| Parsing alphaTex | our editor writes tex and hands it over | Phase R removes the need entirely |
| Writing GP7, alphaTex, MIDI, print/PDF | `apps/web/src/export.ts` | Phase X, and see INTEROP.md |
| Reference implementation to test against | `tools/corpus-check.mjs`, `tools/timing-check.mjs` | **Keep.** See §6. |

One thing to be honest about: the alphaTex round trip in the middle of our own
editor is the strangest part of the current design. Every keystroke rebuilds the
whole document as alphaTex text and hands it to a parser, because that was the
cheapest way to get an engraver. It works and it is fast enough, but it means our
model is serialised and re-parsed on every edit, and it is why the editor cannot
render anything alphaTex cannot express. Phase R deletes that round trip.

## 2. Why do it

Four reasons, in the order they will actually bite.

**Views we cannot build.** The fretboard reader had to be written from our own
timeline because alphaTab does not draw one. The same is true of everything on the
product roadmap that is not a page of notation: a piano-roll editor, a chord-grid
view, a practice heatmap showing which bars you keep failing, an AI-generated
fingering overlay. Each of those needs geometry alphaTab has no reason to expose.

**Rendering control.** Engraving decisions are product decisions for a notation
app. Every one of them — how tight the spacing is, where a chord diagram sits, how
a bend curve is drawn, what a selection looks like — is currently someone else's
call, and the ones we have wanted to change we have had to work around. The join
sequence animates bands of background colour over the score because there is no
per-system handle to fade. Perform mode restyles the shell rather than
re-rendering, because alphaTab binds to one DOM node for the life of its api.

**Bundle and boot.** `alphaTab.worker` and `alphaTab.worklet` are 1.2MB each and
`from-alphatab` pulls in another 1.27MB. The web app's own code is 222KB. A
tab-only engraver plus a sampler is a small fraction of that, and the difference is
felt most by exactly the people we most want to reach on a phone.

**Sovereignty, meant literally.** CubCloud sells sovereign infrastructure. A
product whose core capability is a dependency we do not control is a weaker story
than one where it is not. This is the least urgent of the four reasons and the one
that will be quoted most often.

## 3. Phase R — our own engraver

> **Measured, and it moved this up the list.** Phase R was filed as a licence
> project. It is not: it is the ceiling on the editor. A keystroke costs 20ms on the
> four-bar demo and 1,776ms on a 274-bar song, and `pnpm editperf` now fails the build
> on that. The cost is alphaTab re-laying-out the score, not our alphaTex round trip —
> parsing Stairway's tex is ~10ms of a 967ms keystroke.
>
> Three levers were tried and measured, all of them alphaTab's own:
>
> | | Stairway (166 bars) | Achilles (274 bars) |
> | --- | --- | --- |
> | Whole-score render | 975ms | 1,934ms |
> | `RenderHints.firstChangedMasterBar` at bar 150 | 538ms | 1,620ms |
> | `display.startBar` + `barCount`, a 32-bar window | 498ms | 780ms |
>
> The best any of them reaches is 478ms, against a 100ms budget, and the render hint
> buys nothing at all for an edit near the top of a score — which is where people
> start. A 32-bar window on a 274-bar score still costs 60% more than the same window
> on a 166-bar one, so a large part of the cost scales with the whole document however
> little of it is drawn.
>
> Wiring the render hint was tried and reverted: `api.renderScore` does not raise
> `scoreLoaded`, so the track list went stale after a removal (`pnpm e2e tracks` caught
> it), and a second render path with its own failure modes is not worth 20% on a number
> that has to come down by 5×.
>
> One stone unturned: alphaTab renders in "partials" and exposes `renderLazyPartial`,
> so there may be a lazy off-screen path the three settings above do not reach. Worth
> an hour before committing to the engraver, not more.
>
> What an engraver has to beat is therefore 478ms, and what it has to reach is 100ms.
> The 20ms on four bars says the rest of the stack is not the problem.

The big one. Split it, because tablature and standard notation are different
problems wearing the same hat.

**R1. Tab staff.** Tractable, and enough for most of what CubScore's users read.
Strings as horizontal lines, fret numbers on them, rhythm stems and beams below,
bar lines, repeats, time signature, tempo and section marks. No accidentals, no
clefs, no key signatures, no note heads, no ledger lines. The hard parts are
horizontal spacing (a bar is as wide as its content needs, and systems justify to
the margin) and beam grouping. Both are well-documented problems with published
algorithms, and both are testable: a bar's width is a number, and a beam either
groups the beats the meter says or it does not.

Output as SVG, from our own layout pass, so `BarBox`-style geometry stops being
scraped out of someone else's bounds lookup and becomes the thing the layout
already computed. Everything currently positioned from `boundsLookup` gets more
accurate for free.

**R2. Standard notation.** Materially harder, and worth being blunt about: this is
where a from-scratch engraver usually goes wrong. It needs a SMuFL music font
(Bravura, SIL Open Font License, is the obvious choice), correct accidental
placement including courtesy accidentals, cross-staff beaming, collision avoidance
between slurs, dynamics, lyrics and note heads, and multi-voice rest positioning.
This is months, not weeks, and it is the one phase where shipping something worse
than alphaTab is a real risk.

So R2 waits, and while it waits alphaTab stays available as the renderer for
pitched staves. That is not a fudge: a guitar tab app whose tab rendering is ours
and whose piano-part rendering is borrowed is an honest intermediate state, and it
is shippable in a way "half an engraver" is not.

**Verification.** The gate already exists in shape. `tools/corpus-check.mjs`
renders every fixture and every corpus file through alphaTab and compares note
counts, pitches and bar counts. Extend it to render each score through *both*
engravers and compare: same number of systems, same bars per system, same beats
per bar, every note present at a position within a tolerance of where alphaTab put
it. Divergence is then a number rather than an opinion, and screenshot pairs go
into CI artifacts for the cases where it should be an opinion.

## 4. Phase P — our own playback

Less risky than R and more self-contained.

**P1. Scheduler.** `timeline()` already answers what sounds when, and `pnpm
timing` already proves it agrees with alphaTab's own playback to within a
millisecond across the whole corpus, including a nine-minute file with 13,745
notes and repeats. A Web Audio scheduler over that timeline is a well-trodden
pattern: keep a lookahead window, schedule note-ons and note-offs against
`AudioContext.currentTime`, and drive the cursor from the audio clock rather than
from `requestAnimationFrame` so it cannot drift from what you hear.

**P2. Sampler.** Parse SF2/SF3 (we already ship `sonivox.sf3`), or move to our own
sample set. An SF2 parser is a chunked binary format with generators and modulators
— tedious, documented, and finite. The synthesis itself is sample playback with
loop points, an ADSR envelope, and a low-pass filter per voice: an `AudioWorklet`
or, for a first cut, `AudioBufferSourceNode` per voice with a `BiquadFilterNode`.

**P3. Guitar-specific articulation.** The place a purpose-built engine beats a
general MIDI synth, and the reason to want one. Bends as pitch automation rather
than discrete semitones. Palm mute as a filter and shortened envelope. Dead notes
as a percussive click. Slides as a portamento. Let-ring as a suppressed note-off.
Harmonics as the right partial rather than a transposition. Every one of these is
currently approximated, and every one is audible.

**Verification.** `tools/audio-check.mjs` already measures peak, RMS, clipping and
audible-window share for every score. Extend it to compare our render against
alphaTab's on the same score: per-window RMS envelope correlation, so "it plays,
and it plays the same shape" is a number. Plus a null test that has caught this
class of bug before — a score whose notes are all removed must produce silence.

### A note for Phase P: one audio context, not two

`apps/web/src/listen/useListening.ts` opens its own `AudioContext` for the microphone
because alphaTab does not expose the one its synth uses. When playback becomes ours,
the input and the output should share a context. Two reasons, and the second is the
one that matters: a shared context means one sample rate and no resampling on the
input path, and it means the playhead and the microphone are clocked by the same
oscillator, so the timing figure in a practice report stops carrying the drift between
two independent clocks as noise.

## 5. Phase I and Phase X — files in and out

Covered in detail in [INTEROP.md](INTEROP.md), which is about interchange as a
product capability rather than only as a way to drop alphaTab. In dependency order
for this plan:

- **I1. MIDI in** and **X1. MIDI out**. Smallest and highest value. Export is
  nearly free from `timeline()`.
- **I2. MusicXML in/out**. The sheet-music interchange standard; opens up the
  MuseScore and Finale/Sibelius worlds.
- **I3. Guitar Pro in**. GP3/4/5 are documented binary formats. GP7/GPX is a zip
  of XML plus a binary blob. This is the last thing alphaTab is load-bearing for
  in the import path, and the one with the largest corpus of real files to test
  against — which is exactly why it goes last, when the harness is mature.
- **X2. ASCII tab out**. Trivial from our model, and the format the largest number
  of guitarists actually exchange.
- **X3. Print and PDF**. Falls out of R1: an SVG engraver is a print engraver.

## 6. What we keep alphaTab for

Not the app. The test suite.

Every phase above is a rewrite of something that already works, and the single
most valuable asset in a rewrite like that is a reference implementation to diff
against. `pnpm corpus` and `pnpm timing` already treat alphaTab as an oracle, and
the meter bug in §4's timeline was found precisely because alphaTab disagreed with
us and alphaTab was right.

So the end state is not "alphaTab removed". It is **alphaTab moved from
`dependencies` to `devDependencies`**: not shipped to users, not in the bundle, not
on the boot path, and still the thing every phase is graded against. That is a
better outcome than deleting it, and it costs nothing.

## 7. Licence and legal

Not legal advice; flagging for Joshua's review before any of this is quoted
externally.

**alphaTab is MPL-2.0.** Mozilla Public Licence 2.0 is file-level copyleft. Using
it as an unmodified library does not oblige us to publish our own source, which is
the common misreading. What it does oblige: if we modify alphaTab's own files, those
files must be made available under MPL-2.0. This matters because "fork alphaTab and
change the engraver" is an obvious shortcut for Phase R, and taking it converts a
private codebase decision into a public one. Writing our own engraver does not.

**The soundfont is separate.** `sonivox.sf3` carries its own terms, distinct from
alphaTab's, and it is shipped to every user. Confirm those terms before Phase P
either keeps it or replaces it — and note that replacing it with our own samples
removes the question permanently, which is a point in favour of doing so.

**Format specifications.** MIDI and MusicXML are open. Guitar Pro's formats are
not published by Arobas; the community reverse-engineered documentation is what
every open implementation uses, including alphaTab's. Reading a file format for
interoperability is well-established ground, but it is ground worth walking
knowingly.

## 8. Sequencing

Ordered by value per unit of risk, not by size.

1. **Timeline** — done. Unblocks everything else and is already gated by `pnpm
   timing`.
2. **X1, MIDI out** — days. Near-free from the timeline, immediately useful, and
   it proves the timeline against a second consumer.
3. **P1+P2, playback** — weeks. Drops the two 1.2MB worker bundles and gives us the
   transport.
4. **R1, tab engraver** — the big one, weeks to months. Deletes the alphaTex round
   trip, makes every overlay more accurate, and unblocks the views we cannot build.
5. **P3, guitar articulation** — weeks. The first thing here that is audibly
   *better* rather than merely ours.
6. **I1/I2/I3, importers** — weeks each, GP last.
7. **R2, standard notation** — months, and only when R1 is settled.

Every phase keeps the existing gate green — `pnpm build`, `pnpm test`, `pnpm
corpus`, `pnpm audio`, `pnpm timing`, `node e2e/run.mjs` — and adds the
alphaTab-versus-ours comparison for whatever it replaced. No phase ships behind a
flag that nobody turns on: each one becomes the default for the case it covers, or
it is not done.
