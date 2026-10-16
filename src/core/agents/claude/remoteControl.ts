import * as fs from "node:fs";
import * as path from "node:path";

/** Claude Code's user settings file. */
export function settingsFile(configDir: string): string {
  return path.join(configDir, "settings.json");
}

/**
 * Sets `remoteControlAtStartup` in Claude Code's user settings, keeping every
 * other key and the file's indentation. The file is replaced in one step, the
 * way Claude Code writes it, so a reader never sees a half-written file.
 */
export function writeRemoteControlAtStartup(configDir: string, on: boolean): void {
  const file = settingsFile(configDir);
  let text = "{}";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object`);
  const settings = parsed as Record<string, unknown>;
  settings.remoteControlAtStartup = on;
  const indent = /^\{\r?\n([ \t]+)"/.exec(text)?.[1] ?? "  ";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.lookout-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, indent)}\n`);
  fs.renameSync(tmp, file);
}
