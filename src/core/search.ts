// Searching an agent's conversations, live and past: the same for every agent.
import type { SearchOutcome } from "./agents/agent";
import type { BackgroundReads } from "./background";
import type { HistoryIndex, SearchResult, SnippetSize } from "./history";
import { projectOf } from "./model";
import type { ConversationStore } from "./store";
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
  /** Its conversation file, when the store may hold it: one the reading thread reads. */
  file?: string;
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
 * The same search, answered from the store for the conversations it holds:
 * one query over their files, and the in-memory index for the rest (a
 * conversation the reading thread has not written yet, or one it never
 * reads). A file the store holds is still read on, in the background or
 * here, so the store follows the conversation; one whose read is still to
 * come counts as pending, so the results are sent again once it is read. A
 * past conversation whose file was last written when it was last read is
 * not looked at again: its listing says so.
 */
export function searchWithStore(conversations: Iterable<Searchable>, parsed: Query, limit: number, budgetMs: number, snippet: SnippetSize | undefined, background: BackgroundReads | undefined, store: ConversationStore): SearchOutcome {
  if (parsed.terms.length === 0 && !hasFilters(parsed)) return { results: [], pending: 0 };
  const range = { since: parsed.since, before: parsed.before };
  const timed = parsed.since !== undefined || parsed.before !== undefined;
  const words = parsed.terms.length > 0;
  const started = Date.now();
  const results: SearchResult[] = [];
  let pending = 0;
  // The conversations the query's times and places pick, with their files.
  const picks: { id: string; past: number | undefined; index: HistoryIndex | undefined; file: string | undefined }[] = [];
  for (const conversation of conversations) {
    const past = conversation.pastModifiedAt;
    if (past !== undefined && parsed.since !== undefined && past + MTIME_SLACK_MS < parsed.since) continue;
    if ((parsed.projects.length > 0 || parsed.branches.length > 0) && !picked(parsed, conversation.cwd, conversation.branch)) continue;
    const index = conversation.index();
    picks.push({ id: conversation.id, past, index, file: conversation.file ?? index?.file });
  }
  const filesOf = () => picks.flatMap((pick) => (pick.file ? [pick.file] : []));
  // One question to the store for every file, not one per conversation.
  const before = store.held(filesOf());
  for (const pick of picks) {
    const { index, file } = pick;
    if (!index) continue;
    // A lean index read once, whose rows the store no longer has (forgotten meanwhile): read again from the start.
    if (index.lean && index.ready && file && !before.has(file)) index.forgetPlace();
    if (index.seenAt(pick.past)) continue;
    // Kept up to date: in the background, which writes the store; or here, through the store, while the budget allows.
    if (background) {
      index.update(background);
      // A read still to come: the results are sent again once it is in.
      if (background.has(index)) pending++;
    } else if (!index.ready || index.changed()) {
      if (Date.now() - started < budgetMs) index.refresh();
      else pending++;
    }
  }
  // Reads here may have brought files into the store: asked again.
  const held = background ? before : store.held(filesOf());
  const stored: { id: string; file: string }[] = [];
  for (const { id, index, file } of picks) {
    if (file && held.has(file)) {
      stored.push({ id, file });
      continue;
    }
    if (!index?.ready || index.lean) continue;
    results.push(...searchIndex(id, index, parsed, limit, snippet, range, timed, words));
  }
  const files = stored.map((s) => s.file);
  const touched = parsed.files.length > 0 ? store.touched(files, parsed.files) : undefined;
  const found = words ? store.search(files, parsed.terms, limit, range, snippet) : undefined;
  const inTime = !words && timed ? store.withMessagesIn(files, range) : undefined;
  for (const { id, file } of stored) {
    if (touched && !touched.has(file)) continue;
    if (found) {
      const result = found.get(file);
      if (result && result.count > 0) results.push({ id, count: result.count, hits: result.hits });
    } else if (!inTime || inTime.has(file)) results.push({ id, count: 0, hits: [] });
  }
  return { results, pending };
}

/** Has a conversation read now, into the store on the way: in the background when there is one, else here. For a transcript about to be kept, so the store holds what it says before the agent deletes it. */
export function readThrough(conversation: Searchable, background: BackgroundReads | undefined): void {
  conversation.index()?.update(background);
}

/** What one in-memory index gives a search; empty when it holds no match. */
function searchIndex(id: string, index: HistoryIndex, parsed: Query, limit: number, snippet: SnippetSize | undefined, range: { since?: number; before?: number }, timed: boolean, words: boolean): SearchResult[] {
  if (parsed.files.length > 0 && !index.touched(parsed.files)) return [];
  if (words) {
    const { count, hits } = index.search(parsed.terms, limit, range, snippet);
    return count > 0 ? [{ id, count, hits }] : [];
  }
  return !timed || index.hasMessageIn(range) ? [{ id, count: 0, hits: [] }] : [];
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
