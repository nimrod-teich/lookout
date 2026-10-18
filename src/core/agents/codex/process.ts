// Which `codex` processes are interactive sessions, from their command line.

/** Subcommands that are not an interactive session: services, one-shot commands, tooling. */
const NOT_SESSIONS = new Set([
  "exec", "e", "review", "login", "logout", "mcp", "mcp-server", "plugin", "app-server", "remote-control", "completion", "update", "doctor",
  "sandbox", "debug", "apply", "a", "queue", "archive", "delete", "migrate-rollouts", "unarchive", "cloud", "exec-server", "features", "help", "agents",
]);
/** Options that take the next argument as their value. */
const WITH_VALUE = new Set(["-c", "--config", "-m", "--model", "-s", "--sandbox", "-a", "--ask-for-approval", "-C", "--cd", "-p", "--profile", "-i", "--image", "--add-dir", "--enable", "--disable", "--local-provider", "--remote", "--color"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CodexInvocation {
  /** An interactive session: `codex`, `codex "<prompt>"`, `codex resume …`, `codex fork …`. */
  session: boolean;
  /** The thread `codex resume <id>` continues. */
  resumeId?: string;
  /** The directory `-C` / `--cd` names. */
  cd?: string;
}

/** A command line's words that are not options or their values, and the directory `-C` names; undefined for `--help` or `--version`. */
function wordsOf(args: readonly string[]): { positional: string[]; cd?: string } | undefined {
  const positional: string[] = [];
  let cd: string | undefined;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h" || arg === "--version" || arg === "-V") return undefined;
    if (arg.startsWith("-")) {
      const [flag, inline] = arg.split("=", 2) as [string, string | undefined];
      if (flag === "-C" || flag === "--cd") cd = inline ?? args[i + 1];
      if (WITH_VALUE.has(flag) && inline === undefined) i++;
      continue;
    }
    positional.push(arg);
  }
  return { positional, cd };
}

/**
 * What a `codex` process serves that is not a session in a terminal: an
 * app-server an editor or another tool runs (the VS Code extension runs one
 * per window), the daemon that serves the terminal sessions
 * (`app-server --managed-daemon`), or a one-shot `codex exec`.
 */
export type CodexServer = "app-server" | "daemon" | "exec";

export function serverOf(args: readonly string[]): CodexServer | undefined {
  const words = wordsOf(args);
  const [first, second] = words?.positional ?? [];
  if (first === "exec" || first === "e") return "exec";
  if (first !== "app-server") return undefined;
  return args.includes("--managed-daemon") || second === "daemon" ? "daemon" : "app-server";
}

/** Reads a `codex` command line, the program first. */
export function invocationOf(args: readonly string[]): CodexInvocation {
  const words = wordsOf(args);
  if (!words) return { session: false };
  const { positional, cd } = words;
  const first = positional[0];
  if (first === "resume" || first === "fork") {
    const id = positional[1];
    return { session: true, resumeId: first === "resume" && id && UUID.test(id) ? id.toLowerCase() : undefined, cd };
  }
  if (first !== undefined && NOT_SESSIONS.has(first)) return { session: false };
  return { session: true, cd };
}
