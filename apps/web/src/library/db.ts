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
   * Account this entry belongs to, or null for work done while signed out.
   * Absent on entries written before ownership existed, which read as null.
   */
  ownerId?: string | null;
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

/**
 * Whose library this device is showing.
 *
 * Signing out does not clear IndexedDB: on a personal machine that would throw
 * away the user's work every time they signed out. On a shared machine it
 * meant the next person to sign in found the previous person's scores in their
 * library and pushed them to their own cloud account on the next sync. Entries
 * are owned, and only the current owner's are listed.
 *
 * Signing out hides entries rather than deleting them, so signing back in
 * restores them. The bytes stay on the disk: this is privacy between accounts
 * on one browser profile, not protection against someone with the machine.
 */
let owner: string | null = null;
let announceOwner: (() => void) | null = null;
/** Resolves the first time the app knows who is signed in. */
const ownerKnown = new Promise<void>((resolve) => {
  announceOwner = resolve;
});

export function setLibraryOwner(ownerId: string | null): void {
  owner = ownerId;
  announceOwner?.();
  announceOwner = null;
}

export function libraryOwner(): string | null {
  return owner;
}

function ownedBy(entry: LibraryEntry, ownerId: string | null): boolean {
  return (entry.ownerId ?? null) === ownerId;
}

/**
 * The current owner's entries. Waits for sign-in state to resolve, because
 * listing too early would show a signed-in user an empty library and then seed
 * a second demo score into it.
 */
export async function listEntries(): Promise<LibraryEntry[]> {
  await ownerKnown;
  const all = await tx<LibraryEntry[]>("readonly", (s) => s.getAll() as IDBRequest<LibraryEntry[]>);
  return all.filter((e) => ownedBy(e, owner)).sort((a, b) => b.openedAt - a.openedAt);
}

/**
 * Hands entries made while signed out to an account that just signed in. This
 * is what makes the first sign-in keep your work instead of hiding it.
 */
export async function adoptUnowned(ownerId: string): Promise<number> {
  const all = await tx<LibraryEntry[]>("readonly", (s) => s.getAll() as IDBRequest<LibraryEntry[]>);
  const orphans = all.filter((e) => ownedBy(e, null));
  for (const entry of orphans) await putEntry({ ...entry, ownerId });
  return orphans.length;
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
