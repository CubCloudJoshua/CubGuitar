import { Button, color, font, typeScale } from "@cubscore/design";
import type { ImportReport } from "@cubscore/formats";

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      style={{
        background: color.dangerBg,
        border: `1px solid ${color.dangerBorder}`,
        borderRadius: 8,
        color: color.dangerText,
        fontFamily: font.mono,
        fontSize: typeScale.base,
        padding: 10,
        marginBottom: 10,
        whiteSpace: "pre-wrap",
      }}
    >
      {message}
    </div>
  );
}

export function ImportNoticeBanner({
  notice,
  onDismiss,
}: {
  notice: ImportReport;
  onDismiss: () => void;
}) {
  return (
    <div
      style={{
        background: color.noticeBg,
        border: `1px solid ${color.accent}`,
        borderRadius: 8,
        color: color.text,
        fontFamily: font.mono,
        fontSize: typeScale.sm,
        padding: 10,
        marginBottom: 10,
        lineHeight: 1.7,
      }}
    >
      {/*
        Two honest versions rather than one that is wrong half the time. A file
        whose only tracks are percussion converts to nothing editable, and
        telling that user their score was "converted for editing" — then
        offering them a blank staff — was the confusing part.
      */}
      {notice.trackCount === 0 ? (
        <>
          <strong style={{ color: color.accentLive }}>
            This file plays, but there is nothing here CubScore can edit yet.
          </strong>
          <br />
          Everything in it is something the semantic model does not carry, so it stays in your
          library as the original file:
        </>
      ) : (
        <>
          <strong style={{ color: color.accentLive }}>
            Converted for editing. {notice.noteCount} notes across {notice.trackCount} tracks.
          </strong>
          <br />
          The semantic model does not carry these yet, so they are absent from the editable version
          (the original import is untouched in the library):
        </>
      )}
      <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
        {notice.unsupported.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <Button size="sm" onClick={onDismiss} style={{ marginTop: 8, color: color.textDim }}>
        DISMISS
      </Button>
    </div>
  );
}
