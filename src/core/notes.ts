// The notes in a search: each note counts as one more line of its session's
// conversation, so the words of a query find it, `has:note` lists the
// sessions that have any, and the notes sit first among a session's
// matches, the newest first.
import type { SearchOutcome } from "./agents/agent";
import { snippetOf, type SearchHit, type SearchResult, type SnippetSize } from "./history";
import { picked } from "./search";
import type { NoteEntry } from "./sessionRecords";
import { inRange, matchesAll, type Query } from "./terms";

/** A session with notes, as the search sees it. */
export interface NotedSession {
  id: string;
  /** Its notes, oldest first. */
  notes: readonly NoteEntry[];
  /** Where it works, for `project:` and `branch:`. */
  cwd: string;
  branch?: string;
}

/**
 * Adds the notes to a search's results: a session with a note that holds
 * every word gets that note as a match before its messages, listed even
 * when its conversation has none; a query of operators alone shows the
 * notes of each session it lists; `has:note` keeps only the sessions with
 * a note. Each note follows the query's `project:`, `branch:`, `since:` and
 * `before:` like a message does, the times going by when it was written. A
 * note names no files, so with `file:` the notes ride only a session whose
 * conversation touched one. The results given stay as they were.
 */
export function withNotes(outcome: SearchOutcome, noted: Iterable<NotedSession>, query: Query, limit: number, snippet?: SnippetSize): SearchOutcome {
  const sessions = new Map<string, NotedSession>();
  for (const session of noted) if (session.notes.length > 0) sessions.set(session.id, session);
  const results = outcome.results.filter((result) => !query.hasNote || sessions.has(result.id)).map((result) => ({ ...result, hits: [...result.hits] }));
  const byId = new Map(results.map((result) => [result.id, result]));
  const range = { since: query.since, before: query.before };
  const timed = query.since !== undefined || query.before !== undefined;
  const words = query.terms.length > 0;
  /** Sessions `has:note` asked for whose notes all fall outside the times: listed for their messages, they go. */
  const dropped = new Set<string>();
  for (const session of sessions.values()) {
    const listed = byId.get(session.id);
    if (query.files.length > 0 && !listed) continue;
    if ((query.projects.length > 0 || query.branches.length > 0) && !picked(query, session.cwd, session.branch)) continue;
    // The notes that fit: newest first, as the matches read.
    const fitting = [...session.notes].reverse().filter((note) => (!timed || inRange(note.at, range)) && (!words || matchesAll(note.text, query.terms)));
    if (fitting.length === 0) {
      if (query.hasNote && timed && !session.notes.some((note) => inRange(note.at, range))) dropped.add(session.id);
      continue;
    }
    // Operators alone list a session when its conversation fits them, or when the notes are asked for.
    if (!words && !listed && !query.hasNote) continue;
    const hits: SearchHit[] = fitting.map((note) => ({ role: "note", at: note.at, ...(words ? snippetOf(note.text, query.terms, snippet) : { snippet: note.text, ranges: [] }) }));
    if (listed) {
      listed.hits = [...hits, ...listed.hits].slice(0, Math.max(1, limit));
      if (words) listed.count += hits.length;
    } else {
      const result: SearchResult = { id: session.id, count: words ? hits.length : 0, hits: hits.slice(0, Math.max(1, limit)) };
      results.push(result);
      byId.set(session.id, result);
    }
  }
  return { results: dropped.size ? results.filter((result) => !dropped.has(result.id)) : results, pending: outcome.pending };
}
