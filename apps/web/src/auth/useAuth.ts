import { useCallback, useEffect, useState } from "react";

export interface AuthUser {
  id: string;
  email: string;
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
  };
}

export type AuthController = ReturnType<typeof useAuth>;
