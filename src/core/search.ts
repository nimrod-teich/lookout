// Searching an agent's conversations, live and past: the same for every agent.
import type { SearchOutcome } from "./agents/agent";
import type { BackgroundReads } from "./background";
import type { HistoryIndex, SearchResult, SnippetSize } from "./history";
import { projectOf } from "./model";
import { hasFilters, type Query } from "./terms";

/** A message is stamped before its line is written, so it is never newer than the file; a second covers rounding. */
const MTIME_SLACK_MS = 1_000;

/** One conversation the search may read. */
export interface Searchable {
  id: string;
  /** Epoch ms its file was last written, for a past one: one last written before a `since:` holds nothing after it. */
  pastModifiedAt?: number;
  /** Where it works, for `project:` and `branch:`. */
  cwd: string;
  branch?: string;
  /** Its messages, read on the first search; undefined while its file is not known. */
  index(): HistoryIndex | undefined;
}

/** The session's project and branch fit the query's `project:` and `branch:`, any of their values. */
export function picked(query: Query, cwd: string, branch: string | undefined): boolean {
  if (query.projects.length > 0) {
    const { project, worktree } = projectOf(cwd);
    const names = [project, worktree ?? ""].map((name) => name.toLowerCase());
    if (!query.projects.some((part) => names.some((name) => name.includes(part)))) return false;
  }
  if (query.branches.length > 0) {
    const lower = branch?.toLowerCase();
    if (!lower || !query.branches.some((part) => lower.includes(part))) return false;
  }
  return true;
}

/**
 * The words in the messages written within the query's times, of the
 * conversations its `project:`, `branch:` and `file:` pick. Each conversation
 * is read into memory on its first search, then only what was appended. With
 * `background`, the reads happen there, in the order given (live sessions
 * first), and a conversation not read yet counts as pending; without, a first
 * read happens here only while the budget allows. A query of operators alone
 * lists the conversations they pick, without matches.
 */
export function searchConversations(conversations: Iterable<Searchable>, parsed: Query, limit: number, budgetMs: number, snippet?: SnippetSize, background?: BackgroundReads): SearchOutcome {
  if (parsed.terms.length === 0 && !hasFilters(parsed)) return { results: [], pending: 0 };
  const range = { since: parsed.since, before: parsed.before };
  const timed = parsed.since !== undefined || parsed.before !== undefined;
  const started = Date.now();
  const results: SearchResult[] = [];
  let pending = 0;
  for (const conversation of conversations) {
    const past = conversation.pastModifiedAt;
    if (past !== undefined && parsed.since !== undefined && past + MTIME_SLACK_MS < parsed.since) continue;
    if ((parsed.projects.length > 0 || parsed.branches.length > 0) && !picked(parsed, conversation.cwd, conversation.branch)) continue;
    const index = conversation.index();
    if (!index) continue;
    if (background) {
      index.update(background);
      if (!index.ready) {
        // A file that could not be looked at is not waited for.
        if (background.has(index)) pending++;
        continue;
      }
    } else {
      if (!index.ready && Date.now() - started >= budgetMs) {
        pending++;
        continue;
      }
      index.refresh();
    }
    if (parsed.files.length > 0 && !index.touched(parsed.files)) continue;
    if (parsed.terms.length > 0) {
      const { count, hits } = index.search(parsed.terms, limit, range, snippet);
      if (count > 0) results.push({ id: conversation.id, count, hits });
    } else if (!timed || index.hasMessageIn(range)) results.push({ id: conversation.id, count: 0, hits: [] });
  }
  return { results, pending };
}

/**
 * Has `background` read the conversations the search covers, before anyone
 * searches: those of the live sessions, as they go on, and every past one
 * once.
 */
export function readConversationsAhead(conversations: Iterable<Searchable>, background: BackgroundReads): void {
  for (const conversation of conversations) {
    const index = conversation.index();
    if (index && (conversation.pastModifiedAt === undefined || !index.ready)) index.update(background);
  }
}
