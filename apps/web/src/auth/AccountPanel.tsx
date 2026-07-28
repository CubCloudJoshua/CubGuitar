import { useCallback, useEffect, useState } from "react";
import { theme } from "../theme";
import { syncNow } from "../library/sync";
import type { AuthController } from "./useAuth";

interface ShareRow {
  id: string;
  title: string;
  artist: string;
  createdAt: number;
}

const field = {
  fontFamily: theme.mono,
  fontSize: 12,
  padding: "6px 8px",
  background: theme.bg,
  border: `1px solid ${theme.border}`,
  color: theme.text,
} as const;

const button = {
  fontFamily: theme.mono,
  fontSize: 11,
  padding: "5px 10px",
  border: `1px solid ${theme.accent}`,
  background: "transparent",
  color: theme.accent,
  cursor: "pointer",
} as const;

export function AccountPanel({
  auth,
  onLibraryChanged,
  onClose,
}: {
  auth: AuthController;
  onLibraryChanged: () => void;
  onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [syncState, setSyncState] = useState<string | null>(null);
  const [shares, setShares] = useState<ShareRow[]>([]);

  const loadShares = useCallback(async () => {
    const response = await fetch("/api/shares");
    if (response.ok) setShares((await response.json()) as ShareRow[]);
  }, []);

  useEffect(() => {
    if (auth.user) void loadShares();
    else setShares([]);
  }, [auth.user, loadShares]);

  const runSync = useCallback(async () => {
    setSyncState("syncing…");
    try {
      const result = await syncNow();
      setSyncState(`synced: ${result.pushed} pushed, ${result.pulled} pulled`);
      onLibraryChanged();
    } catch (err) {
      setSyncState(err instanceof Error ? err.message : String(err));
    }
  }, [onLibraryChanged]);

  const revoke = useCallback(
    async (id: string) => {
      await fetch(`/api/scores/${encodeURIComponent(id)}`, { method: "DELETE" });
      await loadShares();
    },
    [loadShares],
  );

  const submit = useCallback(
    async (mode: "login" | "register") => {
      const ok = await (mode === "login" ? auth.login(email, password) : auth.register(email, password));
      if (ok) {
        setPassword("");
        setSyncState(null);
      }
    },
    [auth, email, password],
  );

  return (
    <div
      style={{
        background: theme.panel,
        border: `1px solid ${theme.accent}`,
        padding: 12,
        marginBottom: 10,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: theme.mono, fontSize: 11, color: theme.accent, letterSpacing: 0.5 }}>
          ACCOUNT
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={onClose} style={{ ...button, borderColor: theme.border, color: theme.textDim }}>
          ×
        </button>
      </div>

      {!auth.user ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit("login");
          }}
          style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}
        >
          <input
            type="email"
            placeholder="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-label="Email"
            style={{ ...field, width: 200 }}
          />
          <input
            type="password"
            placeholder="password (8+ chars)"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-label="Password"
            style={{ ...field, width: 170 }}
          />
          <button type="submit" disabled={auth.busy} style={{ ...button, fontWeight: 700 }}>
            SIGN IN
          </button>
          <button type="button" disabled={auth.busy} onClick={() => void submit("register")} style={button}>
            CREATE ACCOUNT
          </button>
          {auth.error && (
            <span style={{ fontFamily: theme.mono, fontSize: 11, color: "#ffb0b0" }}>{auth.error}</span>
          )}
          <span style={{ flexBasis: "100%", fontFamily: theme.mono, fontSize: 10, color: theme.textDim }}>
            Accounts back up your library and make share links revocable. No email verification yet.
          </span>
        </form>
      ) : (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <span style={{ fontFamily: theme.mono, fontSize: 12, color: theme.text }}>{auth.user.email}</span>
            <button onClick={() => void runSync()} style={{ ...button, fontWeight: 700 }}>
              SYNC LIBRARY
            </button>
            <button onClick={() => void auth.logout()} style={{ ...button, borderColor: theme.border, color: theme.textDim }}>
              SIGN OUT
            </button>
            {syncState && (
              <span style={{ fontFamily: theme.mono, fontSize: 11, color: theme.textDim }}>{syncState}</span>
            )}
          </div>

          <div>
            <div style={{ fontFamily: theme.mono, fontSize: 11, color: theme.textDim, marginBottom: 6 }}>
              MY SHARE LINKS ({shares.length})
            </div>
            {shares.length === 0 ? (
              <span style={{ fontFamily: theme.mono, fontSize: 11, color: theme.textDim }}>
                None yet. Shares created while signed in appear here and can be revoked.
              </span>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {shares.map((s) => {
                  const url = `${location.origin}${location.pathname}#s=${s.id}`;
                  return (
                    <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span
                        style={{
                          fontFamily: theme.mono, fontSize: 12, color: theme.text,
                          flex: "1 1 auto", minWidth: 0,
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        }}
                        title={url}
                      >
                        {s.title}
                        {s.artist ? ` — ${s.artist}` : ""}
                      </span>
                      <button
                        onClick={() => void navigator.clipboard.writeText(url).catch(() => undefined)}
                        style={button}
                      >
                        COPY
                      </button>
                      <button
                        onClick={() => void revoke(s.id)}
                        style={{ ...button, borderColor: "#7a2020", color: "#ffb0b0" }}
                        aria-label={`Revoke ${s.title}`}
                      >
                        REVOKE
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
