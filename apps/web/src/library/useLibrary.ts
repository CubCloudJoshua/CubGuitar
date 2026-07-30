/**
 * Library orchestration: local entries, imports, the editor bridge, and
 * autosave. Owns the play/edit mode, because mode changes are always
 * consequences of library actions (open, import, new, edit-imported).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toAlphaTex, type Score as CoreScore } from "@cubscore/core";
import { fromAlphaTab, fromAscii, type ImportReport } from "@cubscore/formats";
import type { AlphaTabController } from "../useAlphaTab";
import type { EditorController } from "../editor/useEditor";
import { deleteEntry, getEntry, libraryOwner, listEntries, newId, putEntry, type LibraryEntry } from "./db";
import { DEMO_SCORE } from "../demo";

type Mode = "play" | "edit";

/**
 * Sentinel for savedTexRef: a document was just loaded, so the next tex the
 * editor produces *is* the saved state. Comparing against the tex directly is
 * impossible at load time because the editor recomputes it on the next render.
 */
const AWAIT_BASELINE = "\u0000cubscore-awaiting-baseline";

/** Which library row the editor writes to, and the revision it loaded. */
interface EditorTarget {
  id: string;
  addedAt: number;
  rev: number;
}

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

  const [mode, setMode] = useState<Mode>("play");
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [importNotice, setImportNotice] = useState<ImportReport | null>(null);
  /**
   * Library row the editor autosaves into, with the revision we loaded. Held in
   * state so the autosave effect and the UI react to ownership changes, and
   * mirrored into a ref so a flush triggered while leaving the editor reads the
   * current target rather than a stale closure.
   */
  const [editorEntry, setEditorEntry] = useState<EditorTarget | null>(null);
  const editorEntryRef = useRef<EditorTarget | null>(null);
  const setEditorTarget = useCallback((target: EditorTarget | null) => {
    editorEntryRef.current = target;
    setEditorEntry(target);
  }, []);

  /**
   * The document as of the last save or load. Autosave compares against this
   * so merely opening the editor never rewrites a row: entering edit mode on
   * an imported score used to overwrite it with the lossy projection.
   */
  const savedTexRef = useRef<string | null>(null);
  /** Latest document, for flushes that must not wait for a re-render. */
  const latestRef = useRef({ score: editor.score, tex: editor.tex });
  latestRef.current = { score: editor.score, tex: editor.tex };

  const refresh = useCallback(async () => {
    setEntries(await listEntries());
  }, []);

  // Boot. The entry list always loads: a shared-view or collab visitor still
  // has their own library and must be able to see it. Only the *opening* of a
  // score is suppressed for them, because their document arrives from the
  // share payload or the collab room and a second load would race it.
  useEffect(() => {
    void (async () => {
      const existing = await listEntries();
      setEntries(existing);
      if (disabled) return;
      if (existing.length === 0) {
        pendingRef.current = {
          id: newId(), format: "altex", bytes: null, tex: DEMO_SCORE, fileName: null, addedAt: Date.now(),
        };
        loadTex(DEMO_SCORE);
      } else {
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
          report = JSON.stringify(converted.report);
          // Editable means a track the editor can *render*, which is a stricter
          // test than a track existing. Drum tracks are now carried by the model
          // and written to MIDI, but alphaTex does not render them (see
          // toAlphaTex), so a drum-only transcription still has nothing to edit —
          // and storing a core for it made EDIT available and then handed the user
          // a blank guitar staff where their music had been, because the serializer
          // substitutes a default track for a score with nothing it can write.
          //
          // This test used to be `tracks.length > 0`, which was the same thing
          // while percussion was dropped on import and silently stopped being so
          // the moment it was carried. The file still plays, and the notice
          // explains what was dropped.
          // `trackCount` counts renderable tracks, not every track — see
          // from-alphatab. Drum tracks are carried by the model but alphaTex does
          // not write them, so a drum-only file has nothing to edit even though it
          // now has a track.
          if (converted.report.trackCount > 0) core = JSON.stringify(converted.score);
          // Nothing editable, so the user will never press EDIT and never see the
          // notice that explains why. Say it now, in the player.
          else if (converted.report.unsupported.length > 0) setImportNotice(converted.report);
        } catch (err) {
          // A failed conversion must not lose the import: the file still
          // plays, it just stays read-only.
          console.warn("core conversion failed", err);
        }
      }
      await putEntry({
        id: pending.id,
        ownerId: libraryOwner(),
        rev: 0,
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

  /**
   * Writes the editor document to its library row.
   *
   * Three rules earn their keep here:
   *  - Merge, never replace. format/bytes/report/fileName describe the imported
   *    source and the editor does not own them; overwriting them with the lossy
   *    alphaTex projection destroyed the only copy of the user's file.
   *  - Never resurrect. A row deleted in another tab stays deleted.
   *  - Fork on conflict. If another writer advanced the row, two divergent
   *    editor states cannot be merged yet, so this saves alongside their work
   *    instead of clobbering it.
   */
  const writeNow = useCallback(async (target: EditorTarget, score: CoreScore, tex: string) => {
    const existing = await getEntry(target.id);
    if (!existing && target.rev > 0) return;

    const conflicted = existing !== undefined && (existing.rev ?? 0) !== target.rev;
    const source = conflicted ? undefined : existing;
    const id = conflicted ? newId() : target.id;
    const addedAt = conflicted ? Date.now() : target.addedAt;

    const entry: LibraryEntry = {
      id,
      ownerId: source?.ownerId ?? libraryOwner(),
      rev: (source?.rev ?? 0) + 1,
      title: score.title,
      artist: score.artist,
      format: source?.format ?? "altex",
      bytes: source?.bytes ?? null,
      // openEntry prefers tex over bytes, so a byte-backed import keeps its own
      // tex (usually null) and the edits travel in core instead.
      tex: source?.bytes ? source.tex : tex,
      core: JSON.stringify(score),
      report: source?.report ?? null,
      authored: true,
      fileName: source?.fileName ?? null,
      addedAt,
      openedAt: Date.now(),
      tracks: score.tracks.length,
      bars: score.tracks[0]?.bars.length ?? 0,
    };
    await putEntry(entry);
    // Only adopt this write as "the editor's saved state" if the editor is still
    // on the row it was written for. Otherwise the next document would be
    // measured against the outgoing one's baseline and the new row would be
    // pointed at the old one's revision.
    if (editorEntryRef.current === target) {
      savedTexRef.current = tex;
      setEditorTarget({ id, addedAt, rev: entry.rev });
      if (conflicted) setCurrentId(id);
    }
    await refresh();
  }, [refresh, setEditorTarget]);

  /**
   * Decides what to save now, then queues the write.
   *
   * What to save is read here, synchronously, and what is read is what gets
   * written. That split matters: the queue defers the write to a later tick, and
   * callers change the editor's target in the same tick they flush (NEW, open,
   * import). Reading the target inside the queued task therefore picked up the
   * *incoming* row — so NEW wrote the outgoing document into the new score's row
   * and the outgoing row never got the user's last edits at all. The queue
   * serializes writing, not deciding.
   *
   * Queued because two flushes in flight at once — the debounce timer firing
   * just as the user clicks away — each read the row before the other wrote it,
   * so the second saw the first's revision as a foreign writer and forked a
   * duplicate copy of the score.
   */
  const savingRef = useRef<Promise<void>>(Promise.resolve());
  const flushSave = useCallback((): Promise<void> => {
    const target = editorEntryRef.current;
    const { score, tex } = latestRef.current;
    const clean = tex === savedTexRef.current || savedTexRef.current === AWAIT_BASELINE;
    if (!target || clean) return savingRef.current;

    const attempt = () =>
      writeNow(target, score, tex).catch((err) => {
        // A failed write must not break the chain, or every later save is
        // skipped and the user loses everything after the first hiccup.
        console.warn("autosave failed", err);
      });
    const next = savingRef.current.then(attempt, attempt);
    savingRef.current = next;
    return next;
  }, [writeNow]);

  // Debounced autosave. The dirty comparison means entering the editor cannot
  // rewrite a row on its own, and the timer only coalesces keystrokes: exits
  // flush explicitly, because a cleared timer used to discard the work.
  const editorScore = editor.score;
  useEffect(() => {
    if (mode !== "edit" || !editorEntry) return;
    if (savedTexRef.current === AWAIT_BASELINE) {
      // First render after a load: adopt this as the saved state and write
      // nothing. Without this, opening an import overwrote it immediately.
      savedTexRef.current = editorTex;
      return;
    }
    if (editorTex === savedTexRef.current) return;
    const timer = setTimeout(() => void flushSave(), 1000);
    return () => clearTimeout(timer);
  }, [mode, editorEntry, editorScore, editorTex, flushSave]);

  // Closing or hiding the tab must not silently drop the last edit.
  useEffect(() => {
    const onHide = () => void flushSave();
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [flushSave]);

  /** Leaves the editor, flushing first so nothing pending is lost. */
  const leaveEditor = useCallback(() => {
    void flushSave();
    setMode("play");
  }, [flushSave]);

  /**
   * Leaves the editor and gives up the row as well. Used when the signed-in
   * account changes: the open document belongs to whoever was signed in when
   * it was opened, and further keystrokes must not keep landing in their row.
   */
  const releaseEditor = useCallback(async () => {
    await flushSave();
    setEditorTarget(null);
    setMode("play");
  }, [flushSave, setEditorTarget]);

  /** Converts the open imported score into an editable document. */
  const editImported = useCallback(async () => {
    const listed = entries.find((e) => e.id === currentId);
    if (!listed?.core) return;
    // Flush first, then re-read: this row may be the one the editor was just
    // writing to, and the listing in state is a snapshot from before that.
    await flushSave();
    const entry = (await getEntry(listed.id)) ?? listed;
    if (!entry.core) return;
    editor.loadScore(JSON.parse(entry.core) as CoreScore);
    // Loading is not an edit: the row already holds this document.
    savedTexRef.current = AWAIT_BASELINE;
    setEditorTarget({ id: entry.id, addedAt: entry.addedAt, rev: entry.rev ?? 0 });
    setImportNotice(entry.report ? (JSON.parse(entry.report) as ImportReport) : null);
    setMode("edit");
    void putEntry({ ...entry, authored: true, openedAt: Date.now() }).then(refresh);
  }, [entries, currentId, editor, flushSave, refresh, setEditorTarget]);

  /**
   * Goes back to the bytes the user imported.
   *
   * Autosave never touches format/bytes/report/fileName, so an edited import
   * still holds the original file. This is the way back to it, and the reason
   * keeping those fields is worth anything: an import row carries both the
   * original and the working edit, and this chooses which one opening shows.
   * The edit is kept, not discarded — EDIT resumes it.
   */
  const showImportedOriginal = useCallback(async () => {
    const id = editorEntryRef.current?.id ?? currentId;
    if (!id) return;
    const entry = await getEntry(id);
    if (!entry?.bytes) return;
    // Stop the autosave from writing the projection we are stepping away from.
    savedTexRef.current = AWAIT_BASELINE;
    setEditorTarget(null);
    setMode("play");
    await putEntry({ ...entry, rev: (entry.rev ?? 0) + 1, authored: false, openedAt: Date.now() });
    setCurrentId(entry.id);
    loadBytes(entry.bytes);
    await refresh();
  }, [currentId, loadBytes, refresh, setEditorTarget]);

  /**
   * Adopts whatever the editor currently holds into this device's library and
   * lets autosave take over. Collaboration guests have no entry of their own —
   * the host's copy owns the document — so without this their contributions
   * vanish when the tab closes.
   */
  const adoptEditorScore = useCallback(() => {
    const target = { id: newId(), addedAt: Date.now(), rev: 0 };
    // A brand-new row: everything in the editor is unsaved, so mark it dirty.
    savedTexRef.current = null;
    setEditorTarget(target);
    setCurrentId(target.id);
    setMode("edit");
  }, [setEditorTarget]);

  const startNewScore = useCallback(() => {
    void flushSave();
    editor.newScore();
    setImportNotice(null);
    const target = { id: newId(), addedAt: Date.now(), rev: 0 };
    savedTexRef.current = null;
    setEditorTarget(target);
    setCurrentId(target.id);
    setMode("edit");
    setLibraryOpen(false);
  }, [editor, flushSave, setEditorTarget]);

  const importFile = useCallback(
    async (file: File) => {
      void flushSave();
      setMode("play");
      // ASCII tablature: the format people actually swap, and the one that arrives
      // as a .txt someone copied out of a forum. Parsed to our model and then
      // serialised to alphaTex so it travels the same path as every other import
      // — which means it plays, autosaves and becomes editable with no new
      // machinery. The report says what the format could not carry, and rhythm is
      // always on that list, because ASCII tab does not record any.
      if (/\.(txt|tab)$/i.test(file.name)) {
        const text = await file.text();
        const { score, report } = fromAscii(text);
        const notice: ImportReport = {
          unsupported: report.unsupported,
          trackCount: 1,
          barCount: report.barCount,
          noteCount: report.noteCount,
        };
        setImportNotice(notice);
        // Nothing recovered means there was no tablature in the file. The notice
        // says so; loading an empty score over what the user was looking at would
        // be a worse answer than leaving it alone.
        if (report.noteCount === 0) return;
        const tex = toAlphaTex(score);
        pendingRef.current = { id: newId(), format: "altex", bytes: null, tex, fileName: file.name, addedAt: Date.now() };
        loadTex(tex);
        setLibraryOpen(false);
        return;
      }

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
    [flushSave, loadTex, loadBytes],
  );

  /**
   * Opens a library entry.
   *
   * `playerOnly` forces the player even for a score authored here. Perform
   * mode's setlist needs it: an authored score would otherwise open in the
   * editor, and Perform hides every editing control, so the user would be
   * typing frets they cannot see the tools for and land in the editor on exit.
   */
  const openEntry = useCallback(
    async (row: LibraryEntry, { playerOnly = false }: { playerOnly?: boolean } = {}) => {
      // Awaited, and then re-read: reopening the row that is currently being
      // edited would otherwise load the pre-flush copy and write it back.
      await flushSave();
      const entry = (await getEntry(row.id)) ?? row;
      setCurrentId(entry.id);
      setImportNotice(null);
      if (entry.authored && entry.core && !playerOnly) {
        // Authored here, so it reopens in the editor.
        editor.loadScore(JSON.parse(entry.core) as CoreScore);
        savedTexRef.current = AWAIT_BASELINE;
        setEditorTarget({ id: entry.id, addedAt: entry.addedAt, rev: entry.rev ?? 0 });
        setMode("edit");
      } else {
        // Imported files open in the player, where alphaTab renders the
        // original faithfully. Editing is an explicit step. The original bytes
        // win over the projection for exactly that reason, and the projection is
        // the last resort so a score with nothing but a core model still plays
        // rather than opening an empty player.
        setMode("play");
        if (entry.tex !== null) loadTex(entry.tex);
        else if (entry.bytes) loadBytes(entry.bytes);
        else if (entry.core) loadTex(toAlphaTex(JSON.parse(entry.core) as CoreScore));
      }
      await putEntry({ ...entry, openedAt: Date.now() });
      await refresh();
      setLibraryOpen(false);
    },
    [editor, flushSave, loadTex, loadBytes, refresh, setEditorTarget],
  );

  const removeEntry = useCallback(
    async (id: string) => {
      await deleteEntry(id);
      if (id === currentId) setCurrentId(null);
      if (editorEntry?.id === id) {
        setEditorTarget(null);
        setMode("play");
      }
      await refresh();
    },
    [currentId, editorEntry, refresh],
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
    leaveEditor,
    releaseEditor,
    flushSave,
    showImportedOriginal,
    adoptEditorScore,
    ownsEditorEntry: editorEntry !== null,
    editImported,
    startNewScore,
    importFile,
    openEntry,
    removeEntry,
  };
}

export type LibraryController = ReturnType<typeof useLibrary>;
