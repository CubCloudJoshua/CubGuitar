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

  /** The recover-by-code form, shown in place of sign-in when toggled. */
  const [recovering, setRecovering] = useState(false);
  const [recoveryInput, setRecoveryInput] = useState("");

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

      {/* The outcome of a confirmation link. Above the sign-in form and outside it,
          because the link is usually opened in a browser that has no session: this is
          the answer to something the user did in their mail client, not to anything in
          the form below. */}
      {auth.verifyResult && (
        <div
          data-verify-result={auth.verifyResult.ok ? "ok" : "failed"}
          role="status"
          style={{
            border: `1px solid ${auth.verifyResult.ok ? color.accent : color.dangerText}`,
            borderRadius: 8,
            padding: "8px 10px",
            display: "flex",
            gap: 8,
            alignItems: "center",
          }}
        >
          <span
            style={{
              flex: 1,
              fontFamily: font.mono,
              fontSize: typeScale.sm,
              color: auth.verifyResult.ok ? color.text : color.dangerText,
            }}
          >
            {auth.verifyResult.message}
          </span>
          <Button size="sm" onClick={auth.dismissVerifyResult} style={{ color: color.textDim }}>
            ×
          </Button>
        </div>
      )}

      {auth.recoveryCode && (
        <div
          data-recovery-code={auth.recoveryCode}
          role="alert"
          style={{
            border: `1px solid ${color.accent}`,
            borderRadius: 8,
            padding: "8px 10px",
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            alignItems: "center",
          }}
        >
          <span style={{ fontFamily: font.mono, fontSize: typeScale.sm, color: color.text }}>
            Recovery code: <strong style={{ color: color.accent }}>{auth.recoveryCode}</strong>
          </span>
          <span style={{ flexBasis: "100%", fontFamily: font.mono, fontSize: typeScale.xs, color: color.textDim }}>
            Write this down. It is the only way to reset a forgotten password — there is no email
            reset — and it is shown exactly once. Using it issues a new one.
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void navigator.clipboard?.writeText(auth.recoveryCode ?? "").catch(() => undefined)}
          >
            COPY
          </Button>
          <Button size="sm" onClick={auth.dismissRecoveryCode} style={{ color: color.textDim }}>
            I SAVED IT
          </Button>
        </div>
      )}

      {!auth.user && recovering ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void auth.recover(email, recoveryInput, password).then((ok) => {
              if (ok) {
                setRecovering(false);
                setRecoveryInput("");
                setPassword("");
              }
            });
          }}
          data-recover-form=""
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
            placeholder="recovery code"
            value={recoveryInput}
            onChange={(e) => setRecoveryInput(e.target.value)}
            aria-label="Recovery code"
            style={{ width: 200 }}
          />
          <TextField
            type="password"
            placeholder="new password (8+ chars)"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-label="New password"
            style={{ width: 190 }}
          />
          <Button type="submit" variant="outline" disabled={auth.busy} style={{ fontWeight: 700 }}>
            RESET PASSWORD
          </Button>
          <Button type="button" onClick={() => setRecovering(false)} style={{ color: color.textDim }}>
            BACK
          </Button>
          {auth.error && (
            <span style={{ fontFamily: font.mono, fontSize: typeScale.sm, color: color.dangerText }}>
              {auth.error}
            </span>
          )}
          <span style={{ flexBasis: "100%", fontFamily: font.mono, fontSize: typeScale.xs, color: color.textDim }}>
            The code from when you created the account. Resetting signs out every other session and
            issues a fresh code.
          </span>
        </form>
      ) : !auth.user ? (
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
          <Button
            type="button"
            data-recover-toggle=""
            onClick={() => setRecovering(true)}
            style={{ color: color.textDim }}
            title="Reset your password with the recovery code you saved at signup"
          >
            FORGOT?
          </Button>
          {auth.error && (
            <span style={{ fontFamily: font.mono, fontSize: typeScale.sm, color: color.dangerText }}>
              {auth.error}
            </span>
          )}
          <span
            style={{ flexBasis: "100%", fontFamily: font.mono, fontSize: typeScale.xs, color: color.textDim }}
          >
            Accounts back up your library and make share links revocable. A forgotten password is
            reset with the recovery code, not by email.
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

          {/* Shown only when the address is unconfirmed AND this deployment can send the
              mail. Without the second condition every user of a deployment with no
              PUBLIC_URL would be asked forever to click a link that cannot be sent.
              Deliberately not a blocker: the account works either way, because gating
              function on a flag that depends on the operator's mail configuration would
              let one missing environment variable lock out everybody. */}
          {auth.user.verificationAvailable && auth.user.emailVerified === false && (
            <div
              data-email-unconfirmed=""
              style={{
                border: `1px solid ${color.hairline}`,
                borderRadius: 8,
                padding: "8px 10px",
                display: "flex",
                flexWrap: "wrap",
                gap: 8,
                alignItems: "center",
              }}
            >
              <span style={{ flex: 1, fontFamily: font.mono, fontSize: typeScale.sm, color: color.textDim }}>
                This address is not confirmed. Your account works, and your recovery code still
                resets the password — confirming only proves the address is yours.
              </span>
              <Button
                size="sm"
                variant="outline"
                data-verify-resend=""
                onClick={() => void auth.resendVerification()}
              >
                RESEND LINK
              </Button>
            </div>
          )}

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
