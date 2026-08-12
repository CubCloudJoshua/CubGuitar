# Interoperability: MIDI, sheet music, and every other kind of tab

What CubScore should be able to read, write, and talk to, and why each one earns
its place. Read [STANDALONE.md](STANDALONE.md) alongside this: several of these
formats are also how we stop renting a parser.

The organising principle is that **the semantic model is the hub**. Every format is
an importer that produces a `Score` or an exporter that consumes one — plus, where
the format carries time rather than notation, a consumer of `timeline()`. No format
talks to another format directly, and no importer is allowed to smuggle
presentation into the model. That is what keeps a matrix of formats from becoming a
matrix of converters.

Fidelity is reported, never assumed. `packages/formats` already returns an
`unsupported` list with every import, and the library UI shows it, because the one
thing worse than dropping a chord diagram is dropping it silently. Every format
below inherits that contract.

---

## 1. MIDI

Two different things share the name. Both are worth having and they are unrelated
pieces of work.

### 1.1 MIDI files, out — **shipped**

Standard MIDI File export, from `timeline()`. It is the cheapest capability on this
list: the timeline already holds every note with a start, a duration, a pitch and a
track, expanded through repeats, and `pnpm timing` already proves those numbers are
right to within a millisecond against real playback.

- Type 1 (one track per part), with a tempo map from the bar-by-bar tempo the
  timeline already computes, and a time-signature map from the meter.
- Channel per track; channel 10 reserved for percussion once percussion is in the
  model at all (see §5).
- Program numbers from `Instrument`. A `pitched` track already carries its
  `midiProgram`; a fretted track maps to a guitar program by tuning and range.
- Bends as pitch-bend events, not as separate notes. Palm mute and dead notes as
  velocity and shortened durations — an approximation, and it should be listed in
  the export report as one.

Why it matters commercially: a MIDI export is how a part someone wrote in CubScore
gets into their DAW, and "does it work with my DAW" is the first question a working
musician asks. It is also how a CubScore file becomes usable by someone who does
not have CubScore, which makes sharing a link less of a dead end.

**What building it taught.** Grading our file against alphaTab's, score by score,
found a bug the unit tests could not: ties were being written as a second note-on,
so a tied pair sounded as two notes instead of one held one — 1,616 extra note
events in a nine-minute file. Joining ties is now `mergeTies()` in core rather than
in the exporter, because the fretboard reader had the same bug (a second marker
arriving for a string already ringing) and the playback engine in Phase P will have
it too. That is the shape to look for: a correction that belongs to the model, not
to the format that exposed it.

### 1.2 MIDI files, in — **shipped**

Harder than out, and interesting because the hard part is musical rather than
technical. Parsing an SMF is an afternoon. Turning a stream of pitches into
*tablature* is the real problem: every pitch is playable in several places on the
neck, and choosing among them is a fingering decision.

Built as `packages/formats/src/from-midi-score.ts`: parsing is `from-midi.ts`,
notation is `core/quantise.ts`, and what lives in the join is the part neither can do —
deciding what the parts are.

- ~~Quantisation.~~ **Built**, and built for the transcription pipeline rather than for
  this, which is why it is in core: both callers hand it pitches with onsets and want a
  `Score`. Grid, tempo and meter are all callable inputs, and the grid defaults to being
  chosen from the material — a fixed 1/16 default reads a fast passage as chords, which
  `pnpm transcribe` caught. Adjustable in the sense that matters (the caller states what
  it knows); not yet exposed as a control in the import UI.
- ~~Pitch to (string, fret).~~ **Built**: `packages/core/src/fingering.ts`. A
  shortest path over hand position rather than a lookup — movement, stretch and open
  strings, with the weights stated and adjustable. It replaced the naive
  lowest-playable-fret rule that was inline in the fretboard reader, which is the
  rule that sends a hand from fret 12 to fret 2 and back between consecutive notes.
  Four things share it: the reader, MIDI import, MusicXML import, and arranging a
  keyboard or vocal line for guitar.
- ~~Track splitting.~~ **Built.** By track *and* channel, which is right under all
  three conventions in the wild: a notation program's one track per staff, a DAW's
  several channels on one track, and a format-0 file where everything is on track 0 and
  the channel is the only separator. Instrument comes from the program number — guitar
  and bass programs become fretted tracks, channel 10 becomes drums by specification,
  and everything else stays `pitched` with its program intact rather than being guessed
  onto a neck nobody asked for.

Two conventions our own writer never produces are covered by hand-built files in the
tests, because a round trip can only ever exercise our own habits: a format-0 file, and
a division other than the 960 we work in. Both survived mutation testing until those
files existed.

This is also the first genuinely AI-shaped problem in the product: optimal
fingering is exactly the kind of thing a model can be trained or prompted to do
better than a hand-written cost function, and it is testable — a fingering either
requires a hand stretch a human has or it does not.

### 1.3 MIDI devices — Web MIDI

A different capability with the same name, and an underrated one.

- **Note entry from an instrument.** A MIDI keyboard, or a guitar with a
  hexaphonic pickup or a MIDI-capable instrument, entering notes directly. A
  hexaphonic pickup reports which *string* a note came from, which means the
  fingering problem of §1.2 disappears entirely for that input path — the
  instrument already told us.
- **Foot controllers.** Perform mode already turns pages on PageUp and PageDown
  specifically so a foot pedal that sends keystrokes works. A pedal that sends MIDI
  instead is the same feature over a different transport, and it is what people
  actually own.
- **Clock and transport sync.** Following MIDI clock, or MTC, so CubScore's
  playhead runs with a DAW or a drum machine. This is what makes CubScore usable
  in a rehearsal room rather than only at a desk.
- **CubScore as an instrument.** Sending our playback out as MIDI, so the sound
  comes from the user's own instruments rather than our soundfont.

Web MIDI is supported in Chromium browsers and needs a user permission prompt;
Safari does not support it, so every one of these is an enhancement rather than a
requirement. Worth stating plainly in any external material rather than discovering
it in a demo.

---

## 2. Sheet music: MusicXML — **shipped, both directions**

Built as `packages/formats/src/to-musicxml.ts`, `from-musicxml.ts` and a small owned
XML parser (`xml.ts`) so both halves run in Node and in a browser without a dependency
in the middle of the path STANDALONE.md depends on. Import goes through our reader
rather than being handed to alphaTab, which is what makes a report of what was dropped
possible at all.

`pnpm musicxml` hands our file to alphaTab's own MusicXML reader and grades three
things: whether a stranger reads what we meant, whether the two readers disagree and
where, and how many notes came back still carrying a string and a fret. 12 of 12 scores
agree, with 11,029 and 5,721 fingered notes intact on the two real files.

What is not carried, and says so: `.mxl` (a zip, still alphaTab's), timewise files (with
an instruction to re-export), grace notes, unpitched percussion, slurs, dynamics,
lyrics, chord symbols, alternate endings, and multi-staff parts (both staves are read
into one). Bend depth is written as a whole step because the model holds no amount, and
the report says so.

The notes below are the design as planned. They held up, with one correction: alphaTab
derives a note's pitch from `<string>` and `<fret>` on a tab staff rather than from
`<pitch>`, so the fingering is authoritative on the way out and has to be right.



The interchange format for notation. MuseScore, Finale, Sibelius, Dorico and
Notion all read and write it, which makes it the single format that connects
CubScore to the notation world rather than only to the tab world.

**Import.** `score-partwise` is the common flavour. What maps cleanly: parts to
tracks, measures to bars, notes with `<pitch>`, durations via `<divisions>`, time
and key signatures, tempo from `<sound tempo>`, repeats and endings from
`<barline>`. What needs care:

- MusicXML carries tablature natively — `<staff-details>` with `<staff-tuning>`,
  and `<technical><string>`/`<fret>` on a note. So a guitar part exported from
  MuseScore arrives with its fingering intact and needs no inference. This is the
  best-case import path we have, better than MIDI and better than a scan.
- Divisions are per-part and can change, and durations are integers in divisions.
  Our model is rational, which is strictly better, so the conversion is exact in
  the direction that matters.
- Voices and chords: `<chord>` means "sounds with the previous note", which is our
  `Beat.notes`. Multiple `<voice>` elements are our `Bar.voices`.
- Compressed `.mxl` is a zip with a container manifest. Support both.

**Export.** The same mapping in reverse, and it is how a CubScore part gets to an
arranger, a copyist, or a school music department. Emit tablature elements as well
as pitches so the receiving program can show either.

**Why it matters.** This is the format that makes CubScore credible to the academic
and worship markets, which are two of the audiences most likely to need a whole
ensemble's parts rather than one guitar part. It is also the practical route to
"import the sheet music I already have".

---

## 3. Guitar Pro

The format our users' existing libraries are actually in, and the reason import
matters at all. We read these today through alphaTab.

- **GP3, GP4, GP5.** Documented binary formats: a version string, then
  length-prefixed strings, a lyrics block, a MIDI channel table, then measure and
  track headers, then beats. Community documentation is complete enough that
  several independent implementations exist. The fiddly parts are the bit-flag
  layouts that differ between versions and the GP5 bend-point encoding.
- **GP7, GP (GPX).** A zip containing `score.gpif`, which is XML. Considerably
  more pleasant than the binary formats. GPX (Guitar Pro 6) uses a custom
  compressed container around the same idea.
- **Export.** We write GP7 today via alphaTab's exporter. Writing `score.gpif`
  ourselves is a manageable piece of work and worth having, because a file someone
  can open in Guitar Pro is a file they can share with a bandmate who has not
  switched.

Our existing corpus harness is already the right test rig: it loads every real
`.gp*` file in `corpus/`, converts, re-serialises, reloads, and compares note
counts, pitches and bar counts exactly. A second parser is graded against the same
bar.

---

## 4. Other tablature, and there is a lot of it

### 4.1 ASCII tab

The format the largest number of guitarists exchange, and the one every other
program treats as beneath it.

**Shipped, both directions.** Export writes the clipboard as well as a file,
because pasting is the point; import accepts a `.txt` off a forum. Spacing is
proportional to duration, since spacing is the only rhythm information the format
can carry, and a tab where a held note looks the same as a fast one is one you have
to already know to play from.

**Export is nearly free and immediately useful** — six lines of dashes and fret
numbers, which is what people paste into a forum, a text message, or a band's group
chat. It should be a first-class export, not an afterthought, and it should be
copyable to the clipboard rather than only downloadable.

**Import is fuzzy and worth doing anyway.** The web's largest tab corpus is ASCII,
and it is unstructured: tunings are stated in prose or not at all, rhythm is
usually absent, bar lines are inconsistent, and the same file mixes tab with chord
names and lyrics. A parser can recover strings, frets and order reliably; it cannot
recover rhythm, and it must not pretend to. The honest design is an import that
produces correct pitches with an even rhythm and says so in the unsupported report,
leaving the user to fix the rhythm — which is far less work than typing the notes.

This is the second obviously AI-shaped problem: inferring plausible rhythm from
unrhythmed tab plus the song it claims to be.

### 4.2 Programs with their own formats

- **PowerTab (`.ptb`)** — a large legacy corpus, format reverse-engineered.
- **TuxGuitar (`.tg`)** — open source, so the format is readable from its source.
- **MuseScore (`.mscz`)** — a zip of XML; MusicXML is the better path in and out,
  but reading `.mscz` directly avoids an export step for the user.
- **Songsterr, Ultimate Guitar** — web catalogues rather than file formats.
  Anything here is a licensing and terms question long before it is an engineering
  one, and it is not a place to move without Joshua clearing it.

### 4.3 Instruments that are not six-string guitar

Mostly free, because `Instrument.tuning` is already a list of MIDI pitches of any
length. Bass (4, 5, 6), 7- and 8-string guitar, ukulele, mandolin, banjo (including
the fifth string starting at the fifth fret, which is the one genuine special
case), lap steel, and any alternate tuning are already representable and already
work. What is missing is presets and naming, not model support.

### 4.4 Notations that are not tablature

- **Drum tab and percussion notation.** ~~The real gap.~~ Done. Drum tracks come in
  as General MIDI drum voices, engrave as notation, play, and export to MIDI on
  channel 10; a drum-only file is editable like any other. The mapping from drum
  number to voice name is `packages/core/src/percussion.ts`, measured row by row
  against alphaTab's own parser rather than transcribed from a specification. What is
  *not* here is drum tab — the numbers-on-lines layout — and per-voice notation heads
  beyond what alphaTab's default kit draws; both belong to Phase R, where the heads
  are ours to choose.
- **Chord charts and Nashville numbers.** Chord symbols over bars, no staff. The
  model needs a chord entity, which it does not have — chord diagrams are in the
  unsupported list. Worth having for worship and session players, who read charts
  far more often than they read tab.
- **Harmonica tab, diatonic accordion tab** — numbers with blow/draw markers. A
  small instrument-kind addition.
- **Lute and vihuela tablature** — historical, letters rather than numbers, French
  and Italian conventions differ in which line is the top string. Niche, cheap once
  the engraver is ours, and exactly the kind of thing a university music department
  asks for.

---

## 5. What the model needs first

Several formats above are blocked on the same three gaps, and they are worth fixing
before the importers rather than during them.

1. **Percussion.** ~~No instrument kind, so drum tracks are dropped.~~ ~~Half done.~~
   Done. Model, notation and MIDI. The half that was missing was notation, and the
   conclusion drawn from the earlier measurement was wrong in an instructive way: the
   fix was not for our tex to declare its own articulation list. alphaTex takes the
   articulation *by name*, `\articulation defaults` puts every name of alphaTab's kit
   in scope, and the index that appears in the parsed model is assigned by alphaTab in
   order of first use — which is exactly why a number written by hand landed on the
   wrong voice and why five of 47 appeared to sound. `packages/core/src/percussion.ts`
   holds the 51 measured rows, `packages/formats/src/percussion.test.ts` re-measures
   them against the real parser so the table cannot drift from the renderer, and
   percussion is now inside the round-trip pitch comparison `pnpm corpus` makes. One
   thing is genuinely unwritable: a hit whose articulation matches no General MIDI
   drum, which alphaTab has no sound for either. Those are reported per voice number
   rather than approximated to a neighbouring drum.
2. **Chords.** ~~No chord entity, so chord diagrams and chord symbols are
   dropped.~~ Done. `Beat.chord` carries the symbol as typed ("Am7", "C/G"),
   parsed on demand by `core/harmony`; it survives alphaTex (as `ch`), MusicXML
   (as `<harmony>`, both directions), and ASCII tab (a chord row over the staff).
   Chord *diagrams* — fingering pictures — are still reported as dropped;
   the symbol is the entity, the picture is a rendering.
3. **Lyrics and text.** ~~No beat text, no lyric line, no section names.~~ Done.
   `Beat.lyric` and `Bar.section` are ops like everything else, and they ride
   alphaTex (`lyrics`, `\section`), MusicXML (`<lyric>`, rehearsal marks), and
   ASCII export. `fixtures/11-songwriting.altex` holds all three layers through
   every oracle.

Each is a model addition, which means an op-log addition, which means inverse ops
and convergence tests — the discipline is established and the cost is predictable.

## 6. Order of work

Value per unit of risk, same as STANDALONE.md.

1. ~~**MIDI file export.**~~ Shipped. Free from `timeline()` as predicted, and it
   proved the timeline against a second consumer — which is how the tie bug
   surfaced.
2. ~~**ASCII tab export.**~~ Shipped, and import with it. The importer earned its
   keep on the messy cases: lyrics and chord names around the staff, a missing
   string line, ragged bar lines, the tuning stated in prose. Rhythm is reported as
   not carried on every import, always.
3. ~~**MusicXML import.**~~ Shipped, with export beside it. It did carry tablature
   natively as predicted, and the fingering survives a round trip through an
   independent reader, which is the claim most exporters cannot make.
4. ~~**MusicXML export.**~~ Shipped.
5. **Percussion in the model.** Weeks. Unblocks four separate things and closes the
   gap our own import reports name most often. Now the largest remaining hole: MusicXML
   writes a drum part as pitched notes and reports it, which is honest and not right.
6. ~~**MIDI file import**.~~ Shipped. The fingering half was already done; quantisation
   landed with the transcription pipeline (`packages/core/src/quantise.ts`), which takes
   the same input a MIDI file gives us — pitches with onsets — and returns a `Score`.
   Tempo and meter *maps* landed with it, so a file's own bar structure is honoured
   rather than its first signature repeated. Track splitting is by track *and* channel,
   which is right for a notation program's one-track-per-staff, a DAW's several
   channels on a track, and format 0's everything-on-track-0. Graded by
   `from-midi-score.test.ts` through our own writer, plus hand-built files for the two
   conventions our writer never produces: a format-0 file, and a division other than
   ours. What remains is the long tail — reconstructing bends from pitch-bend events,
   and drum notation, which is the same gap named in item 1.
7. **Web MIDI**: pedals, then note entry, then clock sync. Days each, and the
   hexaphonic-pickup path is a genuinely differentiated demo.
8. **Guitar Pro import**, ours rather than alphaTab's. Weeks, deliberately last:
   it is the one with the largest real corpus to be graded against, and the harness
   should be mature before it is attempted.
9. ~~**Chords and lyrics in the model.**~~ Shipped, out of order, because the
   songwriting editor needed them: chords, lyrics and sections are ops, round-trip
   alphaTex and MusicXML through independent readers, and render in the ASCII
   export. The long tail remains: PowerTab, TuxGuitar, drum tab, chord charts as
   an *import* (the model can hold them now), historical tablature.

Every importer ships with fixtures in `fixtures/`, a round-trip entry in `pnpm
corpus`, and an honest `unsupported` report. Every exporter ships with a re-import
check: what we write, we must be able to read back to the same model. That is the
only definition of "supports the format" worth making a claim about.
