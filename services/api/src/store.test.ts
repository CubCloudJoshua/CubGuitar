/**
 * The file store is the only thing standing between a crash and a user's
 * account, so its failure modes are worth pinning down. Every test here
 * corresponds to a way the earlier version lost data or locked people out.
 */
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileLibraryStore, FileStore, FileUserStore, newShareId, type User } from "./store.js";

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
  it("finds a user by email through the index", async () => {
    const users = new FileUserStore(path.join(dir, "users"));
    const alice = user("alice@example.test");
    await users.put(alice);
    expect(await users.claimEmail(alice.email, alice.id)).toBe(true);

    expect((await users.byEmail("alice@example.test"))?.id).toBe(alice.id);
    expect(await users.byEmail("nobody@example.test")).toBeUndefined();
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

  it("finds accounts created before the email index existed", async () => {
    const usersDir = path.join(dir, "users");
    const users = new FileUserStore(usersDir);
    const legacy = user("legacy@example.test");
    await users.put(legacy);
    // No claimEmail call: this is what a pre-index account looks like on disk.
    expect((await users.byEmail("legacy@example.test"))?.id).toBe(legacy.id);
  });

  it("contains an unreadable record instead of failing every lookup", async () => {
    const usersDir = path.join(dir, "users");
    const users = new FileUserStore(usersDir);
    const good = user("good@example.test");
    await users.put(good);
    // A crash mid-write, or a truncating filesystem, leaves this behind.
    await writeFile(path.join(usersDir, "broken.json"), '{"id":"broken","ema');

    // The scan path is the one that used to throw, taking down all logins.
    expect((await users.byEmail("good@example.test"))?.id).toBe(good.id);
    expect(await users.byId("broken")).toBeUndefined();
  });

  it("leaves no partial record and no debris behind a write", async () => {
    const usersDir = path.join(dir, "users");
    const users = new FileUserStore(usersDir);
    const u = user("atomic@example.test");
    await users.put(u);
    await users.put({ ...u, passwordHash: "salt:changed" });

    const names = (await readdir(usersDir)).filter((n) => n.endsWith(".json"));
    expect(names).toEqual([`${u.id}.json`]);
    expect((await readdir(usersDir)).some((n) => n.endsWith(".tmp"))).toBe(false);
    expect((await users.byId(u.id))?.passwordHash).toBe("salt:changed");
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

  it("rejects ids that could escape the directory", async () => {
    const scores = new FileStore(path.join(dir, "scores"));
    expect(await scores.get("../../etc/passwd")).toBeUndefined();
    expect(await scores.get("")).toBeUndefined();
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
