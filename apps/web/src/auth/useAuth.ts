import { useCallback, useEffect, useState } from "react";

export interface AuthUser {
  id: string;
  email: string;
}

async function authRequest(path: string, body?: object): Promise<Response> {
  if (!body) return fetch(path);
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
    void (async () => {
      try {
        const response = await authRequest("/api/auth/me");
        if (response.ok) setUser(((await response.json()) as { user: AuthUser }).user);
      } catch {
        // The API being down means signed out, not broken UI.
      } finally {
        setChecked(true);
      }
    })();
  }, []);

  const run = useCallback(async (path: string, email: string, password: string) => {
    setBusy(true);
    setError(null);
    try {
      const response = await authRequest(path, { email, password });
      if (!response.ok) {
        setError(await errorOf(response));
        return false;
      }
      setUser(((await response.json()) as { user: AuthUser }).user);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const login = useCallback(
    (email: string, password: string) => run("/api/auth/login", email, password),
    [run],
  );
  const register = useCallback(
    (email: string, password: string) => run("/api/auth/register", email, password),
    [run],
  );

  const logout = useCallback(async () => {
    try {
      await authRequest("/api/auth/logout", {});
    } finally {
      setUser(null);
    }
  }, []);

  return { user, checked, busy, error, login, register, logout, clearError: () => setError(null) };
}

export type AuthController = ReturnType<typeof useAuth>;
