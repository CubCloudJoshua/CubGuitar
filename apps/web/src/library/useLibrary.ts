/**
 * Library orchestration: local entries, imports, the editor bridge, and
 * autosave. Owns the play/edit mode, because mode changes are always
 * consequences of library actions (open, import, new, edit-imported).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Score as CoreScore } from "@cubscore/core";
import { fromAlphaTab, type ImportReport } from "@cubscore/formats";
import type { AlphaTabController } from "../useAlphaTab";
import type { EditorController } from "../editor/useEditor";
import { deleteEntry, listEntries, newId, putEntry, type LibraryEntry } from "./db";
import { DEMO_SCORE } from "../demo";

type Mode = "play" | "edit";

/** A load in flight, saved to the library once alphaTab reports the score. */
interface PendingImport {
  id: string;
  format: "gp" | "altex";
  bytes: ArrayBuffer | null;
  tex: string | null;
  fileName: string | null;
  addedAt: number;
}

export function useLibrary(c: AlphaTabController, editor: EditorController, narrow: boolean, disabled: boolean) {
  const { loadTex, loadBytes } = c;
  const pendingRef = useRef<PendingImport | null>(null);
  /** Library row the editor autosaves into. */
  const editorEntryRef = useRef<{ id: string; addedAt: number } | null>(null);

  const [mode, setMode] = useState<Mode>("play");
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [importNotice, setImportNotice] = useState<ImportReport | null>(null);

  const refresh = useCallback(async () => {
    setEntries(await listEntries());
  }, []);

  // Boot: seed the demo into an empty library, or reopen the latest score.
  useEffect(() => {
    if (disabled) return;
    void (async () => {
      const existing = await listEntries();
      if (existing.length === 0) {
        pendingRef.current = {
          id: newId(), format: "altex", bytes: null, tex: DEMO_SCORE, fileName: null, addedAt: Date.now(),
        };
        loadTex(DEMO_SCORE);
      } else {
        setEntries(existing);
        const first = existing[0];
        if (first) {
          setCurrentId(first.id);
          if (first.tex !== null) loadTex(first.tex);
          else if (first.bytes) loadBytes(first.bytes);
        }
      }
    })();
  }, [disabled, loadTex, loadBytes]);

  // Imported scores only report their metadata after alphaTab parses them.
  // The same pass converts to the semantic model so the file becomes editable.
  useEffect(() => {
    const pending = pendingRef.current;
    if (!pending || !c.score) return;
    pendingRef.current = null;
    void (async () => {
      let core: string | null = null;
      let report: string | null = null;
      const parsed = c.getScore();
      if (parsed) {
        try {
          const converted = fromAlphaTab(parsed);
          core = JSON.stringify(converted.score);
          report = JSON.stringify(converted.report);
        } catch (err) {
          // A failed conversion must not lose the import: the file still
          // plays, it just stays read-only.
          console.warn("core conversion failed", err);
        }
      }
      await putEntry({
        id: pending.id,
        title: c.score?.title ?? "Untitled",
        artist: c.score?.artist ?? "",
        format: pending.format,
        bytes: pending.bytes,
        tex: pending.tex,
        core,
        report,
        authored: false,
        fileName: pending.fileName,
        addedAt: pending.addedAt,
        openedAt: Date.now(),
        tracks: c.tracks.length,
        bars: c.score?.barCount ?? 0,
      });
      setCurrentId(pending.id);
      await refresh();
    })();
  }, [c.score, c.tracks, c.getScore, refresh]);

  // The editor owns the document in edit mode; alphaTab just renders it.
  const editorTex = editor.tex;
  useEffect(() => {
    if (mode !== "edit") return;
    loadTex(editorTex);
  }, [mode, editorTex, loadTex]);

  // Park alphaTab's beat cursor on the edit caret for visual feedback.
  const { cursorTick } = editor;
  useEffect(() => {
    if (mode !== "edit" || !c.ready) return;
    const api = c.getApi();
    if (api) api.tickPosition = cursorTick;
  }, [mode, cursorTick, c.ready, c.getApi, editorTex]);

  // Autosave, so editor work survives a reload like everything else.
  const editorScore = editor.score;
  useEffect(() => {
    if (mode !== "edit") return;
    const target = editorEntryRef.current;
    if (!target) return;
    const timer = setTimeout(() => {
      void (async () => {
        await putEntry({
          id: target.id,
          title: editorScore.title,
          artist: editorScore.artist,
          format: "altex",
          bytes: null,
          tex: editorTex,
          core: JSON.stringify(editorScore),
          report: null,
          authored: true,
          fileName: null,
          addedAt: target.addedAt,
          openedAt: Date.now(),
          tracks: editorScore.tracks.length,
          bars: editorScore.tracks[0]?.bars.length ?? 0,
        });
        await refresh();
      })();
    }, 1000);
    return () => clearTimeout(timer);
  }, [mode, editorScore, editorTex, refresh]);

  /** Converts the open imported score into an editable document. */
  const editImported = useCallback(() => {
    const entry = entries.find((e) => e.id === currentId);
    if (!entry?.core) return;
    editor.loadScore(JSON.parse(entry.core) as CoreScore);
    editorEntryRef.current = { id: entry.id, addedAt: entry.addedAt };
    setImportNotice(entry.report ? (JSON.parse(entry.report) as ImportReport) : null);
    setMode("edit");
    void putEntry({ ...entry, authored: true, openedAt: Date.now() }).then(refresh);
  }, [entries, currentId, editor, refresh]);

  const startNewScore = useCallback(() => {
    editor.newScore();
    setImportNotice(null);
    const target = { id: newId(), addedAt: Date.now() };
    editorEntryRef.current = target;
    setCurrentId(target.id);
    setMode("edit");
    setLibraryOpen(false);
  }, [editor]);

  const importFile = useCallback(
    async (file: File) => {
      setMode("play");
      const isTex = /\.(altex|tex)$/i.test(file.name);
      if (isTex) {
        const tex = await file.text();
        pendingRef.current = { id: newId(), format: "altex", bytes: null, tex, fileName: file.name, addedAt: Date.now() };
        loadTex(tex);
      } else {
        const bytes = await file.arrayBuffer();
        pendingRef.current = { id: newId(), format: "gp", bytes, tex: null, fileName: file.name, addedAt: Date.now() };
        loadBytes(bytes);
      }
      setLibraryOpen(false);
    },
    [loadTex, loadBytes],
  );

  const openEntry = useCallback(
    async (entry: LibraryEntry) => {
      setCurrentId(entry.id);
      setImportNotice(null);
      if (entry.authored && entry.core) {
        // Authored here, so it reopens in the editor.
        editor.loadScore(JSON.parse(entry.core) as CoreScore);
        editorEntryRef.current = { id: entry.id, addedAt: entry.addedAt };
        setMode("edit");
      } else {
        // Imported files open in the player, where alphaTab renders the
        // original faithfully. Editing is an explicit step.
        setMode("play");
        if (entry.tex !== null) loadTex(entry.tex);
        else if (entry.bytes) loadBytes(entry.bytes);
      }
      await putEntry({ ...entry, openedAt: Date.now() });
      await refresh();
      setLibraryOpen(false);
    },
    [editor, loadTex, loadBytes, refresh],
  );

  const removeEntry = useCallback(
    async (id: string) => {
      await deleteEntry(id);
      if (id === currentId) setCurrentId(null);
      if (editorEntryRef.current?.id === id) {
        editorEntryRef.current = null;
        setMode("play");
      }
      await refresh();
    },
    [currentId, refresh],
  );

  return {
    mode,
    setMode,
    entries,
    currentId,
    libraryOpen,
    setLibraryOpen,
    importNotice,
    setImportNotice,
    refresh,
    editImported,
    startNewScore,
    importFile,
    openEntry,
    removeEntry,
  };
}

export type LibraryController = ReturnType<typeof useLibrary>;
