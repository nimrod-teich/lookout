// VS Code's chat sessions, as it saves them: one file per session,
// `<user data>/workspaceStorage/<workspace id>/chatSessions/<session id>.jsonl`,
// a log of changes to the session object. Each line is one of:
//
// - `{ kind: 0, v }`: the whole session, `{ version, sessionId, creationDate,
//   customTitle?, requests[], inputState, … }`;
// - `{ kind: 1, k, v }`: the value at path `k` (keys and indexes) becomes `v`;
// - `{ kind: 2, k, v?, i? }`: the array at `k` is cut to length `i`, when
//   given, and `v`'s items appended.
//
// VS Code writes the changes when it saves its state, about once a minute,
// and when a session is closed: what the file says can be a minute old.

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A chat session's object, rebuilt from its log. */
export interface ChatLog {
  root?: { [key: string]: Json };
}

function isObject(value: unknown): value is { [key: string]: Json } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The container holding the last key of `path`, made on the way when missing. */
function parentOf(root: { [key: string]: Json }, path: readonly (string | number)[]): { [key: string]: Json } | Json[] | undefined {
  let at: Json = root;
  for (let index = 0; index < path.length - 1; index++) {
    const key = path[index]!;
    const next: Json | undefined = Array.isArray(at) ? at[Number(key)] : isObject(at) ? at[String(key)] : undefined;
    if (next === undefined || next === null || typeof next !== "object") {
      const made: Json = typeof path[index + 1] === "number" ? [] : {};
      if (Array.isArray(at)) at[Number(key)] = made;
      else if (isObject(at)) at[String(key)] = made;
      else return undefined;
      at = made;
    } else {
      at = next;
    }
  }
  return Array.isArray(at) || isObject(at) ? at : undefined;
}

/** Applies one line of a session's log. Lines that are not changes are skipped. */
export function applyChatLine(log: ChatLog, line: string): void {
  if (line.length === 0) return;
  let change: { kind?: unknown; k?: unknown; v?: unknown; i?: unknown };
  try {
    change = JSON.parse(line) as typeof change;
  } catch {
    return;
  }
  if (!change || typeof change !== "object") return;
  if (change.kind === 0) {
    if (isObject(change.v)) log.root = change.v;
    return;
  }
  const path = Array.isArray(change.k) ? (change.k as unknown[]).filter((key): key is string | number => typeof key === "string" || typeof key === "number") : undefined;
  if (!log.root || !path || path.length === 0) return;
  const parent = parentOf(log.root, path);
  if (!parent) return;
  const last = path[path.length - 1]!;
  if (change.kind === 1) {
    if (Array.isArray(parent)) parent[Number(last)] = change.v as Json;
    else parent[String(last)] = change.v as Json;
    return;
  }
  if (change.kind === 2) {
    const current = Array.isArray(parent) ? parent[Number(last)] : parent[String(last)];
    const array: Json[] = Array.isArray(current) ? current : [];
    if (typeof change.i === "number" && change.i >= 0) array.length = Math.min(array.length, change.i);
    if (Array.isArray(change.v)) array.push(...(change.v as Json[]));
    if (Array.isArray(parent)) parent[Number(last)] = array;
    else parent[String(last)] = array;
  }
}
