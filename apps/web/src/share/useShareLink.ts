/** Creator side of share links: upload the current entry, hold the URL. */
import { useCallback, useState } from "react";
import type { LibraryEntry } from "../library/db";
import { shareEntry } from "../share";

export function useShareLink() {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const share = useCallback(async (entry: LibraryEntry | undefined) => {
    if (!entry) return;
    setBusy(true);
    setError(null);
    try {
      const shared = await shareEntry(entry);
      setUrl(shared);
      // Best effort; headless browsers and strict permissions may refuse.
      try {
        await navigator.clipboard.writeText(shared);
      } catch {
        /* the visible link covers this */
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  return { url, busy, error, share, dismiss: () => setUrl(null) };
}

export type ShareLinkController = ReturnType<typeof useShareLink>;
