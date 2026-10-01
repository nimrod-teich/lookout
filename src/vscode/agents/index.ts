import { CLAUDE_CODE } from "../../core/agents/claude/provider";
import { claudePanel } from "./claudePanel";
import type { PanelAdapter } from "./panel";

const PANELS: Record<string, PanelAdapter> = {
  [CLAUDE_CODE]: claudePanel,
};

/** The panel adapter of an agent, for agents that host sessions in an editor panel. */
export function panelAdapter(agent: string): PanelAdapter | undefined {
  return PANELS[agent];
}
