# What nobody else is offering

The filter for this list is not "what would be nice". It is **what is possible for
CubScore specifically, because of something we already own** — and would be
expensive or architecturally awkward for Guitar Pro, Songsterr, Ultimate Guitar,
Soundslice, MuseScore or Flat to copy.

Four things we own that the category does not:

1. **An operation log with inverse operations and server-ordered convergence.**
   Every edit is a serialisable op; undo is the inverse of an op, not a snapshot;
   two people editing one bar converge. Nobody in tablature software has this.
   Desktop products are file-based; the web players are read-only.
2. **A semantic model with rendering separated from it.** `timeline()` answers what
   sounds when, in seconds and in ticks, with no DOM. The fretboard reader proved
   that separation by drawing something alphaTab cannot.
3. **A fingering solver.** `fingerSequence` chooses hand positions across a phrase
   by cost, not by lookup. No competitor exposes this as a product surface at all.
4. **Sovereign GPU capacity in Missoula.** H200, H100, RTX PRO 6000. This is the
   one item on the list a software competitor cannot buy their way around, because
   their inference cost per song is somebody else's cloud margin and ours is not.

What follows is ordered by **differentiation per unit of work**, not by ambition.

---

## 1. Shared transport: collaborative *rehearsal*, not collaborative editing — **shipped**

**Nobody has this.** Collaboration in music software means editing a document
together. Nobody locks a band's playheads together.

A rehearsal room has one chart and five people reading it. Today each of them
scrolls their own copy. With a shared transport the leader's playhead is everyone's
playhead: one person presses play, five screens follow the same bar, and stopping
stops everyone. Add per-person track focus and the bassist sees the bass staff while
the guitarist sees the guitar staff — same session, same bar, different view.

**Why it is cheap for us and not for them.** We already have the sync server, the
room model, presence, and — since this week — every member's caret position
retained and handed to joiners. A shared transport is one more message type on a
socket that already carries ops and cursors, plus a "follow the leader" flag. The
work is days, not weeks. For a file-based desktop product it is a new networking
stack.

**Why it matters commercially.** It turns a single-user tool into something a band
buys five seats of, and it is the feature a worship team or a school ensemble
recognises instantly in a demo. It also makes Perform mode — already built, already
foot-pedal driven — the mode a group uses rather than a soloist.

**What it took.** A `transport` message on the sync server (relayed, never
retained — a joiner replaying a stored transport action would be dragged to wherever
the room was when they arrived), an absolute `seekTo` on the player, and one hook
owning follow state, the loop guard and drift correction.

The latency question resolved smaller than expected, because the requirement is
that five people read the same bar rather than that five speakers are phase-aligned.
Actions carry an absolute position rather than a delta, so a dropped message costs
one action instead of desynchronising the room permanently; the driver restates its
position every two seconds and a follower corrects only past a third of a second of
drift. Correcting continuously would make every follower's playhead stutter;
correcting never would let them walk apart over a four-minute song.

The loop guard is the part that is easy to miss: applying a remote action calls the
same player methods a user does, and the player cannot tell them apart — so without
a flag, a follower's play is rebroadcast as its own action, the driver follows that,
and the room rings.

---

## 2. Audio to tablature, on our own GPUs

**The category's holy grail, and the clearest use of the infrastructure pillar.**
Upload a recording, get a transcription with playable fingering.

The pipeline is four stages and we already own the last two:

| Stage | What it needs | Status |
| --- | --- | --- |
| Separate the guitar from the mix | Source separation (Demucs-class) | Off the shelf, GPU-bound |
| Pitches and onsets from audio | Multi-pitch estimation (basic-pitch / MT3-class) | Off the shelf, GPU-bound |
| Pitches to a rhythm | Quantisation against a tempo — `timeline()` in reverse | **Ours** |
| Pitches to a fretboard | `fingerSequence` | **Ours, built** |

**Why nobody offers it well.** The first two stages cost real GPU time per song. On
rented cloud that is a per-transcription cost a subscription has to cover, which is
why the products that attempt it either charge per song, cap it hard, or produce
MIDI and stop — leaving the user with pitches and no idea where to put their hands.
The fingering stage is the one that turns a transcription into a *tab*, and it is
the stage everyone skips.

We own the GPUs. That changes the unit economics rather than the technology.

**Honest scoping.** Polyphonic guitar transcription is not solved. What is
achievable today is good single-line and moderately good chordal transcription with
a human cleaning it up — which is still transformative next to transcribing by ear,
and the cleanup happens in an editor we already have. Anything claimed beyond that
should be measured before it is said, and there is a natural gate for it: transcribe
a recording of a score we already have and compare against the original. That is the
same oracle discipline as `pnpm midi`.

**Sequencing note.** Do §1 first. This one is a research-shaped project; that one is
a week.

---

## 3. Practice as a stored object

Every competitor treats a practice session as ephemeral. We store an op log
already; storing a **performance log** is the same idea applied to playing rather
than editing.

What it gives, none of which anyone offers:

- A heatmap over the score of where you actually fail, built from your own
  play-throughs rather than from a guess.
- Practice sets generated from your own failures, spaced by when you last got a bar
  right. Spaced repetition exists for vocabulary and not for bars of music.
- A progress record a teacher can read: "this student has played bar 34 clean twice
  in six weeks" is a different conversation from "I practised".
- The tempo you can actually play a passage at, tracked over time, which is the
  number every guitarist cares about and nobody records.

**What it depends on.** Knowing what you played, which is §4. But the *storage and
analysis* half can be built against manual input first ("I got this wrong"), and
that alone is more than the category offers.

---

## 4. Listening: what you played against what is written

Rocksmith does this with a proprietary cable. Yousician does it with a microphone
and only on their own closed catalogue. **Nobody does it against your own tabs.**

We have the expected side already: `timeline()` says which note should sound at
which second. The missing half is a detector — onset and pitch from the microphone,
in the browser, in real time. That is a small on-device model plus Web Audio, not a
GPU problem, which makes it independent of §2.

The output is the interesting part. Not a score out of ten, which is what the
game-shaped products give: a list of the bars you missed and *how* — early, late,
wrong string, right note wrong fret. The fingering solver knows which positions were
plausible, so "you played that at the fifth fret and the tab says the twelfth" is a
statement we can make and they cannot.

---

## 5. Arrangement as an operation, with undo

Because arranging is a transformation of the semantic model, and every
transformation of the model is already an op batch, these are all *undoable* and
*collaborative* for free:

- **Arrange this for guitar.** A piano or vocal part becomes playable tablature.
  `fingerSequence` already does the hard part; the fretboard reader already
  demonstrates it on screen. The remaining work is a `track.setInstrument` op and a
  batch of fingering ops.
- **Find me a capo position.** Transpose and re-finger so the shapes are easier,
  reporting what it cost. A guitarist's actual question, and nobody answers it.
- **Simplify this.** Reduce a part to something a beginner can play, keeping the
  harmony. The obvious use in a teaching deployment.
- **Voice this for two guitars.** Split a dense part into two playable ones.

No competitor offers arranging as an in-editor operation, and the reason is
structural: without an op log, an arrangement is a destructive edit you cannot take
back, so nobody ships it as a button.

---

## 6. The instruments nobody serves

`Instrument.tuning` is already a list of pitches of any length, so this is
configuration rather than engineering: 7- and 8-string guitar, bass in four to six,
ukulele, mandolin, banjo (the fifth string starting at the fifth fret is the one
genuine special case), lap steel, oud, and any alternate tuning already work.

What is missing is presets, names, and the fretboard reader knowing what it is
drawing. This is not "nobody could" — it is "nobody bothers", which is a different
and easier kind of gap. A mandolin player has no good software and is not a small
population.

---

## 7. The one that is not a feature

**Where the data lives.** A school district, a university music department, or a
tribal education programme evaluating software asks where student work is stored and
under whose jurisdiction. "Missoula, Montana, on hardware we own" is an answer no
competitor running on somebody else's cloud can give, and it is a procurement
argument rather than a product one.

This costs no engineering. It costs saying it accurately, which means the sovereign
claim has to stay true as the product grows — worth deciding deliberately before the
first deployment rather than after.

---

## Recommendation

**Build §1 next.** Shared transport is days of work on infrastructure that is
already built and already tested, it is genuinely unavailable anywhere else, and it
demos in ten seconds to exactly the audiences that buy multiple seats.

**Then §5's first item**, arranging a pitched part for guitar. The solver exists and
the reader already shows the result; what is missing is one op and a command. It
turns a capability into a feature.

**Then §4**, because §3 depends on it and because it is the piece that makes practice
measurable.

**§2 is the flagship and should be scoped as research**, not as a sprint. It is the
right thing to be pointing at and the wrong thing to promise a date for.

Anything in this document that would go in front of a customer, a partner or a grant
application needs Joshua's review first — particularly the sovereignty claim in §7
and any statement about transcription accuracy in §2.
