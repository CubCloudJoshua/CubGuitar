/**
 * The controls for a recording locked to the score.
 *
 * One row, because the interaction is one row's worth: press play, tap SYNC on the beat
 * you can hear, and the notation starts following. Two taps is enough for a recording at
 * a steady tempo, and more taps buy accuracy through a performance that moves.
 *
 * The number worth showing is the rate, and it is shown rather than hidden. If the marks
 * say the record runs at three times the written tempo, that is a mis-tap and the user is
 * the only one who can fix it — so the app says what it thinks the tempo relationship is
 * and names the mark it suspects, instead of quietly scrolling to the wrong place.
 */
import { color, font, heat, typeScale } from "@cubscore/design";
import type { RecordingController } from "./useRecording";

const cell: React.CSSProperties = {
  fontFamily: font.mono,
  fontSize: typeScale.sm,
  color: color.text,
  whiteSpace: "nowrap",
};
const dim: React.CSSProperties = { ...cell, color: color.textDim };

const chip: React.CSSProperties = {
  ...cell,
  background: "none",
  border: `1px solid ${color.hairline}`,
  borderRadius: 6,
  padding: "3px 9px",
  cursor: "pointer",
  color: color.text,
};

function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function RecordingBar({
  recording,
  scoreSeconds,
  onPick,
}: {
  recording: RecordingController;
  /** Where the notation's playhead is, which is what a SYNC tap marks. */
  scoreSeconds: number;
  onPick: () => void;
}) {
  const marks = recording.alignment.points.length;
  const off = recording.suspects.length > 0;

  return (
    <div
      role="group"
      aria-label="Recording"
      data-recording-bar=""
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 10,
        background: color.raised,
        border: `1px solid ${off ? heat.wrong : color.hairline}`,
        borderRadius: 8,
        padding: "6px 10px",
        marginBottom: 10,
      }}
    >
      <span style={{ ...cell, color: color.textDim, letterSpacing: 0.5 }}>RECORDING</span>

      {recording.url === null ? (
        <>
          <button style={chip} onClick={onPick} data-recording-pick="">
            ATTACH AUDIO
          </button>
          <span style={dim}>Play the record with the score. Tap SYNC on a beat to line them up.</span>
        </>
      ) : (
        <>
          <button style={chip} onClick={recording.playPause} data-recording-play="">
            {recording.playing ? "PAUSE" : "PLAY"}
          </button>
          <span style={cell} data-recording-time={recording.seconds.toFixed(2)}>
            {clock(recording.seconds)}
            <span style={{ color: color.textDim }}> / {clock(recording.duration)}</span>
          </span>

          {/* The whole interaction. Marks where the recording is now against where the
              notation is now, which is a thing a musician can do by ear in two taps. */}
          <button
            style={{ ...chip, borderColor: color.accent, color: color.accent }}
            onClick={() => recording.mark(scoreSeconds)}
            title="Mark this moment of the recording as this moment of the score"
            data-recording-mark=""
          >
            SYNC
          </button>
          <span style={dim} data-recording-marks={marks}>
            {marks} mark{marks === 1 ? "" : "s"}
          </span>
          {marks > 0 && (
            <button style={chip} onClick={recording.unmark} title="Remove the nearest mark">
              UNDO MARK
            </button>
          )}

          {/* Said out loud, because a wrong rate is the failure the user has to fix and
              the app cannot. */}
          {marks >= 2 && (
            <span style={cell} data-recording-speed={recording.speed.toFixed(3)}>
              <span style={{ color: color.textDim }}>score runs at </span>
              <span style={{ color: off ? heat.wrong : heat.clean }}>{recording.speed.toFixed(2)}×</span>
            </span>
          )}
          {off && (
            <span style={{ ...cell, color: heat.wrong }} data-recording-suspect="">
              mark {recording.suspects[0]! + 1} looks mistapped
            </span>
          )}

          <span style={{ flex: 1 }} />
          <span style={dim} title={recording.fileName ?? ""}>
            {(recording.fileName ?? "").slice(0, 28)}
          </span>
          <button style={chip} onClick={recording.detach} title="Remove the recording">
            REMOVE
          </button>
        </>
      )}

    </div>
  );
}

/**
 * The element that makes the sound, mounted outside the controls.
 *
 * Deliberately not inside `RecordingBar`. Putting it there meant hiding the bar — by
 * toggling it off, or by walking onto the stage in Perform mode — unmounted the element
 * mid-playback: the audio stopped without firing a pause, so the synth stayed silenced
 * and the score played nothing with nothing on screen saying why.
 *
 * No `controls` attribute either. The browser's own transport would give the user a
 * second playhead that disagrees with the score's, which is the one thing this feature
 * must not have.
 */
export function RecordingAudio({ recording }: { recording: RecordingController }) {
  if (recording.url === null) return null;
  return (
    <audio
      ref={recording.ref}
      src={recording.url}
      preload="auto"
      style={{ display: "none" }}
      {...recording.events}
    />
  );
}
