/**
 * Drum voices, as the names alphaTex writes them.
 *
 * The model stores percussion as General MIDI drum numbers, which is the portable thing
 * to store: it is what channel 10 plays, what a MIDI file carries, and what every other
 * program agrees about. alphaTex does not take those numbers. A percussion staff takes an
 * *articulation name* in quotes, and the number that appears in the parsed model is an
 * index into a list alphaTab builds from the names the file actually used — assigned in
 * order of first appearance, which is why writing drum numbers directly produced a file
 * that rendered a full kit and played five sounds.
 *
 * So this is the bridge, and every row of it was measured rather than transcribed from a
 * specification. Each of alphaTab's 107 default articulation names was written into a
 * one-note percussion staff, parsed with alphaTab's own alphaTex importer, and the
 * resulting articulation's `outputMidiNumber` read back. The 51 numbers below are what
 * that produced; where several names sound the same number, the one kept is the one
 * alphaTab's primary kit lists first and the alternatives are named in a comment, because
 * the choice is arbitrary to the file and not to a reader.
 *
 * `packages/formats/src/percussion.test.ts` re-runs that measurement against the real
 * parser, so a table that drifts from the renderer fails a test rather than a song.
 */

/**
 * General MIDI drum number to the alphaTex name that sounds it.
 *
 * Covers 35 to 87, which is the whole General MIDI percussion range alphaTab's default
 * kit can express. Numbers outside it exist in MIDI files — a drum machine part can use
 * anything — and are handled by the caller rather than guessed at here.
 */
export const DRUM_VOICE_NAMES: ReadonlyMap<number, string> = new Map([
  [35, "Kick (hit)"],
  [36, "Kick (hit) 2"],
  [37, "Snare (side stick)"],  // also Metronome (hit), Snare (side stick) 3
  [38, "Snare (hit)"],  // also Snare (rim shot), Metronome (bell), Snare (hit) 2
  [39, "Hand Clap (hit)"],
  [40, "Electric Snare (hit)"],  // also Snare (side stick) 2
  [41, "Low Floor Tom (hit)"],
  [42, "Hi-Hat (closed)"],
  [43, "Very Low Tom (hit)"],  // also Grancassa (hit)
  [44, "Pedal Hi-Hat (hit)"],
  [45, "Low Tom (hit)"],
  [46, "Hi-Hat (half)"],  // also Hi-Hat (open)
  [47, "Mid Tom (hit)"],
  [48, "High Tom (hit)"],
  [49, "Crash high (hit)"],  // also Crash high (choke), Piatti (hit), Piatti (hand), Reverse Cymbal (hit), Cymbal (hit), Piatti (hat)
  [50, "High Floor Tom (hit)"],
  [51, "Ride (edge)"],  // also Ride (middle), Ride (choke)
  [52, "China (hit)"],  // also China (choke)
  [53, "Ride (bell)"],  // also Bell Tree (hit), Bell Tree (return), Jingle Bell (hit), Tinkle Bell (hit), Bell Tee (return)
  [54, "Tambourine (hit)"],  // also Tambourine (return), Tambourine (roll), Tambourine (hand)
  [55, "Splash (hit)"],  // also Splash (choke)
  [56, "Cowbell low (hit)"],  // also Cowbell low (tip), Cowbell medium (hit), Cowbell medium (tip), Cowbell high (hit), Cowbell high (tip)
  [57, "Crash medium (hit)"],  // also Crash medium (choke)
  [58, "Vibraslap (hit)"],
  [59, "Ride (edge) 2"],  // also Ride (middle) 2, Ride (bell) 2, Ride (choke) 2
  [60, "Bongo High (hit)"],  // also Bongo High (mute), Bongo High (slap), Hand (mute), Hand (slap)
  [61, "Bongo Low (hit)"],  // also Bongo Low (mute), Bongo Low (slap), Hand (hit), Hand (mute) 2, Hand (slap) 2
  [62, "Conga high (mute)"],  // also Golpe (thumb), Golpe (finger)
  [63, "Conga high (hit)"],  // also Conga high (slap)
  [64, "Conga low (hit)"],  // also Conga low (slap), Conga low (mute)
  [65, "Timbale high (hit)"],
  [66, "Timbale low (hit)"],
  [67, "Agogo high (hit)"],
  [68, "Agogo low (hit)"],  // also Agogo tow (hit)
  [69, "Cabasa (hit)"],  // also Cabasa (return)
  [70, "Left Maraca (hit)"],  // also Left Maraca (return), Right Maraca (hit), Right Maraca (return)
  [71, "Whistle high (hit)"],
  [72, "Whistle low (hit)"],
  [73, "Guiro (hit)"],
  [74, "Guiro (scrap-return)"],
  [75, "Claves (hit)"],
  [76, "Woodblock high (hit)"],
  [77, "Woodblock low (hit)"],
  [78, "Cuica (mute)"],
  [79, "Cuica (open)"],
  [80, "Triangle (mute)"],  // also Triangle (rnute)
  [81, "Triangle (hit)"],
  [82, "Shaker (hit)"],  // also Shaker (return)
  [85, "Castanets (hit)"],
  [86, "Surdo (hit)"],
  [87, "Surdo (mute)"],
]);

/**
 * The name for a drum number, or null when alphaTab's kit has no name for it.
 *
 * Null rather than a nearest match on purpose. The nearest number is a different drum:
 * answering 84 with the name for 83 turns a bell tree into a jingle bell silently, and a
 * writer that quietly changes an instrument is worse than one that says it cannot write
 * this. The caller decides what to do with a voice that has no name, and `pnpm corpus`
 * is what would notice if that ever happens on a real file.
 */
export function drumVoiceName(midiNumber: number): string | null {
  return DRUM_VOICE_NAMES.get(Math.round(midiNumber)) ?? null;
}

/**
 * One slot of the editing kit: a drum, its label, and the digit that enters it.
 *
 * Ten of them, because the number row has ten keys and because ten voices cover almost
 * every rock, pop and folk drum part ever written. The full table above has 51, and a
 * kit that offered all of them would need a mode, a search box, or two-key chords — none
 * of which belong in the path between hearing a fill and writing it down. Anything
 * outside these ten is still carried, played and engraved; it just arrives by import
 * rather than by keystroke.
 *
 * The order is the order a drummer reads down a staff — kick at the bottom of the
 * physical kit and the bottom of the notation, cymbals at the top — so the digits climb
 * the same way the noteheads do.
 */
export interface DrumKitSlot {
  /** General MIDI drum number, the same thing `Note.pitch` holds on a drums track. */
  midiNumber: number;
  /** Short label for the kit strip. Not alphaTab's articulation name, which is verbose. */
  label: string;
  /** The key that enters it: "1" through "9", then "0" for the tenth. */
  key: string;
}

export const DRUM_KIT: readonly DrumKitSlot[] = [
  { midiNumber: 35, label: "Kick", key: "1" },
  { midiNumber: 38, label: "Snare", key: "2" },
  { midiNumber: 37, label: "Rim", key: "3" },
  { midiNumber: 42, label: "HH closed", key: "4" },
  { midiNumber: 46, label: "HH open", key: "5" },
  { midiNumber: 44, label: "HH pedal", key: "6" },
  { midiNumber: 45, label: "Tom low", key: "7" },
  { midiNumber: 47, label: "Tom mid", key: "8" },
  { midiNumber: 48, label: "Tom high", key: "9" },
  { midiNumber: 49, label: "Crash", key: "0" },
];

/**
 * The kit slot a digit key enters, or null.
 *
 * "0" is the tenth slot rather than the zeroth, because the key sits at the end of the
 * number row on every keyboard layout this will ever run on, and a strip labelled 1..9,0
 * reads in the order the keys are arranged.
 */
export function drumSlotForKey(key: string): DrumKitSlot | null {
  return DRUM_KIT.find((slot) => slot.key === key) ?? null;
}
