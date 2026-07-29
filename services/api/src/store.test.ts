/**
 * The file store is the only thing standing between a crash and a user's
 * account, so its failure modes are worth pinning down. Every test here
 * corresponds to a way the earlier version lost data or locked people out.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FileLibraryStore,
  FileSessionStore,
  FileStore,
  FileUserStore,
  newShareId,
  type User,
} from "./store.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cubscore-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function user(email: string): User {
  return { id: newShareId(), email, passwordHash: "salt:hash", createdAt: 1 };
}

describe("FileUserStore", () => {
  it("finds a user by email through the index, and only through the index", async () => {
    const usersDir = path.join(dir, "users");
    const users = new FileUserStore(usersDir);
    const alice = user("alice@example.test");
    await users.put(alice);
    expect(await users.claimEmail(alice.email, alice.id)).toBe(true);

    expect((await users.byEmail("alice@example.test"))?.id).toBe(alice.id);
    expect(await users.byEmail("nobody@example.test")).toBeUndefined();

    // Deleting the index entry must make the lookup fail. byEmail used to fall
    // back to reading every user record, which meant an unknown address cost one
    // file read per account on the server — an unauthenticated way to stop the
    // API answering anyone. This is the test that failed to notice the fallback:
    // it passed with the index lookup removed entirely.
    const key = createHash("sha256").update(alice.email).digest("hex").slice(0, 32);
    await rm(path.join(usersDir, "by-email", `${key}.json`));
    expect(await users.byEmail("alice@example.test")).toBeUndefined();
  });

  it("re-indexes accounts written before the index existed", async () => {
    const users = new FileUserStore(path.join(dir, "users"));
    const legacy = user("legacy@example.test");
    await users.put(legacy);
    // No claimEmail call: this is what a pre-index account looks like on disk,
    // and the boot migration is what makes it findable now that nothing scans.
    expect(await users.byEmail(legacy.email)).toBeUndefined();
    expect(await users.indexExistingEmails()).toBe(1);
    expect((await users.byEmail(legacy.email))?.id).toBe(legacy.id);
    // Idempotent: it runs on every start.
    expect(await users.indexExistingEmails()).toBe(0);
  });

  it("frees an address whose account has become unreadable", async () => {
    const usersDir = path.join(dir, "users");
    const users = new FileUserStore(usersDir);
    const lost = user("lost@example.test");
    await users.put(lost);
    expect(await users.claimEmail(lost.email, lost.id)).toBe(true);

    // A crash mid-write, or a truncating filesystem. The pointer survives and
    // resolves to nothing, so login fails; without a takeover the exclusive
    // claim then made the address unregisterable forever, by anyone.
    await writeFile(path.join(usersDir, `${lost.id}.json`), '{"id":"lo');
    expect(await users.byEmail(lost.email)).toBeUndefined();

    const replacement = user("lost@example.test");
    await users.put(replacement);
    expect(await users.claimEmail(replacement.email, replacement.id)).toBe(true);
    expect((await users.byEmail(replacement.email))?.id).toBe(replacement.id);

    // And a live account is still protected from takeover.
    const intruder = user("lost@example.test");
    await users.put(intruder);
    expect(await users.claimEmail(intruder.email, intruder.id)).toBe(false);
    expect((await users.byEmail(replacement.email))?.id).toBe(replacement.id);
  });

  it("lets only one registration claim an address", async () => {
    const users = new FileUserStore(path.join(dir, "users"));
    const first = user("shared@example.test");
    const second = user("shared@example.test");
    await users.put(first);
    await users.put(second);

    // Concurrent, as two registrations racing on one address would be.
    const results = await Promise.all([
      users.claimEmail(first.email, first.id),
      users.claimEmail(second.email, second.id),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);

    // Whoever won owns the address, and it resolves to exactly one account.
    const winner = results[0] ? first : second;
    expect((await users.byEmail("shared@example.test"))?.id).toBe(winner.id);
  });

  it("contains an unreadable record instead of failing every lookup", async () => {
    const usersDir = path.join(dir, "users");
    const users = new FileUserStore(usersDir);
    const good = user("good@example.test");
    await users.put(good);
    await users.claimEmail(good.email, good.id);
    // A crash mid-write, or a truncating filesystem, leaves this behind.
    await writeFile(path.join(usersDir, "broken.json"), '{"id":"broken","ema');

    // Reading it must not throw. The migration walks every record on boot, so a
    // record that throws on parse would take the whole startup down.
    expect(await users.byId("broken")).toBeUndefined();
    expect(await users.indexExistingEmails()).toBe(0);
    expect((await users.byEmail("good@example.test"))?.id).toBe(good.id);
  });

  it("makes a record's replacement visible atomically", async () => {
    const usersDir = path.join(dir, "users");
    const users = new FileUserStore(usersDir);
    const u = user("atomic@example.test");
    await users.put(u);

    // Concurrent writers to one id. Each write goes to its own temporary name
    // and renames over the target, so a reader in the middle of this sees one
    // whole record or another — never a fragment, and never a missing file
    // where one used to be. A plain truncate-and-write can leave both.
    const writes = Array.from({ length: 12 }, (_, i) =>
      users.put({ ...u, passwordHash: `salt:v${i}` }),
    );
    const reads = Array.from({ length: 40 }, () => users.byId(u.id));
    await Promise.all(writes);
    const seen = await Promise.all(reads);
    for (const record of seen) {
      // Any of the versions is a correct answer, including the one that was
      // there first — the point is that every read returns a whole record.
      // undefined would mean a reader caught the file mid-replacement.
      expect(record).toBeDefined();
      expect(record?.passwordHash).toMatch(/^salt:(hash|v\d+)$/);
    }
    expect((await readdir(usersDir)).some((n) => n.endsWith(".tmp"))).toBe(false);
  });
});

describe("FileSessionStore", () => {
  it("stops honouring a session once it is older than its lifetime", async () => {
    const sessions = new FileSessionStore(path.join(dir, "sessions"), 50);
    await sessions.create("token-a", "user-1");
    expect(await sessions.userIdFor("token-a")).toBe("user-1");

    await new Promise((resolve) => setTimeout(resolve, 80));
    // The cookie's Max-Age is a hint the client may ignore; this is the part
    // that is enforced. A leaked token used to authenticate forever.
    expect(await sessions.userIdFor("token-a")).toBeUndefined();
    // And the record is gone, so the directory does not grow one file per login.
    expect((await readdir(path.join(dir, "sessions"))).filter((n) => n.endsWith(".json"))).toEqual([]);
  });

  it("destroys a session on request", async () => {
    const sessions = new FileSessionStore(path.join(dir, "sessions"), 60_000);
    await sessions.create("token-b", "user-2");
    await sessions.destroy("token-b");
    expect(await sessions.userIdFor("token-b")).toBeUndefined();
  });
});

describe("FileStore", () => {
  it("lists only the owner's shares, newest first", async () => {
    const scores = new FileStore(path.join(dir, "scores"));
    const base = { title: "t", artist: "", format: "altex" as const, tex: "\\title x", bytesB64: null };
    await scores.put({ id: newShareId(), ...base, createdAt: 1, ownerId: "owner-a" });
    await scores.put({ id: newShareId(), ...base, createdAt: 3, ownerId: "owner-a" });
    await scores.put({ id: newShareId(), ...base, createdAt: 2, ownerId: "owner-b" });
    await scores.put({ id: newShareId(), ...base, createdAt: 4 });

    const mine = await scores.listByOwner("owner-a");
    expect(mine.map((s) => s.createdAt)).toEqual([3, 1]);
  });

  /**
   * The previous version of this asserted that reading "../../etc/passwd"
   * returned undefined, which it does whether or not ids are checked at all:
   * there is no /etc/passwd.json. It passed with the check removed. This plants
   * a real file outside the store and tries to reach it, and — the part that
   * actually matters — tries to write outside it.
   */
  it("cannot read or write outside its own directory", async () => {
    const scoresDir = path.join(dir, "scores");
    const scores = new FileStore(scoresDir);
    const outside = path.join(dir, "secret.json");
    await writeFile(outside, JSON.stringify({ id: "secret", title: "not yours" }));

    expect(await scores.get("../secret")).toBeUndefined();
    expect(await scores.get("..%2Fsecret")).toBeUndefined();
    expect(await scores.get("")).toBeUndefined();

    // A write with an unsafe id must fail rather than land somewhere else, and
    // a delete must not remove it.
    const record = {
      id: "../secret",
      title: "overwritten",
      artist: "",
      format: "altex" as const,
      tex: "x",
      bytesB64: null,
      createdAt: 1,
    };
    await expect(scores.put(record)).rejects.toThrow();
    await expect(scores.delete("../secret")).rejects.toThrow();
    expect(JSON.parse(await readFile(outside, "utf8")).title).toBe("not yours");
  });
});

describe("FileLibraryStore", () => {
  it("keeps one account's entries out of another's", async () => {
    const library = new FileLibraryStore(path.join(dir, "library"));
    const entry = {
      title: "Mine",
      artist: "",
      format: "altex" as const,
      tex: "\\title x",
      bytesB64: null,
      core: null,
      report: null,
      authored: true,
      tracks: 1,
      bars: 1,
      addedAt: 1,
      updatedAt: 1,
    };
    await library.put({ id: "same-id", ownerId: "owner-a", ...entry });
    await library.put({ id: "same-id", ownerId: "owner-b", ...entry, title: "Theirs" });

    expect((await library.get("owner-a", "same-id"))?.title).toBe("Mine");
    expect((await library.get("owner-b", "same-id"))?.title).toBe("Theirs");
    expect(await library.list("owner-a")).toHaveLength(1);

    await library.delete("owner-a", "same-id");
    expect(await library.get("owner-a", "same-id")).toBeUndefined();
    expect(await library.get("owner-b", "same-id")).toBeDefined();
  });
});
