// Answering a session's prompt from its card: what the card offers, and the
// keys Lookout types into the session's terminal for it. No vscode and no node
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
 * The answers the card offers: only for a session in one of this window's
 * terminals, waiting on a prompt whose reader knows what the agent shows, of
 * an agent whose keys Lookout knows. Anything else is answered where it runs.
 */
export function answersOf(view: SessionView): Answer[] {
  const reason = view.reason;
  const keys = agentInfo(view.agent).answerKeys;
  if (view.state !== "waiting" || view.host !== "terminal" || view.terminalPid === undefined || !keys) return [];
  if (!reason?.answer || reason.call === undefined || reason.tentative) return [];
  if (reason.answer === "yesno") {
    return [
      { choice: "yes", label: "Yes", title: `Allow it once: Lookout presses ${keyName(keys.yes)} in its terminal` },
      { choice: "no", label: "No", title: `Refuse it: Lookout presses ${keyName(keys.no)} in its terminal, and the session waits for what to do instead` },
    ];
  }
  return (reason.options ?? []).map((option, index) => ({ choice: index, label: option, title: `Answer “${option}”: Lookout presses ${keyName(keys.option(index))} in its terminal` }));
}

/** The keys that give this answer to the prompt the session shows now, when the card still offers it. */
export function keysFor(view: SessionView, call: string, choice: Choice): string | undefined {
  if (view.reason?.call !== call || !answersOf(view).some((answer) => answer.choice === choice)) return undefined;
  const keys = agentInfo(view.agent).answerKeys!;
  if (choice === "yes") return keys.yes;
  if (choice === "no") return keys.no;
  return keys.option(choice);
}
