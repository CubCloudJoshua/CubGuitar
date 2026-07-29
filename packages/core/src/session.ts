/**
 * The ordering rule for a live editing session.
 *
 * convergence.test.ts establishes that the outcome of two conflicting edits is
 * decided purely by the order they are applied in. That leaves one job: making
 * sure every client applies them in the *same* order. Each client applying its
 * own edit first and everyone else's second is not the same order, and it is
 * what a naive optimistic client does — two people who edit the same note at
 * the same moment then keep two different documents forever, with a third
 * answer waiting for whoever joins next and replays the server's log.
 *
 * So the server's arrival order is the document's order, and a client's own
 * edits are provisional until they come back with a place in that order:
 *
 *   what the user sees  =  confirmed  +  our batches the server has not
 *                                        acknowledged yet
 *
 * Typing stays instant because pending batches show immediately. Convergence
 * holds because `confirmed` only ever advances through the server's sequence,
 * which is identical for everyone, and pending always drains. This is the
 * groundwork the CRDT layer in PLAN.md replaces, not a stand-in for it: it
 * needs a live connection and offers no offline merge.
 */
import { applyBatch } from "./apply.js";
import type { Score } from "./score.js";
import type { OpBatch } from "./ops.js";

export interface Session {
  /** The document as the server has ordered it. Never advanced locally. */
  confirmed: Score;
  /** Sent, not yet acknowledged. Replayed over confirmed to build the view. */
  pending: OpBatch[];
}

/**
 * Starts a session from a document: the one on screen when a session opens, or
 * the snapshot a joiner is handed. Nothing pending carries across, because it
 * was written against a document that is no longer the one being edited.
 */
export function beginSession(score: Score): Session {
  return { confirmed: score, pending: [] };
}

/** What the user sees: server truth with our unacknowledged work on top. */
export function sessionView(session: Session): Score {
  return session.pending.reduce(applyBatch, session.confirmed);
}

/**
 * Records a batch this client just sent. Batches that changed nothing locally
 * are kept too, because the acknowledgement is matched by id and dropping one
 * here would leave it pending forever.
 */
export function localCommit(session: Session, batch: OpBatch): Session {
  if (session.pending.some((b) => b.id === batch.id)) return session;
  return { confirmed: session.confirmed, pending: [...session.pending, batch] };
}

/**
 * Takes a batch the server has ordered, from anyone including this client.
 *
 * Duplicate delivery is safe, but only because the inserts check for their own
 * id before splicing. Without that, a redelivered `beat.insert` produced a
 * second beat carrying the identical id, and two elements sharing an id make
 * every op that addresses it ambiguous — the document is corrupt from then on.
 * Retiring an already-retired batch changes nothing.
 */
export function serverBatch(session: Session, batch: OpBatch): Session {
  const confirmed = applyBatch(session.confirmed, batch);
  const pending = session.pending.filter((b) => b.id !== batch.id);
  // Same identity when nothing moved, matching applyOp's contract, so callers
  // can use reference equality to skip a re-render or a save.
  if (confirmed === session.confirmed && pending.length === session.pending.length) return session;
  return { confirmed, pending };
}
