import { theme } from "../theme";
import { headerButton } from "./styles";
import type { ImportReport } from "@cubscore/formats";

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      style={{
        background: "#2a1010", border: "1px solid #7a2020", color: "#ffb0b0",
        fontFamily: theme.mono, fontSize: 12, padding: 10, marginBottom: 10, whiteSpace: "pre-wrap",
      }}
    >
      {message}
    </div>
  );
}

export function ShareLinkBar({ url, onDismiss }: { url: string; onDismiss: () => void }) {
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 8,
        background: theme.panel, border: `1px solid ${theme.accent}`,
        padding: 10, marginBottom: 10,
      }}
    >
      <span style={{ fontFamily: theme.mono, fontSize: 11, color: theme.accent }}>LINK</span>
      <input
        readOnly
        value={url}
        aria-label="Share link"
        onFocus={(e) => e.target.select()}
        style={{
          flex: 1, minWidth: 0, fontFamily: theme.mono, fontSize: 12,
          padding: "6px 8px", background: theme.bg,
          border: `1px solid ${theme.border}`, color: theme.text,
        }}
      />
      <button
        onClick={() => void navigator.clipboard.writeText(url).catch(() => undefined)}
        style={headerButton}
      >
        COPY
      </button>
      <button
        onClick={onDismiss}
        style={{ ...headerButton, borderColor: theme.border, color: theme.textDim }}
      >
        ×
      </button>
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
        background: "#241a06",
        border: `1px solid ${theme.accent}`,
        color: theme.text,
        fontFamily: theme.mono,
        fontSize: 11,
        padding: 10,
        marginBottom: 10,
        lineHeight: 1.7,
      }}
    >
      <strong style={{ color: theme.accentBright }}>
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
      <button
        onClick={onDismiss}
        style={{
          marginTop: 8, fontFamily: theme.mono, fontSize: 11, padding: "4px 10px",
          background: "transparent", border: `1px solid ${theme.border}`,
          color: theme.textDim, cursor: "pointer",
        }}
      >
        DISMISS
      </button>
    </div>
  );
}
