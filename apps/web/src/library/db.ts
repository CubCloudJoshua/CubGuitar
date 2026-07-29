/**
 * Local score library, backed by IndexedDB.
 *
 * Local-first on purpose: it is the offline mode the desktop shell needs
 * (PLAN.md, apps/desktop) and it keeps the app useful before the sync
 * service exists. The cloud library layers on top of this, it does not
 * replace it.
 */

const DB_NAME = "cubscore";
const DB_VERSION = 1;
const STORE = "scores";

export type ScoreFormat = "gp" | "altex";

export interface LibraryEntry {
  id: string;
  /**
   * Bumped on every save. A writer that loaded rev N and finds rev != N knows
   * another tab moved the row on, and forks rather than clobbering it.
   */
  rev: number;
  title: string;
  artist: string;
  format: ScoreFormat;
  /** Populated for imported binary formats (Guitar Pro, MusicXML, CapXML). */
  bytes: ArrayBuffer | null;
  /** Populated for alphaTex sources. */
  tex: string | null;
  /**
   * JSON of the semantic Score for documents authored in CubScore. Its
   * presence is what makes an entry re-editable rather than play-only:
   * imported files have no core model until the Phase 2 importer lands.
   */
  core: string | null;
  /** JSON ImportReport: what the conversion to the core model could not carry. */
  report: string | null;
  /** Authored in CubScore, so it reopens in the editor rather than the player. */
  authored: boolean;
  fileName: string | null;
  addedAt: number;
  openedAt: number;
  tracks: number;
  bars: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB open failed"));
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = run(transaction.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("indexedDB request failed"));
        transaction.oncomplete = () => db.close();
      }),
  );
}

export function listEntries(): Promise<LibraryEntry[]> {
  return tx<LibraryEntry[]>("readonly", (s) => s.getAll() as IDBRequest<LibraryEntry[]>).then((all) =>
    all.sort((a, b) => b.openedAt - a.openedAt),
  );
}

export function getEntry(id: string): Promise<LibraryEntry | undefined> {
  return tx<LibraryEntry | undefined>("readonly", (s) => s.get(id) as IDBRequest<LibraryEntry | undefined>);
}

export function putEntry(entry: LibraryEntry): Promise<void> {
  return tx<IDBValidKey>("readwrite", (s) => s.put(entry)).then(() => undefined);
}

export function deleteEntry(id: string): Promise<void> {
  return tx<undefined>("readwrite", (s) => s.delete(id) as IDBRequest<undefined>).then(() => undefined);
}

export function newId(): string {
  return crypto.randomUUID();
}
