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
      <strong style={{ color: color.accentLive }}>
        Converted for editing. {notice.noteCount} notes across {notice.trackCount} tracks.
      </strong>
      <br />
      The semantic model does not carry these yet, so they are absent from the editable version
      (the original import is untouched in the library):
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
