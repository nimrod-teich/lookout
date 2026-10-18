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

/** Reads a `codex` command line, the program first. */
export function invocationOf(args: readonly string[]): CodexInvocation {
  const positional: string[] = [];
  let cd: string | undefined;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h" || arg === "--version" || arg === "-V") return { session: false };
    if (arg.startsWith("-")) {
      const [flag, inline] = arg.split("=", 2) as [string, string | undefined];
      if (flag === "-C" || flag === "--cd") cd = inline ?? args[i + 1];
      if (WITH_VALUE.has(flag) && inline === undefined) i++;
      continue;
    }
    positional.push(arg);
  }
  const first = positional[0];
  if (first === "resume" || first === "fork") {
    const id = positional[1];
    return { session: true, resumeId: first === "resume" && id && UUID.test(id) ? id.toLowerCase() : undefined, cd };
  }
  if (first !== undefined && NOT_SESSIONS.has(first)) return { session: false };
  return { session: true, cd };
}
