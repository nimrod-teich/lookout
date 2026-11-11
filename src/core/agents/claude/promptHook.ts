// Answering a prompt of a session in the Claude Code panel from its card.
// The panel takes no keys from outside, so Lookout answers through a
// Claude Code hook, only once the user turns it on: a `PermissionRequest`
// hook runs beside the prompt the panel shows, and whichever answers first,
// the panel or the hook, is the answer. The hook leaves its prompt in a
// folder as a file and waits for Lookout to put an answer beside it; the
// panel's answer ends it. Outside the panel, and with no Lookout window
// open, it ends at once and changes nothing.
import * as fs from "node:fs";
import * as path from "node:path";
import { updateUserSettings, type RetentionWrite } from "./retention";

/** Lookout's folder in the config directory: the hook script, the prompts waiting, and the mark that a window runs. */
export const HOOK_FOLDER = "lookout";
const SCRIPT = "answer-prompt.sh";
const ASKS = "asks";
const ALIVE = "alive";
/** The hook event: Claude Code runs it beside every permission prompt and question it shows. */
export const HOOK_EVENT = "PermissionRequest";
/** How long Claude Code lets the hook wait, in seconds: a prompt can wait for hours. */
export const HOOK_TIMEOUT_S = 86_400;
/** A Lookout window marks that it runs this often; the hook waits only while the mark is under two minutes old. */
export const ALIVE_EVERY_MS = 30_000;
/** A waiting hook marks its prompt this often; one unmarked for longer has ended without clearing it. */
const ASK_STALE_MS = 15_000;

/**
 * The hook script. It runs for the VS Code panel only, and only while a
 * Lookout window has marked that it runs; else it ends at once, which
 * Claude Code takes as no answer. It writes the prompt Claude Code sends
 * it, waits for Lookout's answer beside it, prints the answer and ends.
 * Claude Code ends it when the panel answers first; it clears its files
 * then, and Lookout clears those of a hook ended harder.
 */
export const HOOK_SCRIPT = `#!/bin/sh
# Lookout (a VS Code extension) answers a Claude Code prompt from the session's card on its board.
# Runs for sessions in the Claude Code panel only, while a Lookout window is open; otherwise it ends at once
# and Claude Code shows its prompt as always. Turned off and removed by the setting lookout.answers.panelSessions.
here=$(dirname "$0")
if [ "$CLAUDE_CODE_ENTRYPOINT" != "claude-vscode" ] || [ -z "$(find "$here/${ALIVE}" -mmin -2 2>/dev/null)" ]; then
  cat >/dev/null
  exit 0
fi
ask="$here/${ASKS}/$$.json"
reply="$here/${ASKS}/$$.reply.json"
trap 'rm -f "$ask" "$ask.part" "$reply"' EXIT
trap 'exit 0' HUP INT TERM
cat >"$ask.part" && mv "$ask.part" "$ask" || exit 0
i=0
while [ -f "$ask" ]; do
  if [ -f "$reply" ]; then
    cat "$reply"
    exit 0
  fi
  i=$((i + 1))
  if [ $((i % 25)) -eq 0 ]; then
    # Claude Code went without ending the hook: nobody waits for the answer.
    kill -0 "$PPID" 2>/dev/null || exit 0
    touch "$ask"
  fi
  sleep 0.2
done
`;

export function hookFolder(configDir: string): string {
  return path.join(configDir, HOOK_FOLDER);
}

export function hookScriptFile(configDir: string): string {
  return path.join(hookFolder(configDir), SCRIPT);
}

/** A path as the shell running the hook reads it: forward slashes, quoted. On Windows Claude Code runs hooks in Git Bash. */
function shellPath(file: string): string {
  return `'${file.replace(/\\/g, "/").replace(/'/g, `'\\''`)}'`;
}

/**
 * The hook's command: does nothing when the script is gone, so a settings
 * entry left behind costs nothing; else becomes the script, so ending the
 * hook ends the script.
 */
export function hookCommand(configDir: string): string {
  const script = shellPath(hookScriptFile(configDir));
  return `[ ! -f ${script} ] || exec sh ${script}`;
}

interface HookEntry {
  type?: unknown;
  command?: unknown;
}

/** A hook of Lookout's: its command runs Lookout's script, wherever the config directory is. */
function isOurs(hook: unknown): boolean {
  const command = (hook as HookEntry | null)?.command;
  return typeof command === "string" && command.includes(`/${HOOK_FOLDER}/${SCRIPT}`);
}

/** The entries of `hooks.PermissionRequest`, or why they cannot be changed safely. */
function entriesOf(settings: Record<string, unknown>): { hooks: Record<string, unknown>; entries: unknown[] } | { refuse: string } {
  const hooks = settings.hooks ?? {};
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) return { refuse: "has a `hooks` value that is not an object" };
  const entries = (hooks as Record<string, unknown>)[HOOK_EVENT] ?? [];
  if (!Array.isArray(entries)) return { refuse: `has a \`hooks.${HOOK_EVENT}\` value that is not a list` };
  return { hooks: hooks as Record<string, unknown>, entries };
}

/** The entries with Lookout's hooks taken out, and entries left with no hook dropped. */
function withoutOurs(entries: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const entry of entries) {
    const hooks = (entry as { hooks?: unknown } | null)?.hooks;
    if (!Array.isArray(hooks) || !hooks.some(isOurs)) {
      out.push(entry);
      continue;
    }
    const kept = hooks.filter((hook) => !isOurs(hook));
    if (kept.length > 0) out.push({ ...(entry as object), hooks: kept });
  }
  return out;
}

/** Lookout's entry, as it is written. */
function ourEntry(configDir: string): Record<string, unknown> {
  return { matcher: "*", hooks: [{ type: "command", command: hookCommand(configDir), timeout: HOOK_TIMEOUT_S }] };
}

/** Whether the user settings file holds Lookout's hook, as it is written now. */
export function promptHookInstalled(configDir: string): boolean {
  let settings: unknown;
  try {
    settings = JSON.parse(fs.readFileSync(path.join(configDir, "settings.json"), "utf8"));
  } catch {
    return false;
  }
  if (typeof settings !== "object" || settings === null) return false;
  const found = entriesOf(settings as Record<string, unknown>);
  if ("refuse" in found) return false;
  const want = JSON.stringify(ourEntry(configDir));
  return found.entries.some((entry) => JSON.stringify(entry) === want);
}

/**
 * Turns the hook on: writes the script and Lookout's folder, marks that a
 * window runs, and adds the hook to Claude Code's user settings file, with
 * a copy of the file as it was beside it. An entry of Lookout's written
 * otherwise, by an older Lookout or for a config directory that moved, is
 * replaced; the user's own hooks are kept as they are.
 */
export function installPromptHook(configDir: string, now: number = Date.now()): RetentionWrite {
  try {
    fs.mkdirSync(path.join(hookFolder(configDir), ASKS), { recursive: true });
    const script = hookScriptFile(configDir);
    let held: string | undefined;
    try {
      held = fs.readFileSync(script, "utf8");
    } catch {
      held = undefined;
    }
    if (held !== HOOK_SCRIPT) fs.writeFileSync(script, HOOK_SCRIPT, { mode: 0o755 });
    markAlive(configDir, now);
  } catch {
    return { ok: false, file: hookFolder(configDir), why: "could not be written" };
  }
  const want = ourEntry(configDir);
  return updateUserSettings(
    configDir,
    (settings) => {
      const found = entriesOf(settings);
      if ("refuse" in found) return found;
      if (found.entries.some((entry) => JSON.stringify(entry) === JSON.stringify(want))) return false;
      found.hooks[HOOK_EVENT] = [...withoutOurs(found.entries), want];
      settings.hooks = found.hooks;
      return true;
    },
    now,
  );
}

/**
 * Turns the hook off: takes Lookout's entries out of the user settings
 * file, with a copy of the file as it was beside it, and removes Lookout's
 * folder. A hook already waiting finds its prompt file gone and ends.
 */
export function removePromptHook(configDir: string, now: number = Date.now()): RetentionWrite {
  const outcome = updateUserSettings(
    configDir,
    (settings) => {
      const found = entriesOf(settings);
      if ("refuse" in found) return found;
      const kept = withoutOurs(found.entries);
      if (kept.length === found.entries.length && kept.every((entry, i) => entry === found.entries[i])) return false;
      if (kept.length > 0) found.hooks[HOOK_EVENT] = kept;
      else delete found.hooks[HOOK_EVENT];
      if (Object.keys(found.hooks).length > 0) settings.hooks = found.hooks;
      else delete settings.hooks;
      return true;
    },
    now,
  );
  // The folder goes even when the settings file could not be changed: without the script, an entry left there does nothing.
  try {
    fs.rmSync(hookFolder(configDir), { recursive: true, force: true });
  } catch {
    // Left for the next turn-off; the hook ends at once without a fresh mark.
  }
  return outcome;
}

/** Marks that a Lookout window runs: the hook waits for an answer only while the mark is fresh. */
export function markAlive(configDir: string, now: number = Date.now()): void {
  const file = path.join(hookFolder(configDir), ALIVE);
  const at = new Date(now);
  try {
    fs.utimesSync(file, at, at);
  } catch {
    try {
      fs.writeFileSync(file, "");
      fs.utimesSync(file, at, at);
    } catch {
      // The folder is gone: the hook is off.
    }
  }
}

/** A prompt a hook waits on: the session, the tool and its input, as Claude Code handed them to it. */
export interface PanelAsk {
  /** The hook's file: its name is the hook's process id. */
  file: string;
  sessionId: string;
  tool: string;
  input: Record<string, unknown>;
}

/** The folder hooks leave their prompts in. */
export function asksFolder(configDir: string): string {
  return path.join(hookFolder(configDir), ASKS);
}

/** The prompts hooks wait on now. A prompt file its hook stopped marking is left over, and cleared. */
export function readAsks(configDir: string, now: number = Date.now()): PanelAsk[] {
  const dir = asksFolder(configDir);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: PanelAsk[] = [];
  for (const name of names) {
    // An answer whose hook ended unread, or a part a crash left: older than a hook's mark.
    if (!/^\d+\.json$/.test(name)) {
      if (/\.(reply\.json|part)$/.test(name)) clearIfStale(path.join(dir, name), now);
      continue;
    }
    const file = path.join(dir, name);
    let text: string;
    let mtime: number;
    try {
      mtime = fs.statSync(file).mtimeMs;
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (now - mtime > ASK_STALE_MS) {
      for (const leftover of [file, replyFile(file)]) fs.rmSync(leftover, { force: true });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const ask = parsed as { session_id?: unknown; tool_name?: unknown; tool_input?: unknown; hook_event_name?: unknown };
    if (ask.hook_event_name !== HOOK_EVENT || typeof ask.session_id !== "string" || typeof ask.tool_name !== "string") continue;
    const input = typeof ask.tool_input === "object" && ask.tool_input !== null && !Array.isArray(ask.tool_input) ? (ask.tool_input as Record<string, unknown>) : {};
    out.push({ file, sessionId: ask.session_id, tool: ask.tool_name, input });
  }
  return out;
}

function clearIfStale(file: string, now: number): void {
  try {
    if (now - fs.statSync(file).mtimeMs > ASK_STALE_MS) fs.rmSync(file, { force: true });
  } catch {
    // Gone already.
  }
}

function replyFile(askFile: string): string {
  return askFile.replace(/\.json$/, ".reply.json");
}

/** The question of an AskUserQuestion call Lookout answers: one question, one pick. */
function onlyQuestion(input: Record<string, unknown>): { question: string; labels: string[] } | undefined {
  const questions = input.questions;
  if (!Array.isArray(questions) || questions.length !== 1) return undefined;
  const q = questions[0] as { question?: unknown; options?: unknown; multiSelect?: unknown } | null;
  if (typeof q?.question !== "string" || !Array.isArray(q.options) || q.multiSelect === true) return undefined;
  const labels = q.options.map((option) => (option as { label?: unknown } | null)?.label);
  if (!labels.every((label): label is string => typeof label === "string")) return undefined;
  return { question: q.question, labels };
}

/**
 * What the card's answer says to the hook: allow or refuse the call, or the
 * question's option at `index` of the `count` the card shows (the card shows
 * them shortened, so the hook's own words are the answer).
 */
export type PanelChoice = { kind: "yes" } | { kind: "no" } | { kind: "option"; index: number; count: number };

/** Why a No from the card stops the turn, as Esc does in a terminal: the model is told so. */
export const REFUSED = "The user refused this from Lookout's card, and stopped the turn to say what to do instead.";

/**
 * The hook's output for an answer, or none when the prompt does not offer
 * it: a pick is of a question with the options the card shows.
 */
export function decisionFor(ask: PanelAsk, choice: PanelChoice): string | undefined {
  let decision: Record<string, unknown>;
  if (choice.kind === "option") {
    const question = ask.tool === "AskUserQuestion" ? onlyQuestion(ask.input) : undefined;
    const label = question?.labels.length === choice.count ? question.labels[choice.index] : undefined;
    if (!question || label === undefined) return undefined;
    decision = { behavior: "allow", updatedInput: { ...ask.input, answers: { [question.question]: label } } };
  } else if (ask.tool === "AskUserQuestion") {
    return undefined;
  } else {
    decision = choice.kind === "yes" ? { behavior: "allow" } : { behavior: "deny", message: REFUSED, interrupt: true };
  }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: HOOK_EVENT, decision } });
}

/**
 * Hands the hook its answer: written whole beside its prompt, so the hook
 * never reads half of it. False when the prompt is gone: the panel answered
 * it, or the session ended.
 */
export function replyToAsk(ask: PanelAsk, output: string): boolean {
  if (!fs.existsSync(ask.file)) return false;
  const reply = replyFile(ask.file);
  const part = `${reply}.${process.pid}.part`;
  try {
    fs.writeFileSync(part, `${output}\n`);
    fs.renameSync(part, reply);
  } catch {
    fs.rmSync(part, { force: true });
    return false;
  }
  // A hook that ended as the answer went leaves it unread: the next read of the prompts clears it.
  return true;
}
