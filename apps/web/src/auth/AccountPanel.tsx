import { useCallback, useEffect, useState } from "react";
import { Button, color, font, Label, Panel, TextField, typeScale } from "@cubscore/design";
import { syncNow } from "../library/sync";
import type { AuthController } from "./useAuth";

interface ShareRow {
  id: string;
  title: string;
  artist: string;
  createdAt: number;
}

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
    <Panel accent style={{ marginBottom: 10, display: "flex", flexDirection: "column", gap: 10, padding: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Label style={{ color: color.accent }}>ACCOUNT</Label>
        <span style={{ flex: 1 }} />
        <Button size="sm" onClick={onClose} style={{ color: color.textDim }}>
          ×
        </Button>
      </div>

      {!auth.user ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit("login");
          }}
          style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}
        >
          <TextField
            type="email"
            placeholder="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-label="Email"
            style={{ width: 200 }}
          />
          <TextField
            type="password"
            placeholder="password (8+ chars)"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-label="Password"
            style={{ width: 170 }}
          />
          <Button type="submit" variant="outline" disabled={auth.busy} style={{ fontWeight: 700 }}>
            SIGN IN
          </Button>
          <Button type="button" variant="outline" disabled={auth.busy} onClick={() => void submit("register")}>
            CREATE ACCOUNT
          </Button>
          {auth.error && (
            <span style={{ fontFamily: font.mono, fontSize: typeScale.sm, color: color.dangerText }}>
              {auth.error}
            </span>
          )}
          <span
            style={{ flexBasis: "100%", fontFamily: font.mono, fontSize: typeScale.xs, color: color.textDim }}
          >
            Accounts back up your library and make share links revocable. No email verification yet.
          </span>
        </form>
      ) : (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <span style={{ fontFamily: font.mono, fontSize: typeScale.base, color: color.text }}>
              {auth.user.email}
            </span>
            <Button variant="outline" onClick={() => void runSync()} style={{ fontWeight: 700 }}>
              SYNC LIBRARY
            </Button>
            <Button onClick={() => void auth.logout()} style={{ color: color.textDim }}>
              SIGN OUT
            </Button>
            {/* Whether a sync succeeded, and what it moved, is the answer to the
                button the user just pressed — so it is announced, not only
                shown. This is also where a refused cross-account sync explains
                itself. */}
            <span role="status">{syncState && <Label>{syncState}</Label>}</span>
          </div>

          <div>
            <div style={{ marginBottom: 6 }}>
              <Label>MY SHARE LINKS ({shares.length})</Label>
            </div>
            {shares.length === 0 ? (
              <Label>None yet. Shares created while signed in appear here and can be revoked.</Label>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {shares.map((s) => {
                  const url = `${location.origin}${location.pathname}#s=${s.id}`;
                  return (
                    <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span
                        style={{
                          fontFamily: font.mono,
                          fontSize: typeScale.base,
                          color: color.text,
                          flex: "1 1 auto",
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={url}
                      >
                        {s.title}
                        {s.artist ? ` — ${s.artist}` : ""}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void navigator.clipboard.writeText(url).catch(() => undefined)}
                      >
                        COPY
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => void revoke(s.id)}
                        aria-label={`Revoke ${s.title}`}
                      >
                        REVOKE
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </Panel>
  );
}
