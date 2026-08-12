/**
 * Sending mail without depending on anyone's mail service.
 *
 * The recovery code exists because an account system on sovereign infrastructure should
 * not need somebody else's SMTP to give a user their account back (see auth.ts). Email
 * verification cannot be held to quite that standard — proving an address owns itself
 * requires sending to it — so the rule here is the weaker one that keeps the promise:
 * nothing in this file knows what a mail provider is. It composes a message and hands it
 * to whatever the operator configured, which is either a file on disk or a command on
 * the box.
 *
 * There is deliberately no SMTP client and no provider SDK. Adding one means a
 * dependency, an API key in the deployment, and an outbound connection to a third party
 * on every signup. `MAIL_TRANSPORT=command` with sendmail, msmtp or ssmtp covers the same
 * ground using the machine's own mail configuration, and an operator who wants a provider
 * points that command at the provider's own CLI.
 *
 * If a provider SDK is ever wanted, `deliver` is the whole seam: one function, one case
 * in one switch.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export interface Message {
  to: string;
  subject: string;
  body: string;
}

export type MailTransport = "file" | "command";

export interface MailConfig {
  transport: MailTransport;
  /** Where `file` writes. Ignored by `command`. */
  spoolDir: string;
  /** argv for `command`, already split. Empty means the transport cannot run. */
  command: string[];
  from: string;
}

/**
 * The origin links are built from, or null if verification is switched off.
 *
 * Deliberately an environment variable and never the request's Host header. Host is
 * whatever the client sent: an attacker who can reach the API can ask it to email a
 * victim a verification link pointing at the attacker's own host, and the victim's click
 * then lands somewhere hostile carrying a token for their account. There is no way to
 * validate a Host against nothing, so the trusted origin has to be stated once by the
 * operator. No PUBLIC_URL, no link, no verification — which is why the feature is off by
 * default rather than half-working.
 */
export function publicOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.PUBLIC_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // Origin only: a path here would be silently concatenated into every link.
    return url.origin;
  } catch {
    return null;
  }
}

export function mailConfig(dataDir: string, env: NodeJS.ProcessEnv = process.env): MailConfig {
  const transport: MailTransport = env.MAIL_TRANSPORT === "command" ? "command" : "file";
  const origin = publicOrigin(env);
  const host = origin ? new URL(origin).hostname : "localhost";
  return {
    transport,
    spoolDir: path.join(dataDir, "mail"),
    // Whitespace split, and no shell. A shell here would make MAIL_COMMAND an
    // injection surface for anything that ever reaches it from outside.
    command: (env.MAIL_COMMAND ?? "").trim().split(/\s+/).filter(Boolean),
    from: env.MAIL_FROM ?? `cubscore@${host}`,
  };
}

/**
 * An RFC 5322 message, as bytes.
 *
 * Headers are checked for CR and LF rather than trusted. The address reaching here has
 * been through `normalizeEmail`, which rejects whitespace and therefore newlines, so this
 * cannot currently fire — but header injection is one careless caller away from turning a
 * subject line into a Bcc, and a guard that costs a regex should not depend on a
 * validator two files away staying strict.
 */
export function compose(message: Message, from: string): string {
  for (const [name, value] of [
    ["to", message.to],
    ["from", from],
    ["subject", message.subject],
  ]) {
    if (/[\r\n]/.test(value as string)) throw new Error(`illegal newline in ${name}`);
  }
  const headers = [
    `From: ${from}`,
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@cubscore>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
  ];
  // CRLF between headers and in the separator, which is what a mail transport expects;
  // the body keeps whatever newlines it was written with.
  return `${headers.join("\r\n")}\r\n\r\n${message.body}\r\n`;
}

/**
 * Hands a composed message to the configured transport.
 *
 * Resolves with what happened rather than throwing, because a signup must not fail
 * because the mail did not go out: the account exists either way and the user can ask for
 * another link. The caller logs the failure.
 */
export async function deliver(
  message: Message,
  config: MailConfig,
): Promise<{ sent: boolean; detail: string }> {
  const raw = compose(message, config.from);
  if (config.transport === "command") {
    if (config.command.length === 0) {
      return { sent: false, detail: "MAIL_TRANSPORT=command but MAIL_COMMAND is empty" };
    }
    return new Promise((resolve) => {
      const [bin, ...args] = config.command;
      const child = spawn(bin as string, args, { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d) => {
        stderr += String(d);
      });
      child.on("error", (e) => resolve({ sent: false, detail: e.message }));
      child.on("close", (code) =>
        resolve(
          code === 0
            ? { sent: true, detail: config.command.join(" ") }
            : { sent: false, detail: `exit ${code}: ${stderr.slice(0, 200)}` },
        ),
      );
      child.stdin.end(raw);
    });
  }

  // The file transport. Not a fallback that pretends to have sent something: the message
  // is on disk where an operator can read it, which is exactly what a single-machine
  // deployment with no mail configured should do. Written under the data directory
  // because it contains a live token, so it belongs wherever the account data's
  // permissions and backups already apply.
  await mkdir(config.spoolDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safe = message.to.replace(/[^a-z0-9@._-]/gi, "_");
  const file = path.join(config.spoolDir, `${stamp}-${safe}.eml`);
  await writeFile(file, raw, { mode: 0o600 });
  return { sent: true, detail: file };
}

export function verificationMessage(to: string, link: string): Message {
  return {
    to,
    subject: "Confirm your CubScore email address",
    body: [
      "Confirm this address is yours:",
      "",
      link,
      "",
      "The link works once and expires in 24 hours.",
      "",
      "If you did not create a CubScore account, nothing happens if you ignore this.",
      "Your recovery code is what resets your password; this link only confirms the",
      "address, so ignoring it leaves no account you can be locked out of.",
      "",
    ].join("\n"),
  };
}
