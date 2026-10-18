// What a `copilot` command line says about the session it holds.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The session `copilot --resume <id>` (or `--resume=<id>`, `-r <id>`)
 * continues. Copilot writes a resumed session's in-use lock only once
 * something is sent, so until then this is what ties the process to it.
 */
export function resumeIdOf(args: readonly string[]): string | undefined {
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    const inline = /^(?:--resume|-r)=(.+)$/.exec(arg)?.[1];
    const value = inline ?? (arg === "--resume" || arg === "-r" ? args[i + 1] : undefined);
    if (value && UUID.test(value)) return value.toLowerCase();
  }
  return undefined;
}
