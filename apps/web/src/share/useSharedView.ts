/** Recipient side of a share link: load read-only, offer save-to-library. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AlphaTabController } from "../useAlphaTab";
import { libraryOwner, newId, putEntry } from "../library/db";
import { base64ToBytes, fetchShared, sharedIdFromLocation, type SharedScorePayload } from "../share";

export function useSharedView(c: AlphaTabController) {
  const { loadTex, loadBytes } = c;
  const [active] = useState(() => sharedIdFromLocation() !== null);
  const payloadRef = useRef<SharedScorePayload | null>(null);
  const [saved, setSaved] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const sharedId = sharedIdFromLocation();
    if (!sharedId) return;
    void (async () => {
      try {
        const payload = await fetchShared(sharedId);
        payloadRef.current = payload;
        if (payload.tex !== null) loadTex(payload.tex);
        else if (payload.bytesB64) loadBytes(base64ToBytes(payload.bytesB64));
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [loadTex, loadBytes]);

  /** A share recipient keeps a copy: store it locally, then open the full app. */
  const saveToLibrary = useCallback(async () => {
    const payload = payloadRef.current;
    if (!payload || !c.score) return;
    await putEntry({
      id: newId(),
      ownerId: libraryOwner(),
      rev: 0,
      title: c.score.title,
      artist: c.score.artist,
      format: payload.format,
      tex: payload.tex,
      bytes: payload.bytesB64 ? base64ToBytes(payload.bytesB64) : null,
      core: null,
      report: null,
      authored: false,
      fileName: null,
      addedAt: Date.now(),
      openedAt: Date.now(),
      tracks: c.tracks.length,
      bars: c.score.barCount,
    });
    setSaved(true);
  }, [c.score, c.tracks]);

  return { active, saved, loadError, saveToLibrary };
}

export type SharedViewController = ReturnType<typeof useSharedView>;
