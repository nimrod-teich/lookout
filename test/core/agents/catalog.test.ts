import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENTS, agentByKey, agentInfo, boardAgents, canJump, canRename, canResume, markerSetting, markersShown, unreachable, type Capabilities } from "../../../src/core/agents/catalog";
import { CLAUDE_CODE } from "../../../src/core/agents/claude/provider";

const ROOT = path.join(__dirname, "..", "..", "..");
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

interface Manifest {
  contributes: {
    icons: Record<string, { default: { fontPath: string; fontCharacter: string } }>;
    configuration: { properties: Record<string, { enum?: string[]; default?: unknown }> };
  };
}
const manifest = JSON.parse(read("package.json")) as Manifest;

describe("the agent catalog", () => {
  it("lists Claude first, under the id its provider reports, and gives every agent its own id, key, name, hue and glyph", () => {
    expect(AGENTS[0]).toMatchObject({ id: CLAUDE_CODE, key: "claude", label: "Claude" });
    expect(AGENTS.map((a) => [a.id, a.key, a.label])).toEqual([
      ["claude-code", "claude", "Claude"],
      ["codex", "codex", "Codex"],
      ["copilot", "copilot", "Copilot"],
    ]);
    for (const field of ["id", "key", "label", "hue", "glyph"] as const) {
      const values = AGENTS.map((a) => JSON.stringify(a[field]));
      expect(new Set(values).size, field).toBe(AGENTS.length);
    }
    expect(agentByKey("codex")?.id).toBe("codex");
    expect(agentByKey("claude-code")).toBeUndefined();
  });

  it("names an agent it does not list by its id, in the neutral colour, with every action as before", () => {
    const other = agentInfo("test-agent");
    expect(other).toMatchObject({ id: "test-agent", label: "test-agent", hue: "--agent-other" });
    expect(Object.values(other.capabilities).every(Boolean)).toBe(true);
    expect(canJump({ agent: "test-agent", host: "panel" })).toBe(true);
    expect(canRename({ agent: "test-agent" })).toBe(true);
  });

  it("ships every glyph in the icon font, drawn from the catalog's own path", () => {
    const config = read("fantasticon.config.cjs");
    for (const agent of AGENTS) {
      const name = agent.glyph.icon.replace(/^lookout-/, "");
      expect(read(`icons/${name}.svg`), name).toContain(`d="${agent.glyph.path}"`);
      const icon = manifest.contributes.icons[agent.glyph.icon];
      expect(icon?.default.fontPath, agent.glyph.icon).toBe("media/lookout-icons.woff");
      const codepoint = new RegExp(`${name}: 0x([0-9a-f]+)`, "i").exec(config)?.[1];
      expect(icon?.default.fontCharacter.toLowerCase(), name).toBe(`\\${codepoint}`);
    }
  });

  it("defines each hue in every page with the catalog's values: dark and light on the board, the night ones on the search page and the conversation tab", () => {
    const board = read("media/board.css");
    const root = /:root \{([^}]*)\}/.exec(board)![1]!;
    const light = /body\.vscode-light,\s*body\.vscode-high-contrast-light \{([^}]*)\}/.exec(board)![1]!;
    for (const agent of AGENTS) {
      expect(root, agent.key).toContain(`${agent.hue}: ${agent.colors.dark};`);
      expect(light, agent.key).toContain(`${agent.hue}: ${agent.colors.light};`);
      for (const page of ["media/search.css", "media/findings.css"]) expect(/:root \{([^}]*)\}/.exec(read(page))![1], `${page} ${agent.key}`).toContain(`${agent.hue}: ${agent.colors.dark};`);
    }
  });

  it("offers the catalog's agents in the settings", () => {
    const props = manifest.contributes.configuration.properties;
    expect(props["lookout.statusBar.usageAgent"]).toMatchObject({ enum: ["auto", ...AGENTS.map((a) => a.key)], default: "auto" });
    expect(props["lookout.agentMarkers"]).toMatchObject({ enum: ["auto", "always", "never"], default: "auto" });
  });

  it("shows in the README's Supported agents table exactly what the catalog lets each agent do", () => {
    const readme = read("README.md");
    const section = readme.slice(readme.indexOf("## Supported agents"), readme.indexOf("## Install"));
    // The section's first table; the tables after it say where each agent runs and what it lacks.
    const lines = section.split("\n");
    const start = lines.findIndex((line) => line.startsWith("|"));
    const end = lines.findIndex((line, i) => i > start && !line.startsWith("|"));
    const rows = lines
      .slice(start, end)
      .filter((line) => !line.startsWith("| ---"))
      .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
    const [header, ...body] = rows;
    expect(header).toEqual(["Agent", "Live sessions", "Jump to terminal", "Jump to tab", "Rename", "Resume", "Search", "Usage"]);
    const order: (keyof Capabilities)[] = ["jumpTerminal", "jumpPanel", "rename", "resume", "search", "usage"];
    expect(body.length).toBeGreaterThan(0);
    for (const row of body) {
      const agent = AGENTS.find((a) => row[0]!.includes(a.label));
      expect(agent, row[0]).toBeDefined();
      expect(row.slice(2).map((cell) => cell.startsWith("✓")), agent!.label).toEqual(order.map((name) => agent!.capabilities[name]));
    }
  });
});

describe("markersShown", () => {
  it("shows the agents apart once the board shows two or more, unless told always or never", () => {
    expect(markersShown("auto", [])).toBe(false);
    expect(markersShown("auto", ["claude-code", "claude-code", "claude-code"])).toBe(false);
    expect(markersShown("auto", ["claude-code", "codex"])).toBe(true);
    expect(markersShown("always", ["claude-code"])).toBe(true);
    expect(markersShown("always", [])).toBe(true);
    expect(markersShown("never", ["claude-code", "codex", "copilot"])).toBe(false);
  });

  it("counts an agent with only earlier sessions or usage limits on the board, and not an empty usage group", () => {
    const claudeUsage = { agent: "claude-code", meters: [{ key: "session", percent: 14 }] };
    const emptyClaude = { agent: "claude-code", meters: [] };
    const codexUsage = { agent: "codex", meters: [{ key: "session", percent: 2 }] };
    // Codex's last session ended: its earlier session and its limits keep it on the board, and the markers on.
    expect(markersShown("auto", boardAgents({ sessions: [{ agent: "claude-code" }], past: [{ agent: "codex" }], usage: [claudeUsage] }))).toBe(true);
    expect(markersShown("auto", boardAgents({ sessions: [{ agent: "claude-code" }], past: [], usage: [claudeUsage, codexUsage] }))).toBe(true);
    // A Codex-only user: Claude's group is there without limits, so one agent shows and no marker.
    expect(boardAgents({ sessions: [{ agent: "codex" }], past: [{ agent: "codex" }], usage: [emptyClaude, codexUsage] })).toEqual(["codex", "codex", "codex"]);
    expect(markersShown("auto", boardAgents({ sessions: [{ agent: "codex" }], past: [], usage: [emptyClaude, codexUsage] }))).toBe(false);
  });

  it("reads the setting, auto for anything it does not know", () => {
    expect(["auto", "always", "never", "sometimes", undefined, 3].map(markerSetting)).toEqual(["auto", "always", "never", "auto", "auto", "auto"]);
  });
});

describe("capabilities", () => {
  it("offers a jump only where the agent can be reached: its tab, its terminal, another window, or a word on where it runs", () => {
    expect(canJump({ agent: "claude-code", host: "panel" })).toBe(true);
    expect(canJump({ agent: "claude-code", host: "terminal" })).toBe(true);
    expect(canJump({ agent: "codex", host: "terminal" })).toBe(true);
    expect(canJump({ agent: "codex", host: "panel" })).toBe(true);
    expect(canJump({ agent: "copilot", host: "panel" })).toBe(true);
    expect(canJump({ agent: "codex", host: "window" })).toBe(true);
    expect(canJump({ agent: "copilot", host: "elsewhere" })).toBe(true);
    expect(canJump({ agent: "copilot", host: "editor" })).toBe(true);
    expect([unreachable({ host: "elsewhere" }), unreachable({ host: "editor" }), unreachable({ host: "window" }), unreachable({ host: "panel" })]).toEqual([true, true, false, false]);
  });

  it("offers a rename and a resume only to the agents that do them", () => {
    expect(canRename({ agent: "claude-code" })).toBe(true);
    expect(canRename({ agent: "codex" })).toBe(false);
    expect(canResume({ agent: "claude-code", resumable: true })).toBe(true);
    expect(canResume({ agent: "claude-code", resumable: false })).toBe(false);
    for (const agent of AGENTS) {
      expect(canResume({ agent: agent.id, resumable: true }), agent.key).toBe(agent.capabilities.resume);
      expect(canRename({ agent: agent.id }), agent.key).toBe(agent.capabilities.rename);
    }
  });
});
