import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { settingsFile, writeRemoteControlAtStartup } from "../../../../src/core/agents/claude/remoteControl";
import { tempConfigDir } from "../../helpers";

describe("writeRemoteControlAtStartup", () => {
  it("creates the settings file when there is none", () => {
    const dir = path.join(tempConfigDir(), "fresh");
    writeRemoteControlAtStartup(dir, true);
    expect(JSON.parse(fs.readFileSync(settingsFile(dir), "utf8"))).toEqual({ remoteControlAtStartup: true });
  });

  it("keeps every other key and the file's indentation", () => {
    const dir = tempConfigDir();
    fs.writeFileSync(settingsFile(dir), '{\n\t"model": "opus",\n\t"permissions": {\n\t\t"allow": ["Bash(ls)"]\n\t},\n\t"remoteControlAtStartup": true\n}\n');
    writeRemoteControlAtStartup(dir, false);
    const text = fs.readFileSync(settingsFile(dir), "utf8");
    expect(JSON.parse(text)).toEqual({ model: "opus", permissions: { allow: ["Bash(ls)"] }, remoteControlAtStartup: false });
    expect(text).toContain('\n\t"model"');
    expect(text.endsWith("\n")).toBe(true);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith("settings"))).toEqual(["settings.json"]);
  });

  it("refuses a settings file that is not a JSON object", () => {
    const dir = tempConfigDir();
    fs.writeFileSync(settingsFile(dir), "[1, 2]\n");
    expect(() => writeRemoteControlAtStartup(dir, true)).toThrow("not a JSON object");
    expect(fs.readFileSync(settingsFile(dir), "utf8")).toBe("[1, 2]\n");
  });
});
