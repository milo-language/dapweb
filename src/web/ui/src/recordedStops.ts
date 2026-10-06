// The stop timeline: journal rows (/api/log?kind=stopped&dir=out) turned into
// what the Timeline tab lists. Pure, so tests/recordedstops.ts and the e2e read the
// same parse the tab does.
import type { Frame, Var } from "./session";

export type By = "agent" | "user";
export type RecordedStop = {
  seq: number; at: number;
  reason: string; atMain: boolean;
  path: string; line: number;
  by: By; who: string;
  // null when the stored payload is not whole JSON (a journal row is capped,
  // and a row from before stops were stored whole may be a prefix).
  frames: Frame[] | null; locals: Var[] | null;
};

// The /api/log query the tab and the README both name. Bounded: the tab is a
// recent history, and the journal itself is the full record.
export const TIMELINE_LIMIT = 200;
export const timelineQuery = (since = 0) =>
  `/api/log?kind=stopped&dir=out&limit=${TIMELINE_LIMIT}${since > 0 ? `&since=${since}` : ""}`;

// A truncated row still begins with the scalar fields (stoppedMsg writes them
// before frames), so the reason survives when the arrays do not.
const field = (text: string, key: string) => {
  const m = text.match(new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`));
  return m ? m[1] : "";
};

export function parseStopRow(row: any): RecordedStop {
  const text: string = typeof row.payload === "string" ? row.payload : "";
  let doc: any = null;
  if (!row.truncatedFrom) { try { doc = JSON.parse(text); } catch {} }
  // The journal promotes `by` into the peer column; the payload is the fallback
  // for a row written before it did.
  const by: By = (row.peer || doc?.by || field(text, "by")) === "agent" ? "agent" : "user";
  return {
    seq: row.seq ?? 0, at: row.at ?? 0,
    reason: doc?.reason ?? field(text, "reason"),
    atMain: doc?.atMain === true,
    path: row.path ?? doc?.path ?? "", line: row.line ?? doc?.line ?? 0,
    by, who: row.who || doc?.who || "",
    frames: Array.isArray(doc?.frames) ? doc.frames : null,
    locals: Array.isArray(doc?.locals) ? doc.locals : null,
  };
}

// Newest first, which is how the tab lists them; /api/log answers oldest first.
export const parseStopRows = (rows: any[]): RecordedStop[] => rows.map(parseStopRow).reverse();

// New rows from an incremental fetch go on top; a row already held (a refetch
// that overlapped) is not listed twice. Capped to the same bound as the query.
export function mergeStops(held: RecordedStop[], fresh: RecordedStop[]): RecordedStop[] {
  const have = new Set(held.map((s) => s.seq));
  return [...fresh.filter((s) => !have.has(s.seq)), ...held].sort((a, b) => b.seq - a.seq).slice(0, TIMELINE_LIMIT);
}
