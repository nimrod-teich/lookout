import { quietFor } from "../core/format";
import type { SessionView, State } from "../core/types";

/** The lighthouse, from the icon font the extension contributes (`contributes.icons`). */
export const BRAND_ICON = "$(lookout-lighthouse)";

/** Codicon for each session state; `~spin` animates in the VS Code UI. */
export const STATE_ICON: Record<State, string> = {
  waiting: "$(bell-dot)",
  done: "$(check)",
  working: "$(loading~spin)",
  unknown: "$(question)",
  idle: "$(circle-outline)",
};

/** A question Lookout read in a reply, rather than a prompt the agent reports. */
const TYPED_ICON = "$(comment-discussion)";
/** Working, with nothing written to its transcript for a while. */
const QUIET_ICON = "$(clock)";

/** Text shown where VS Code reads `$(name)` as an icon, with every such form kept as written: `make -j$(nproc)`. */
export function escapeIcons(text: string): string {
  return text.replace(/(\\)?\$\([a-z0-9-]+?(?:~[a-z0-9-]*?)?\)/gi, (match, escaped: string | undefined) => (escaped ? match : `\\${match}`));
}

/** The codicon for a session as it is now. */
export function iconFor(view: SessionView, now: number): string {
  if (view.reason?.kind === "typed") return TYPED_ICON;
  if (quietFor(view, now) !== undefined) return QUIET_ICON;
  return STATE_ICON[view.state];
}
