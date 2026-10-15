import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

/** The Claude Code binary bundled with the Claude Code extension, if the extension is installed. */
export function findClaudeBinary(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | undefined {
  const extension = vscode.extensions.getExtension("anthropic.claude-code");
  if (!extension) return undefined;
  const name = platform === "win32" ? "claude.exe" : "claude";
  const platformDir = `${platform === "win32" ? "win32" : platform}-${arch}`;
  const candidates = [
    path.join(extension.extensionPath, "resources", "native-binaries", platformDir, name),
    path.join(extension.extensionPath, "resources", "native-binaries", `${platformDir}-musl`, name),
    path.join(extension.extensionPath, "resources", "native-binary", name),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}
