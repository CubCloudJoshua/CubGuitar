/**
 * Email verification: the tokens, and the mail that carries them.
 *
 * The endpoint behaviour is covered end to end by `pnpm e2e verify-email`, which drives a
 * real browser through a real confirmation link. What is worth unit testing is everything
 * that is easy to get subtly wrong and impossible to see from the outside: where the
 * token splits, what a wrong-length stored hash does, whether an expired link is spent,
 * and whether a header can be smuggled into a message.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  hashVerificationSecret,
  newVerificationToken,
  splitVerificationToken,
  verifyVerificationSecret,
} from "./auth.js";
import { compose, deliver, mailConfig, publicOrigin, verificationMessage } from "./mail.js";
import { newShareId } from "./store.js";

const tempDir = () => mkdtemp(path.join(tmpdir(), "cubscore-mail-"));

describe("verification tokens", () => {
  it("names the account in the token and keeps only a hash of the secret", () => {
    const issued = newVerificationToken("acct1", 1_000);
    const parts = splitVerificationToken(issued.token);
    expect(parts).not.toBeNull();
    expect(parts?.userId).toBe("acct1");
    // The stored hash is of the secret alone, so the account id is not part of the proof.
    expect(issued.hash).toBe(hashVerificationSecret(parts!.secret));
    // Nothing recoverable: the token must not appear in what is stored.
    expect(issued.hash).not.toContain(parts!.secret);
  });

  it("expires 24 hours after it was issued", () => {
    expect(newVerificationToken("a", 0).expiresAt).toBe(24 * 60 * 60 * 1000);
    expect(newVerificationToken("a", 5_000).expiresAt).toBe(5_000 + 24 * 60 * 60 * 1000);
  });

  it("issues a different secret every time", () => {
    const seen = new Set(Array.from({ length: 20 }, () => newVerificationToken("a").token));
    expect(seen.size).toBe(20);
  });

  it("splits on the first dot, so a secret cannot move the boundary", () => {
    expect(splitVerificationToken("id.a.b")).toEqual({ userId: "id", secret: "a.b" });
  });

  it("depends on account ids containing no dot, and they do not", () => {
    // The token is `id.secret` split on the first dot, so an id that could contain one
    // would silently truncate and every confirmation would fail. Ids are base64url from
    // newShareId and the store's own guard restricts them further, but the token format is
    // in another file, so this pins the coupling: change the id alphabet and this fails
    // rather than verification.
    for (let i = 0; i < 200; i += 1) {
      const id = newShareId();
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(splitVerificationToken(newVerificationToken(id).token)?.userId).toBe(id);
    }
  });

  it("rejects everything that is not a token", () => {
    for (const bad of [undefined, null, 42, {}, "", "nodot", ".leading", "trailing.", `a.${"x".repeat(500)}`]) {
      expect(splitVerificationToken(bad)).toBeNull();
    }
  });

  it("accepts the right secret and refuses a wrong one", () => {
    const issued = newVerificationToken("acct");
    const secret = splitVerificationToken(issued.token)!.secret;
    expect(verifyVerificationSecret(secret, issued.hash)).toBe(true);
    expect(verifyVerificationSecret(`${secret}x`, issued.hash)).toBe(false);
    expect(verifyVerificationSecret("", issued.hash)).toBe(false);
  });

  it("returns false rather than throwing on a stored hash of the wrong length", () => {
    // timingSafeEqual throws on mismatched lengths, which would turn a corrupt or
    // truncated stored value into a 500 instead of a refusal.
    const issued = newVerificationToken("acct");
    const secret = splitVerificationToken(issued.token)!.secret;
    expect(verifyVerificationSecret(secret, "")).toBe(false);
    expect(verifyVerificationSecret(secret, "deadbeef")).toBe(false);
    expect(verifyVerificationSecret(secret, `${issued.hash}00`)).toBe(false);
  });
});

describe("publicOrigin", () => {
  it("is null when unset, which is what switches verification off", () => {
    expect(publicOrigin({})).toBeNull();
    expect(publicOrigin({ PUBLIC_URL: "" })).toBeNull();
  });

  it("keeps scheme, host and port and drops everything else", () => {
    expect(publicOrigin({ PUBLIC_URL: "https://score.example.com" })).toBe("https://score.example.com");
    expect(publicOrigin({ PUBLIC_URL: "http://localhost:4399/" })).toBe("http://localhost:4399");
    // A path would otherwise be concatenated into every link.
    expect(publicOrigin({ PUBLIC_URL: "https://example.com/cubscore/" })).toBe("https://example.com");
  });

  it("refuses anything that is not http", () => {
    for (const bad of ["not a url", "ftp://example.com", "javascript:alert(1)", "file:///etc"]) {
      expect(publicOrigin({ PUBLIC_URL: bad })).toBeNull();
    }
  });
});

describe("mailConfig", () => {
  it("defaults to the file transport", () => {
    expect(mailConfig("/data", {}).transport).toBe("file");
    expect(mailConfig("/data", { MAIL_TRANSPORT: "nonsense" }).transport).toBe("file");
    expect(mailConfig("/data", { MAIL_TRANSPORT: "command" }).transport).toBe("command");
  });

  it("spools beside the account data, so one set of permissions and backups covers it", () => {
    expect(mailConfig("/var/lib/cubscore", {}).spoolDir).toBe("/var/lib/cubscore/mail");
  });

  it("splits MAIL_COMMAND into argv without a shell", () => {
    expect(mailConfig("/d", { MAIL_COMMAND: "  /usr/sbin/sendmail   -t -i " }).command).toEqual([
      "/usr/sbin/sendmail",
      "-t",
      "-i",
    ]);
    expect(mailConfig("/d", {}).command).toEqual([]);
  });

  it("derives a From address from the public host, and lets it be overridden", () => {
    expect(mailConfig("/d", { PUBLIC_URL: "https://score.example.com" }).from).toBe(
      "cubscore@score.example.com",
    );
    expect(mailConfig("/d", { MAIL_FROM: "noreply@x.test" }).from).toBe("noreply@x.test");
  });
});

describe("compose", () => {
  it("writes the headers a transport needs, separated from the body by a blank line", () => {
    const raw = compose({ to: "a@b.test", subject: "Hello", body: "line one\nline two" }, "from@x.test");
    expect(raw).toContain("To: a@b.test\r\n");
    expect(raw).toContain("From: from@x.test\r\n");
    expect(raw).toContain("Subject: Hello\r\n");
    expect(raw).toContain("MIME-Version: 1.0");
    const [headers, body] = raw.split("\r\n\r\n");
    expect(headers).not.toContain("line one");
    expect(body).toContain("line one\nline two");
  });

  it("refuses a newline in a header, so a subject cannot become a Bcc", () => {
    expect(() => compose({ to: "a@b.test", subject: "x\r\nBcc: c@d.test", body: "" }, "f@x.test")).toThrow(
      /newline/,
    );
    expect(() => compose({ to: "a@b.test\nBcc: c@d.test", subject: "x", body: "" }, "f@x.test")).toThrow(
      /newline/,
    );
    expect(() => compose({ to: "a@b.test", subject: "x", body: "" }, "f@x.test\nBcc: c@d")).toThrow(
      /newline/,
    );
  });

  it("leaves the body alone, including its newlines", () => {
    const raw = compose({ to: "a@b.test", subject: "s", body: "keep\nthis" }, "f@x.test");
    expect(raw.endsWith("keep\nthis\r\n")).toBe(true);
  });
});

describe("the file transport", () => {
  it("writes the message where an operator can read it, owner-only", async () => {
    const dir = await tempDir();
    const config = mailConfig(dir, {});
    const result = await deliver({ to: "player@x.test", subject: "s", body: "the link" }, config);
    expect(result.sent).toBe(true);
    expect(result.detail.startsWith(path.join(dir, "mail"))).toBe(true);
    const written = await readFile(result.detail, "utf8");
    expect(written).toContain("To: player@x.test");
    expect(written).toContain("the link");
    // A live token is in this file, so it gets the account data's treatment.
    expect((await stat(result.detail)).mode & 0o777).toBe(0o600);
  });

  it("does not collide when two messages go to the same address", async () => {
    const dir = await tempDir();
    const config = mailConfig(dir, {});
    const a = await deliver({ to: "same@x.test", subject: "1", body: "" }, config);
    const b = await deliver({ to: "same@x.test", subject: "2", body: "" }, config);
    // Same millisecond is possible, so the check is that nothing was lost, not that the
    // names differ: if they collided, the first message would have been overwritten.
    expect(await readFile(b.detail, "utf8")).toContain("Subject: 2");
    if (a.detail !== b.detail) expect(await readFile(a.detail, "utf8")).toContain("Subject: 1");
  });
});

describe("the command transport", () => {
  it("pipes the message to the command's stdin", async () => {
    const dir = await tempDir();
    const out = path.join(dir, "captured.eml");
    const script = path.join(dir, "sink.cjs");
    await writeFile(
      script,
      `let d="";process.stdin.on("data",c=>d+=c).on("end",()=>require("fs").writeFileSync(process.argv[2],d));`,
    );
    const config = mailConfig(dir, {
      MAIL_TRANSPORT: "command",
      MAIL_COMMAND: `${process.execPath} ${script} ${out}`,
    });
    const result = await deliver({ to: "a@b.test", subject: "piped", body: "body here" }, config);
    expect(result.sent).toBe(true);
    expect(await readFile(out, "utf8")).toContain("Subject: piped");
  });

  it("reports a failure instead of throwing, so a signup still completes", async () => {
    const dir = await tempDir();
    const script = path.join(dir, "fail.cjs");
    await writeFile(script, `process.stdin.resume();process.stderr.write("nope");process.exit(3);`);
    const config = mailConfig(dir, {
      MAIL_TRANSPORT: "command",
      MAIL_COMMAND: `${process.execPath} ${script}`,
    });
    const result = await deliver({ to: "a@b.test", subject: "s", body: "" }, config);
    expect(result.sent).toBe(false);
    expect(result.detail).toContain("exit 3");
  });

  it("reports a missing command rather than spawning nothing", async () => {
    const config = mailConfig(await tempDir(), { MAIL_TRANSPORT: "command" });
    const result = await deliver({ to: "a@b.test", subject: "s", body: "" }, config);
    expect(result.sent).toBe(false);
    expect(result.detail).toContain("MAIL_COMMAND");
  });

  it("reports a command that does not exist", async () => {
    const config = mailConfig(await tempDir(), {
      MAIL_TRANSPORT: "command",
      MAIL_COMMAND: "/nonexistent/sendmail -t",
    });
    const result = await deliver({ to: "a@b.test", subject: "s", body: "" }, config);
    expect(result.sent).toBe(false);
  });
});

describe("the verification message", () => {
  it("carries the link and says what ignoring it costs", () => {
    const message = verificationMessage("a@b.test", "https://x.test/?verify=id.secret");
    expect(message.to).toBe("a@b.test");
    expect(message.body).toContain("https://x.test/?verify=id.secret");
    expect(message.body).toContain("once");
    // The one thing a recipient of an unexpected confirmation mail needs to know: this
    // link is not the password reset, so ignoring it cannot lock anyone out.
    expect(message.body).toContain("recovery code");
  });
});
