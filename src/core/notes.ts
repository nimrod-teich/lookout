// The notes in a search: a note counts as one more line of its session's
// conversation, so the words of a query find it, `has:note` lists the
// sessions that have one, and a note sits first among a session's matches.
import type { SearchOutcome } from "./agents/agent";
import { snippetOf, type SearchHit, type SearchResult, type SnippetSize } from "./history";
import { picked } from "./search";
import { inRange, matchesAll, type Query } from "./terms";

/** A session with a note, as the search sees it. */
export interface NotedSession {
  id: string;
  note: string;
  /** Epoch ms the note was written. */
  noteAt?: number;
  /** Where it works, for `project:` and `branch:`. */
  cwd: string;
  branch?: string;
}

/**
 * Adds the notes to a search's results: a session whose note holds every
 * word gets the note as its first match, listed even when its conversation
 * has none; a query of operators alone shows the note of each session it
 * lists; `has:note` keeps only the sessions with a note. The notes follow
 * the query's `project:`, `branch:`, `since:` and `before:` like messages
 * do, the times going by when the note was written. A note names no files,
 * so with `file:` it rides only a session whose conversation touched one.
 * The results given stay as they were.
 */
export function withNotes(outcome: SearchOutcome, noted: Iterable<NotedSession>, query: Query, limit: number, snippet?: SnippetSize): SearchOutcome {
  const notes = new Map<string, NotedSession>();
  for (const session of noted) notes.set(session.id, session);
  const results = outcome.results.filter((result) => !query.hasNote || notes.has(result.id)).map((result) => ({ ...result, hits: [...result.hits] }));
  const byId = new Map(results.map((result) => [result.id, result]));
  const range = { since: query.since, before: query.before };
  const timed = query.since !== undefined || query.before !== undefined;
  const words = query.terms.length > 0;
  /** Sessions `has:note` asked for whose note falls outside the times: listed for their messages, they go. */
  const dropped = new Set<string>();
  for (const session of notes.values()) {
    const listed = byId.get(session.id);
    if (query.files.length > 0 && !listed) continue;
    if ((query.projects.length > 0 || query.branches.length > 0) && !picked(query, session.cwd, session.branch)) continue;
    if (timed && !inRange(session.noteAt, range)) {
      if (query.hasNote) dropped.add(session.id);
      continue;
    }
    if (words && !matchesAll(session.note, query.terms)) continue;
    // Operators alone list a session when its conversation fits them, or when the note is asked for.
    if (!words && !listed && !query.hasNote) continue;
    const hit: SearchHit = { role: "note", at: session.noteAt, ...(words ? snippetOf(session.note, query.terms, snippet) : { snippet: session.note, ranges: [] }) };
    if (listed) {
      listed.hits = [hit, ...listed.hits].slice(0, Math.max(1, limit));
      if (words) listed.count += 1;
    } else {
      const result: SearchResult = { id: session.id, count: words ? 1 : 0, hits: [hit] };
      results.push(result);
      byId.set(session.id, result);
    }
  }
  return { results: dropped.size ? results.filter((result) => !dropped.has(result.id)) : results, pending: outcome.pending };
}
