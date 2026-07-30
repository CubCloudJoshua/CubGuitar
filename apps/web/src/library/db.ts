/**
 * Local score library, backed by IndexedDB.
 *
 * Local-first on purpose: it is the offline mode the desktop shell needs
 * (PLAN.md, apps/desktop) and it keeps the app useful before the sync
 * service exists. The cloud library layers on top of this, it does not
 * replace it.
 */

const DB_NAME = "cubscore";
const DB_VERSION = 2;
const STORE = "scores";
/**
 * Graded takes, one row per play-through.
 *
 * Its own store rather than a field on the score. A score is loaded, rewritten and
 * saved on every keystroke, and burying a growing history inside that row would mean
 * rewriting every take on every edit — and losing all of them the first time two tabs
 * raced the same save.
 */
const TAKES = "takes";

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
      if (!db.objectStoreNames.contains(TAKES)) {
        const takes = db.createObjectStore(TAKES, { keyPath: "id" });
        // Every read of this store is "the takes for one score", so the index is not
        // an optimisation: without it a user with a year of practice behind them pays
        // for all of it to open one piece.
        takes.createIndex("scoreId", "scoreId");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB open failed"));
    // A version upgrade waits for every other connection to close, and every connection
    // here closes at the end of its transaction, so this resolves on its own in the
    // normal case. It is handled anyway because the abnormal case — another tab wedged
    // mid-transaction — is otherwise a promise that never settles and a library that
    // never appears, with nothing at all on screen to say why.
    request.onblocked = () =>
      reject(new Error("Another tab is using CubScore's library. Close it and reload."));
  });
}

function tx<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
  store: string = STORE,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const request = run(transaction.objectStore(store));
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

/**
 * One graded play-through, stored.
 *
 * Per-bar counts rather than per-note verdicts: the analysis in
 * `packages/core/src/practice.ts` needs no more than this, and storing every note of
 * every take would put a megabyte of practice history behind a four-minute song.
 */
export interface StoredTake {
  id: string;
  /** The library entry this take belongs to. */
  scoreId: string;
  ownerId?: string | null;
  /** When the take happened. */
  at: number;
  /** Which staff was graded, and its name at the time. */
  trackIndex: number;
  trackName: string;
  /** The tempo it was actually played at: written tempo times playback speed. */
  bpm: number;
  /** JSON of core's TakeBar[], which is what `summarise` reads. */
  bars: string;
  /** The overall numbers, kept out of the JSON so a list can be shown without parsing. */
  accuracy: number | null;
  judged: number;
}

/**
 * Every take recorded for a score, oldest first.
 *
 * Filtered by owner for the same reason the score list is: on a shared machine, one
 * person's practice record is not another person's business. Waits for sign-in to
 * resolve first, or a take saved a moment later would be attributed to nobody.
 */
export async function listTakes(scoreId: string): Promise<StoredTake[]> {
  await ownerKnown;
  const rows = await tx<StoredTake[]>(
    "readonly",
    (s) => s.index("scoreId").getAll(scoreId) as IDBRequest<StoredTake[]>,
    TAKES,
  );
  return rows.filter((r) => (r.ownerId ?? null) === owner).sort((a, b) => a.at - b.at);
}

export function putTake(take: StoredTake): Promise<void> {
  return tx<IDBValidKey>("readwrite", (s) => s.put(take), TAKES).then(() => undefined);
}

/** Forgets a score's practice history, which is the only way to reset a record. */
export async function clearTakes(scoreId: string): Promise<void> {
  const rows = await listTakes(scoreId);
  await Promise.all(
    rows.map((row) => tx<undefined>("readwrite", (s) => s.delete(row.id) as IDBRequest<undefined>, TAKES)),
  );
}
