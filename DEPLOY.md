# Deploying CubScore

Three processes behind one hostname. The two node services carry no TLS and expect a
reverse proxy in front of them.

| | what it is | listens | state |
| --- | --- | --- | --- |
| `apps/web/dist` | static files, built by Vite | nothing — the proxy serves it | none |
| `services/api` | Fastify: accounts, cloud library, share links | `:8787` | files under `CUBSCORE_DATA` |
| `services/sync` | websockets: collab rooms | `:8788` | memory only |

## One origin, and why it is not optional

The page asks for `/api` and `/ws` as relative paths, and the session cookie is
`SameSite=Lax`. Put the API on a second hostname and the browser stops sending the
cookie, so every request arrives unauthenticated and the app looks like it signs you
out at random. `deploy/nginx.conf` is the shape that works; `apps/web/vite.config.ts`
does the same thing with a dev proxy.

## Environment

Every variable either service reads. There are no others.

| variable | service | default | set it to |
| --- | --- | --- | --- |
| `PORT` | both | `8787` / `8788` | whatever the proxy points at |
| `HOST` | both | `127.0.0.1` | `0.0.0.0` **in a container**, otherwise leave it |
| `CUBSCORE_DATA` | api | `services/api/data` | a path on the volume you back up |
| `TRUST_PROXY` | api | off | `1`, if and only if a proxy you control is the only way in |
| `COOKIE_SECURE` | api | off | `1`, and only when the proxy really terminates TLS |
| `PUBLIC_URL` | api | unset | the origin users type, e.g. `https://score.example.com` — this is also the switch for email verification |
| `MAIL_TRANSPORT` | api | `file` | `command` to hand messages to a real mailer |
| `MAIL_COMMAND` | api | unset | e.g. `/usr/sbin/sendmail -t -i`, required by `MAIL_TRANSPORT=command` |
| `MAIL_FROM` | api | `cubscore@<PUBLIC_URL host>` | an address your domain is allowed to send as |

Four of the first five are ways to ship something broken, so each one earns a paragraph.

**`HOST`.** The default is loopback because these services have no TLS: a default that
listened on every interface would put session cookies in clear text the first time
someone ran it on a box with a public address. Inside a container that default is wrong
in the other direction — a container's loopback is its own, so the service comes up
healthy and answers nobody. Set `0.0.0.0` there and never publish the port.

**`CUBSCORE_DATA`.** Accounts, password hashes, recovery-code hashes, sessions, shared
scores and cloud libraries, as files. If this is not on a volume, a redeploy deletes
every account.

**`TRUST_PROXY=1`.** Means "trust exactly one hop, and take the address that hop
appended". Without it every request appears to come from the proxy, so all users share
one rate-limit bucket and one busy client locks out everyone else. It requires the proxy
to append the real peer — `X-Forwarded-For $proxy_add_x_forwarded_for`. Do not set it if
the service is reachable directly, because then the header is whatever a client typed.

**`COOKIE_SECURE=1`.** Correct behind TLS and fatal without it: the browser drops a
`Secure` cookie on a plain-HTTP origin, so nobody can stay signed in and the symptom
looks like broken login rather than a missing flag. `pnpm deploycheck` asserts both
directions of this.

## Email verification, and how to send mail without a mail provider

Verification is **off until `PUBLIC_URL` is set**, and that is a security decision rather
than a convenience one. A confirmation link needs an origin, and the only other place to
get one is the request's `Host` header — which is whatever the client sent. Anyone able to
reach the API could then ask it to mail a victim a link pointing at a host of the
attacker's choosing, carrying a live token for the victim's account. There is nothing to
validate a `Host` against, so the trusted origin has to be stated once, by you. No
`PUBLIC_URL`, no link, no verification, and the client is told so and stays quiet about it
rather than nagging every user to click something that cannot be sent.

Two transports, and neither is a mail provider:

- **`file`** (default) writes each message as an `.eml` under `$CUBSCORE_DATA/mail`, mode
  0600. Not a stub that pretends to have sent something — on a single-machine deployment
  with no mail configured, a spool an operator can read is the honest behaviour, and it is
  the same path `pnpm e2e verify-email` drives. The files contain live tokens, which is why
  they sit inside the data directory where its permissions and backups already apply.
- **`command`** pipes an RFC 5322 message to `MAIL_COMMAND` on stdin — `sendmail -t`,
  `msmtp -t`, `ssmtp`, or a provider's own CLI. Argv is split on whitespace and run
  without a shell.

There is deliberately no SMTP client and no provider SDK. That would mean a dependency, an
API key in the deployment, and an outbound connection to a third party on every signup.
`deliver` in `services/api/src/mail.ts` is the whole seam if one is ever wanted: one
function, one case in one switch.

**What verification does and does not do.** It proves an address is reachable. It does not
gate anything: an unverified account works completely, and the panel says so in as many
words. That is deliberate — gating function on a flag that depends on the operator's mail
configuration would let one missing environment variable lock out every real user. A
forgotten password is still reset with the recovery code, never by email, so a
verification mail that never arrives cannot lock anyone out of anything.

## The container path

```
docker compose -f deploy/compose.yml up -d --build
```

`deploy/compose.yml` runs the app image twice, once per service, with an nginx in front
and a one-shot container that copies the static bundle into the volume nginx serves.
Terminate TLS in `deploy/nginx.conf` — with certbot, or by swapping nginx for Caddy,
which will do it unprompted.

**This path is not verified by any gate in this repo.** No runner here has a Docker
daemon, so `deploy/Dockerfile` has never been built. Watch the first build. What *is*
verified is the part most likely to be wrong, described below.

## The plain-node path

No Docker, one machine, systemd or a supervisor of your choice:

```
pnpm install --frozen-lockfile
pnpm build                       # apps/web/dist and both services' dist
pnpm install --prod              # optional: drops devDependencies
CUBSCORE_DATA=/var/lib/cubscore COOKIE_SECURE=1 TRUST_PROXY=1 \
  node services/api/dist/server.js
node services/sync/dist/server.js
```

Leave `HOST` unset here. Both services bind loopback, the proxy reaches them there, and
nothing else can.

Point a proxy at them using `deploy/nginx.conf` as the reference: it carries the two
settings that are easy to miss and break a specific feature each. `client_max_body_size
24m`, because a Guitar Pro import posts the file and nginx's 1 MB default rejects it
with a 413 the app cannot report on — it reads as a broken importer. And an hour-long
read timeout on `/ws`, because a collab session is idle whenever nobody is typing, and
the default 60s closes an idle upgrade. Rooms live in the sync process's memory, so a
dropped socket is a dropped session.

## What `pnpm deploycheck` proves

```
pnpm build && pnpm deploycheck
```

It runs the compiled `dist/server.js` of each service under plain `node`, with the
environment above, and checks the packaging rather than the behaviour — `pnpm e2e`
covers behaviour, against the same code.

- The artifacts exist. Until recently they did not: both services' `build` script was
  `tsc --noEmit`, so `pnpm build` proved the code compiled and produced nothing to ship,
  and deploying meant running `tsx` — a devDependency, absent from `pnpm install --prod`.
- Nothing in the compiled output imports a package that is not a production dependency.
  This is what makes `pnpm install --prod` and the runtime image safe. A devDependency
  reaching production code is invisible in dev, where the whole tree is installed, and
  fails at `ERR_MODULE_NOT_FOUND` on the deployment.
- `HOST` actually moves the socket, asserted by binding a loopback alias and proving
  nothing answers on another one. The API used to hard-code `127.0.0.1`.
- The session cookie carries `Secure` with `COOKIE_SECURE=1` **and does not without it**.
  Both directions, because a check that only looked for `Secure` would still pass against
  a hard-coded one, and the flag would be a promise an operator trusts.
- The compiled sync service completes a real websocket handshake, admits a valid room
  with a state frame, and closes an invalid one with 4000.
- The web bundle has no dev origin baked into it, which would send a browser on a real
  domain to `127.0.0.1`.

Each of those was confirmed to fail when the thing it describes was broken on purpose.

## Backups

One directory: `CUBSCORE_DATA`. Files, written by rename, so a copy taken while the
service runs is consistent per file. `tar` it on a schedule and test a restore by
pointing a second instance at the copy — an untested backup is a hope.

The sync service has nothing to back up. Restarting it ends every live collab session,
which is why `compose.yml` uses `restart: unless-stopped` rather than `always`: a crash
loop that silently drops rooms is worse than a service that stays down and is noticed.

## Upgrades

Rebuild, restart the API, restart sync when no session is live. Accounts written before
the email index existed are indexed once at boot, logged, and idempotent, so rolling
forward needs no migration step.

## Known limits, before this is public

Not deployment problems, but decide about them rather than discover them.

- **A registration can still claim someone else's email.** Verification exists now, but it
  is proof rather than enforcement: the first account to register an address holds it
  whether or not it ever confirms, so squatting is possible and the real owner sees "an
  account with this email already exists". Closing that means letting a *verified*
  registration displace an unverified, empty holder — which makes account lifetime depend
  on the mail configuration, and is a policy decision rather than a default. Not built on
  purpose; needs a deliberate call.
- **A lost recovery code is still a lost account.** Recovery codes remain the only reset
  path (`services/api/src/auth.ts`), which is deliberate — no reset email to forge — and
  confirming an address does not add a second one.
- **Rate limits live in one process's memory.** Correct for a single API instance and
  wrong the moment there are two: each gets its own counters, so the effective limit
  multiplies. Run one, or move the buckets out.
- **The store is files, not a database.** Fine for one machine and the current per-owner
  caps (2,000 entries, 2 GB). It does not survive two API instances sharing a volume.
- **Editing a large score is slow.** A keystroke on a 274-bar transcription costs
  seconds, not the 100ms budget `pnpm editperf` holds it to. The ceiling is alphaTab, it
  is measured, and STANDALONE.md §3 has the numbers and the plan. Small scores are fine.
- **Collab rooms are memory-only.** No persistence, one process, no horizontal scale.
