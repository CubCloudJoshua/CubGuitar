import { useCallback, useEffect, useState } from "react";

export interface AuthUser {
  id: string;
  email: string;
  /**
   * Whether the address proved it was reachable, and whether this deployment can ask it
   * to.
   *
   * Both, because they want opposite interfaces. Unverified on a deployment that can send
   * mail is something to act on; unverified on one that cannot is nothing to mention, and
   * a banner asking every user to click a link that will never arrive would be worse than
   * no verification at all. Optional so a client built against an older API — or a
   * response from before this existed — reads as "nothing to say" rather than "unverified".
   */
  emailVerified?: boolean;
  verificationAvailable?: boolean;
}

/**
 * Reads and clears a `?verify=` token from the address bar.
 *
 * Cleared with replaceState rather than left in place: the token is single use, and a URL
 * carrying a spent one gets bookmarked, pasted into chat, and kept in history. Returning
 * it before the request goes out means the address bar is clean whether the confirmation
 * succeeds or fails.
 */
function takeVerifyToken(): string | null {
  if (typeof location === "undefined") return null;
  const params = new URLSearchParams(location.search);
  const token = params.get("verify");
  if (!token) return null;
  params.delete("verify");
  const query = params.toString();
  history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
  return token;
}

function authPost(path: string, body: object): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function errorOf(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: string };
    return data.error ?? `request failed (${response.status})`;
  } catch {
    return `request failed (${response.status})`;
  }
}

export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(null);
  /** Distinguishes "signed out" from "haven't checked yet". */
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Bounded, because everything waits on this answer: the library holds its
    // reads until sign-in state resolves so a signed-in user is never shown an
    // empty library. A request that neither succeeds nor fails — a hung proxy,
    // a captive portal — would otherwise leave the app with no library at all
    // and nothing on screen to explain why.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 8000);
    void (async () => {
      try {
        const response = await fetch("/api/auth/me", { signal: abort.signal });
        if (response.ok) setUser(((await response.json()) as { user: AuthUser }).user);
      } catch {
        // The API being unreachable means signed out, not broken UI.
      } finally {
        clearTimeout(timer);
        setChecked(true);
      }
    })();
    // Only the timer is cancelled here. Aborting the request on unmount would
    // resolve sign-in state as "signed out" during a remount, and the library
    // seeds a demo score when it sees an empty list.
    return () => clearTimeout(timer);
  }, []);

  /**
   * The account's recovery code, held only long enough to be shown.
   *
   * Set when the server mints one (registration, and each successful recovery) and
   * cleared when the panel dismisses it. Never persisted anywhere on the client: the
   * server keeps only a hash, so this render is the code's one appearance and the
   * user's one chance to save it — which the panel says in as many words.
   */
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);

  const run = useCallback(async (path: string, body: Record<string, string>) => {
    setBusy(true);
    setError(null);
    try {
      const response = await authPost(path, body);
      if (!response.ok) {
        setError(await errorOf(response));
        return false;
      }
      const payload = (await response.json()) as { user: AuthUser; recoveryCode?: string };
      setUser(payload.user);
      if (payload.recoveryCode) setRecoveryCode(payload.recoveryCode);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const login = useCallback(
    (email: string, password: string) => run("/api/auth/login", { email, password }),
    [run],
  );
  const register = useCallback(
    (email: string, password: string) => run("/api/auth/register", { email, password }),
    [run],
  );
  /** Password reset by recovery code; a success signs the user in and mints a new code. */
  const recover = useCallback(
    (email: string, recoveryCode: string, newPassword: string) =>
      run("/api/auth/recover", { email, recoveryCode, newPassword }),
    [run],
  );

  /**
   * The outcome of a confirmation link, for the panel to report.
   *
   * Kept separate from `error`, which is the sign-in form's. A confirmation happens on
   * page load, often in a browser that is not signed in at all, so its result has no form
   * to attach itself to and must not colour the login box red.
   */
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; message: string } | null>(null);

  const resendVerification = useCallback(async () => {
    setVerifyResult(null);
    const response = await authPost("/api/auth/verify/resend", {});
    if (response.ok) {
      setVerifyResult({ ok: true, message: "Sent. Check that address." });
      return true;
    }
    setVerifyResult({ ok: false, message: await errorOf(response) });
    return false;
  }, []);

  // A confirmation link, clicked. Runs once on mount, before anything reads the URL for
  // its own purposes, and independently of whether this browser has a session: the token
  // is the proof, so the link works in whatever browser opened the mail.
  useEffect(() => {
    const token = takeVerifyToken();
    if (!token) return;
    void (async () => {
      const response = await authPost("/api/auth/verify", { token });
      if (response.ok) {
        const payload = (await response.json()) as { user: AuthUser };
        setVerifyResult({ ok: true, message: `${payload.user.email} is confirmed.` });
        // Only if this is the same account. The link may well have been opened in a
        // browser signed in as somebody else, and adopting the response's user there
        // would silently switch accounts — and with them, which library is on screen.
        setUser((prev) => (prev && prev.id === payload.user.id ? payload.user : prev));
      } else {
        setVerifyResult({ ok: false, message: await errorOf(response) });
      }
    })();
  }, []);

  const logout = useCallback(async () => {
    try {
      await authPost("/api/auth/logout", {});
    } finally {
      setUser(null);
    }
  }, []);

  return {
    user,
    checked,
    busy,
    error,
    login,
    register,
    recover,
    logout,
    recoveryCode,
    dismissRecoveryCode: () => setRecoveryCode(null),
    clearError: () => setError(null),
    resendVerification,
    verifyResult,
    dismissVerifyResult: () => setVerifyResult(null),
  };
}

export type AuthController = ReturnType<typeof useAuth>;
