/**
 * Practice, remembered.
 *
 * `useListening` grades one pass. This keeps them, so the app can answer the questions
 * a single pass cannot: which bars do I keep failing, how fast can I actually play this,
 * and what should I work on today.
 *
 * The analysis is in `packages/core/src/practice.ts` and is pure. What is here is the
 * part that has to touch a database and a clock: loading a score's takes, writing one
 * when a pass ends, and holding the summary for the UI.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { summarise, type ListenReport, type PracticeSummary, type Take, type TakeBar } from "@cubscore/core";
import { clearTakes, listTakes, newId, putTake, libraryOwner, type StoredTake } from "../library/db";

export interface PracticeController {
  /** Null until the first load finishes, so the UI can tell empty from unknown. */
  summary: PracticeSummary | null;
  /** Stores a finished pass. Ignores one that graded nothing. */
  record: (report: ListenReport, context: { trackIndex: number; trackName: string; bpm: number }) => void;
  /** Forgets this score's history. The only way to reset a tempo record. */
  clear: () => void;
}

/** A report's per-bar counts, in the shape the analysis reads. */
function barsOf(report: ListenReport): TakeBar[] {
  return report.bars.map((b) => ({
    bar: b.bar,
    clean: b.clean,
    early: b.early,
    late: b.late,
    wrongPitch: b.wrongPitch,
    missed: b.missed,
    unverified: b.unverified,
    timingSeconds: b.timingSeconds,
  }));
}

function takeOf(row: StoredTake): Take {
  let bars: TakeBar[] = [];
  try {
    bars = JSON.parse(row.bars) as TakeBar[];
  } catch {
    // A row written by a future version, or a corrupted one. A take that cannot be
    // read contributes nothing rather than taking the whole history down with it.
  }
  return { at: row.at, bpm: row.bpm, bars };
}

export function usePracticeHistory(scoreId: string | null): PracticeController {
  const [rows, setRows] = useState<StoredTake[] | null>(null);

  useEffect(() => {
    if (!scoreId) {
      setRows(null);
      return;
    }
    let live = true;
    // Cleared first: without it, switching pieces shows the previous one's history
    // against the new one's bars until the read returns, which is a report about a
    // score the user is not looking at.
    setRows(null);
    void listTakes(scoreId).then((found) => {
      if (live) setRows(found);
    });
    return () => {
      live = false;
    };
  }, [scoreId]);

  const record = useCallback(
    (report: ListenReport, context: { trackIndex: number; trackName: string; bpm: number }) => {
      // A pass that judged nothing is not a take. Storing it would put a row in the
      // history for every time somebody pressed play with the microphone on and did
      // not play, and every one of those would dilute the record.
      if (!scoreId || report.judged === 0) return;
      const row: StoredTake = {
        id: newId(),
        scoreId,
        ownerId: libraryOwner(),
        at: Date.now(),
        trackIndex: context.trackIndex,
        trackName: context.trackName,
        bpm: context.bpm,
        bars: JSON.stringify(barsOf(report)),
        accuracy: report.accuracy,
        judged: report.judged,
      };
      // Shown immediately and written behind it: a take the user just played appearing
      // a second later would read as the app having missed it.
      setRows((current) => [...(current ?? []), row]);
      void putTake(row).catch(() => undefined);
    },
    [scoreId],
  );

  const clear = useCallback(() => {
    if (!scoreId) return;
    setRows([]);
    void clearTakes(scoreId).catch(() => undefined);
  }, [scoreId]);

  const summary = useMemo(() => (rows === null ? null : summarise(rows.map(takeOf))), [rows]);

  return { summary, record, clear };
}
