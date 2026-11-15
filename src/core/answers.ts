// Answering a session's prompt from its card: what the card offers, and how
// the answer reaches the session: keys Lookout types into its terminal, or,
// for a session in the agent's panel, Lookout's hook. No vscode and no node
// imports: the board's webview bundles it too.
import { agentInfo } from "./agents/catalog";
import type { SessionView } from "./types";

/** An answer: yes or no to a permission, or a question's option by its place, from 0. */
export type Choice = "yes" | "no" | number;

/** One answer the card offers. */
export interface Answer {
  choice: Choice;
  /** "Yes", "No", or the option's own words. */
  label: string;
  /** The hover: what the answer does. */
  title: string;
}

/** What a key sequence is called in a hover. */
function keyName(keys: string): string {
  return keys === "\u001b" ? "Esc" : keys;
}

/**
 * How the card's answer reaches the session: as keys typed into its terminal,
 * for a session in one of this window's terminals of an agent whose keys
 * Lookout knows; or through Lookout's hook, for a session in this window's
 * agent panel whose prompt the hook waits on, or would once turned on.
 */
export function answerRoute(view: SessionView): "keys" | "hook" | undefined {
  if (view.host === "terminal" && view.terminalPid !== undefined && agentInfo(view.agent).answerKeys) return "keys";
  if (view.host === "panel" && view.promptHook !== undefined) return "hook";
  return undefined;
}

/** How the hover says where the answer goes. */
function whereTo(view: SessionView, keys: string | undefined): string {
  if (keys !== undefined) return `Lookout presses ${keyName(keys)} in its terminal`;
  return view.promptHook === "off" ? "Lookout first asks to answer the panel's prompts from cards" : "Lookout answers it in the panel";
}

/**
 * The answers the card offers: only for a session waiting on a prompt whose
 * reader knows what the agent shows, and that Lookout can answer where the
 * session runs. Anything else is answered there.
 */
export function answersOf(view: SessionView): Answer[] {
  const reason = view.reason;
  const route = answerRoute(view);
  if (view.state !== "waiting" || !route) return [];
  if (!reason?.answer || reason.call === undefined || reason.tentative) return [];
  const keys = route === "keys" ? agentInfo(view.agent).answerKeys! : undefined;
  if (reason.answer === "yesno") {
    return [
      { choice: "yes", label: "Yes", title: `Allow it once: ${whereTo(view, keys?.yes)}` },
      { choice: "no", label: "No", title: `Refuse it: ${whereTo(view, keys?.no)}, and the session waits for what to do instead` },
    ];
  }
  return (reason.options ?? []).map((option, index) => ({ choice: index, label: option, title: `Answer “${option}”: ${whereTo(view, keys?.option(index))}` }));
}

/** The answer the card still offers for the prompt the session shows now: for this call, and among the answers on offer. */
export function stillOffered(view: SessionView, call: string, choice: Choice): boolean {
  return view.reason?.call === call && answersOf(view).some((answer) => answer.choice === choice);
}

/** The keys that give this answer to the prompt the session shows now in its terminal, when the card still offers it. */
export function keysFor(view: SessionView, call: string, choice: Choice): string | undefined {
  if (answerRoute(view) !== "keys" || !stillOffered(view, call, choice)) return undefined;
  const keys = agentInfo(view.agent).answerKeys!;
  if (choice === "yes") return keys.yes;
  if (choice === "no") return keys.no;
  return keys.option(choice);
}
