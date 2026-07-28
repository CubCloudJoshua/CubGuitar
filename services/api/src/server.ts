/**
 * CubScore API, v0: share links.
 *
 * POST /api/scores     store a score, get a share id
 * GET  /api/scores/:id fetch a shared score
 * GET  /api/health     liveness
 *
 * No accounts yet; share ids are unguessable capability URLs. Accounts and
 * ownership land next and gate creation, not reads of existing links.
 */
import Fastify from "fastify";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileStore, newShareId, type SharedScore } from "./store.js";

const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR =
  process.env.CUBSCORE_DATA ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");

/** ~16 MB of base64 fits comfortably; real .gp files are far smaller. */
const MAX_BODY = 24 * 1024 * 1024;
const MAX_TEX = 2 * 1024 * 1024;
const MAX_TEXT_FIELD = 500;

const store = new FileStore(DATA_DIR);
const app = Fastify({ bodyLimit: MAX_BODY });

interface CreateBody {
  title?: unknown;
  artist?: unknown;
  format?: unknown;
  tex?: unknown;
  bytesB64?: unknown;
}

app.post("/api/scores", async (request, reply) => {
  const body = (request.body ?? {}) as CreateBody;

  const format = body.format === "gp" || body.format === "altex" ? body.format : null;
  const tex = typeof body.tex === "string" ? body.tex : null;
  const bytesB64 = typeof body.bytesB64 === "string" ? body.bytesB64 : null;

  if (!format || (tex === null && bytesB64 === null)) {
    return reply.status(400).send({ error: "format and one of tex/bytesB64 are required" });
  }
  if (tex !== null && tex.length > MAX_TEX) {
    return reply.status(413).send({ error: "tex too large" });
  }
  if (bytesB64 !== null && !/^[A-Za-z0-9+/=]*$/.test(bytesB64)) {
    return reply.status(400).send({ error: "bytesB64 is not base64" });
  }

  const record: SharedScore = {
    id: newShareId(),
    title: typeof body.title === "string" ? body.title.slice(0, MAX_TEXT_FIELD) : "Untitled",
    artist: typeof body.artist === "string" ? body.artist.slice(0, MAX_TEXT_FIELD) : "",
    format,
    tex,
    bytesB64,
    createdAt: Date.now(),
  };
  await store.put(record);
  return { id: record.id };
});

app.get<{ Params: { id: string } }>("/api/scores/:id", async (request, reply) => {
  const record = await store.get(request.params.id);
  if (!record) return reply.status(404).send({ error: "not found" });
  return record;
});

app.get("/api/health", async () => ({ ok: true }));

app
  .listen({ port: PORT, host: "127.0.0.1" })
  .then(() => console.log(`cubscore api on :${PORT}, data in ${DATA_DIR}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
