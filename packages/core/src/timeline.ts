/**
 * When each note sounds, in seconds.
 *
 * This is the piece that turns a document into a performance. Until now the
 * answer lived inside alphaTab: it parsed the score, expanded the repeats,
 * applied the tempo, and reported a playback position, and everything on screen
 * that needed to know "what is sounding now" asked it. That made every view a
 * view of alphaTab's model rather than of ours, so nothing could be drawn that
 * alphaTab did not already draw.
 *
 * A timeline is the seam. Given a Score it answers, without rendering anything
 * and without a DOM, which note is at which second on which string — which is
 * what a fretboard view needs, what a synth needs to schedule, and what a MIDI
 * export needs to write. See STANDALONE.md for how far that goes.
 *
 * Ticks come from the same clock the alphaTex bridge uses (960 per quarter), so
 * a timeline built here lines up with alphaTab's own playback position while the
 * two coexist.
 */
import { beatTicks } from "./alphatex.js";
import { DEFAULT_TIME_SIGNATURE } from "./build.js";
import type { Articulation, Bar, Id, Score, Track } from "./score.js";

/**
 * Ticks per quarter note. Exported because a consumer writing a file format has
 * to state its own division, and stating ours means no conversion at all.
 */
export const QUARTER_TICKS = 960;
/** What a score means by "no tempo stated". Matches alphaTab's default. */
export const DEFAULT_TEMPO_BPM = 120;

export interface TimedNote {
  /** The note's own id, so a view can key off it and a click can find it. */
  id: Id;
  trackIndex: number;
  /** Bar index in the *written* score, not the played order. */
  bar: number;
  /** 1-based, string 1 is the highest. Absent on a staff without strings. */
  string?: number;
  fret?: number;
  pitch: number;
  startSeconds: number;
  durationSeconds: number;
  /**
   * The same position in ticks, at QUARTER_TICKS per quarter note.
   *
   * Both, because the two consumers want different things and converting between
   * them is lossy in one direction. A view following playback wants seconds — it
   * has a clock in seconds and no interest in tempo. A file format wants ticks:
   * MIDI, MusicXML and Guitar Pro all store integer divisions against a tempo
   * map, and deriving those back from seconds would reintroduce, as rounding
   * error, exactly the tempo information the format is about to state anyway.
   */
  startTicks: number;
  durationTicks: number;
  /** Set when the note is tied into by the next one, which sustains it. */
  tiedToNext?: boolean;
  /** Carried through so an exporter can act on accents, mutes and bends. */
  articulations: readonly Articulation[];
}

export interface Timeline {
  notes: TimedNote[];
  /** Total sounding length, including the last note's tail. */
  durationSeconds: number;
  durationTicks: number;
  /** Bar boundaries in played order, for a cursor that has to name a bar. */
  bars: Array<{
    bar: number;
    startSeconds: number;
    endSeconds: number;
    startTicks: number;
    endTicks: number;
  }>;
  /**
   * Tempo and meter as they occur in *played* order, which is what a conductor
   * track is. A repeated section states its tempo again on the second pass,
   * because a file format reader walking the track forward has no other way to
   * know the tempo went back.
   *
   * Only entries that change anything are emitted, so a score with one tempo has
   * one entry rather than one per bar.
   */
  tempoChanges: Array<{ tick: number; bpm: number }>;
  meterChanges: Array<{ tick: number; beats: number; beatValue: number }>;
  ticksPerQuarter: number;
}

/**
 * The order bars are actually played in, expanding repeats.
 *
 * A repeat section runs from the last `repeat.start` to the bar carrying
 * `repeat.endCount`, and `endCount` is the number of *passes*, which is how both
 * Guitar Pro and alphaTab read it — so `endCount: 2` plays the section twice, not
 * three times. A closing repeat with no opening one repeats from the top, which
 * is what the notation means and what a file written by hand usually intends.
 */
export function playOrder(bars: readonly Bar[]): number[] {
  const order: number[] = [];
  let sectionStart = 0;
  // Passes already played of the section ending at each bar, so a section is not
  // re-entered forever. Keyed by bar index; a second visit to the same closing
  // bar in a *different* section cannot happen, since sections do not overlap.
  const passes = new Map<number, number>();
  let i = 0;
  // A guard rather than a trust: a malformed set of repeat marks (a closing bar
  // before its opening one) could otherwise loop until the tab dies.
  const limit = bars.length * 64 + 1024;
  while (i < bars.length && order.length < limit) {
    const bar = bars[i];
    if (!bar) break;
    if (bar.repeat?.start) sectionStart = i;
    order.push(i);
    const count = bar.repeat?.endCount ?? 0;
    if (count > 1) {
      const done = (passes.get(i) ?? 1) + 1;
      if (done <= count) {
        passes.set(i, done);
        i = sectionStart;
        continue;
      }
    }
    i += 1;
  }
  return order;
}

/**
 * Tempo in force at each bar of a track, carried forward.
 *
 * Tempo is written only where it changes (score.ts), so a bar with no mark plays
 * at whatever the last mark said. Read from the first track that states one,
 * because alphaTab applies a tempo globally rather than per staff and a score
 * whose piano part carries the tempo would otherwise play the guitar at 120.
 */
function tempoByBar(score: Score): number[] {
  const barCount = Math.max(0, ...score.tracks.map((t) => t.bars.length));
  const out: number[] = [];
  let current = DEFAULT_TEMPO_BPM;
  for (let b = 0; b < barCount; b += 1) {
    for (const track of score.tracks) {
      const stated = track.bars[b]?.tempoBpm;
      if (stated !== undefined && stated > 0) {
        current = stated;
        break;
      }
    }
    out.push(current);
  }
  return out;
}

/**
 * Meter in force at each bar, carried forward like tempo.
 *
 * Read across tracks because a time signature belongs to the master bar: every
 * staff is in the same meter at the same moment, and a score whose piano part
 * states 7/8 while the guitar part states nothing is one score in 7/8.
 */
function meterByBar(score: Score): Array<{ beats: number; beatValue: number }> {
  const barCount = Math.max(0, ...score.tracks.map((t) => t.bars.length));
  const out: Array<{ beats: number; beatValue: number }> = [];
  let current = { ...DEFAULT_TIME_SIGNATURE };
  for (let b = 0; b < barCount; b += 1) {
    for (const track of score.tracks) {
      const stated = track.bars[b]?.timeSignature;
      if (stated) {
        current = { beats: stated.beats, beatValue: stated.beatValue };
        break;
      }
    }
    out.push(current);
  }
  return out;
}

/** Ticks the longest voice in a bar occupies; voices sound together. */
function writtenTicks(bar: Bar | undefined): number {
  if (!bar) return 0;
  let longest = 0;
  for (const voice of bar.voices) {
    let ticks = 0;
    for (const beat of voice.beats) ticks += beatTicks(beat);
    if (ticks > longest) longest = ticks;
  }
  return longest;
}

/**
 * How long a bar lasts.
 *
 * The meter, not the sum of the beats written in it. A bar in 4/4 holding a
 * single quarter note is still a bar of 4/4 — the rest of it is silence nobody
 * bothered to write down — and playback advances by the full bar. Taking the
 * written beats instead made a score with one short bar run 2.8 seconds ahead of
 * what alphaTab plays, which is how `pnpm timing` found this.
 *
 * An *overfull* bar keeps its extra length rather than being clipped, because
 * dropping the overflow would silence notes the document contains.
 */
function barTicks(bar: Bar | undefined, meter: { beats: number; beatValue: number }): number {
  const written = writtenTicks(bar);
  if (!bar) return 0;
  const implied = Math.round((QUARTER_TICKS * 4 * meter.beats) / meter.beatValue);
  return Math.max(written, implied);
}

/**
 * Every note in the score, placed in seconds.
 *
 * Bars are laid out in played order so repeats produce a note per pass, which is
 * what a reader following along needs: the second time through a chorus is a
 * different moment, not the same one again.
 */
export function timeline(score: Score): Timeline {
  const tempos = tempoByBar(score);
  const meters = meterByBar(score);
  // Every track plays the same bar sequence — repeats are a property of the
  // master bar, so a score whose tracks disagreed about them would not be
  // playable. The longest track decides how many bars there are.
  const spine = score.tracks.reduce<readonly Bar[]>(
    (longest, t) => (t.bars.length > longest.length ? t.bars : longest),
    [],
  );
  const order = playOrder(spine);

  const notes: TimedNote[] = [];
  const bars: Timeline["bars"] = [];
  const tempoChanges: Timeline["tempoChanges"] = [];
  const meterChanges: Timeline["meterChanges"] = [];
  let seconds = 0;
  let ticks = 0;

  for (const barIndex of order) {
    const bpm = tempos[barIndex] ?? DEFAULT_TEMPO_BPM;
    const secondsPerTick = 60 / bpm / QUARTER_TICKS;
    const start = seconds;
    const startTicks = ticks;
    const meter = meters[barIndex] ?? DEFAULT_TIME_SIGNATURE;
    if (tempoChanges.at(-1)?.bpm !== bpm) tempoChanges.push({ tick: startTicks, bpm });
    const lastMeter = meterChanges.at(-1);
    if (lastMeter?.beats !== meter.beats || lastMeter?.beatValue !== meter.beatValue) {
      meterChanges.push({ tick: startTicks, beats: meter.beats, beatValue: meter.beatValue });
    }

    for (const [trackIndex, track] of score.tracks.entries()) {
      const bar = track.bars[barIndex];
      if (!bar) continue;
      for (const voice of bar.voices) {
        let tick = 0;
        for (const beat of voice.beats) {
          const length = beatTicks(beat);
          for (const note of beat.notes) {
            notes.push({
              id: note.id,
              trackIndex,
              bar: barIndex,
              ...(note.string === undefined ? {} : { string: note.string }),
              ...(note.fret === undefined ? {} : { fret: note.fret }),
              pitch: note.pitch,
              startSeconds: start + tick * secondsPerTick,
              durationSeconds: length * secondsPerTick,
              startTicks: startTicks + tick,
              durationTicks: length,
              ...(note.tiedToNext ? { tiedToNext: true } : {}),
              articulations: note.articulations,
            });
          }
          tick += length;
        }
      }
    }

    const spineTicks = Math.max(
      0,
      ...score.tracks.map((t) => barTicks(t.bars[barIndex], meter)),
    );
    seconds = start + spineTicks * secondsPerTick;
    ticks = startTicks + spineTicks;
    bars.push({ bar: barIndex, startSeconds: start, endSeconds: seconds, startTicks, endTicks: ticks });
  }

  return {
    notes,
    // The tail matters: a whole note in the last bar sounds past the bar's
    // written end only if the bar is short, and a reader that stopped at the
    // last bar line would cut it off.
    durationSeconds: Math.max(seconds, ...notes.map((n) => n.startSeconds + n.durationSeconds), 0),
    durationTicks: Math.max(ticks, ...notes.map((n) => n.startTicks + n.durationTicks), 0),
    bars,
    tempoChanges,
    meterChanges,
    ticksPerQuarter: QUARTER_TICKS,
  };
}

/**
 * Tied notes joined into the single note they sound as.
 *
 * A tie means "do not play this again, hold the last one". The timeline reports
 * what is *written* — two notes, because the document contains two — and anything
 * that turns the timeline into sound or into a picture of sound has to join them,
 * or you hear two notes where a player would hear one and see a second marker
 * arrive for a note already ringing.
 *
 * Three consumers need this and none of them should own it: the MIDI writer (where
 * a re-articulated tie is audibly wrong and was measured against alphaTab as 1,616
 * extra note-ons in one file), the fretboard reader, and the playback engine in
 * STANDALONE.md's Phase P.
 *
 * Matched on pitch rather than on string, because that is what a tie means
 * musically and what every consumer of this cares about. A continuation must also
 * start where the tied note ended: two separate notes of the same pitch later in
 * the bar are two notes, not one long one.
 */
export function mergeTies(notes: readonly TimedNote[]): TimedNote[] {
  const byVoice = new Map<string, TimedNote[]>();
  for (const note of notes) {
    const key = `${note.trackIndex}:${note.pitch}`;
    const list = byVoice.get(key) ?? [];
    list.push(note);
    byVoice.set(key, list);
  }

  /** Notes absorbed into an earlier one, by identity. */
  const absorbed = new Set<TimedNote>();
  /** Extra length an earlier note gained, by identity. */
  const extended = new Map<TimedNote, number>();

  for (const list of byVoice.values()) {
    list.sort((a, b) => a.startTicks - b.startTicks);
    for (let i = 0; i < list.length; i += 1) {
      const head = list[i]!;
      if (!head.tiedToNext || absorbed.has(head)) continue;
      // Walk the chain: a tie can run through several notes.
      let end = head.startTicks + head.durationTicks;
      let total = head.durationTicks;
      for (let j = i + 1; j < list.length; j += 1) {
        const next = list[j]!;
        if (absorbed.has(next)) continue;
        // A tick of slack: durations are rounded to integer ticks, so a
        // continuation can land a tick either side of where the tie ended.
        if (Math.abs(next.startTicks - end) > 1) break;
        absorbed.add(next);
        total += next.durationTicks;
        end = next.startTicks + next.durationTicks;
        if (!next.tiedToNext) break;
      }
      if (total !== head.durationTicks) extended.set(head, total);
    }
  }

  const out: TimedNote[] = [];
  for (const note of notes) {
    if (absorbed.has(note)) continue;
    const total = extended.get(note);
    if (total === undefined) {
      out.push(note);
      continue;
    }
    // Seconds have to grow with ticks, and the ratio is the note's own tempo —
    // which is exactly durationSeconds / durationTicks, whatever the tempo was.
    const secondsPerTick = note.durationTicks > 0 ? note.durationSeconds / note.durationTicks : 0;
    out.push({
      ...note,
      durationTicks: total,
      durationSeconds: total * secondsPerTick,
      // The join is complete: nothing after it is still waiting to be tied in.
      tiedToNext: false,
    });
  }
  return out;
}

/** Which played bar a moment falls in, or null past the end. */
export function barAtSeconds(line: Timeline, seconds: number): number | null {
  for (const span of line.bars) {
    if (seconds >= span.startSeconds && seconds < span.endSeconds) return span.bar;
  }
  return null;
}

/** Notes sounding, or about to sound, inside a window. For a reader's viewport. */
export function notesInWindow(line: Timeline, from: number, to: number): TimedNote[] {
  return line.notes.filter((n) => n.startSeconds + n.durationSeconds > from && n.startSeconds < to);
}

/** The tuning of a track, for a view that has to place a string. */
export function stringCount(track: Track | undefined): number {
  return track?.instrument.kind === "fretted" ? track.instrument.tuning.length : 6;
}
