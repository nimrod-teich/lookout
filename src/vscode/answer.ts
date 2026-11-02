import { keysFor, type Choice } from "../core/answers";
import type { SessionView } from "../core/types";
import type { Log } from "./log";

/**
 * What came of an answer: typed into the session's terminal; refused because
 * the call was answered from a card before; refused because the session no
 * longer shows that prompt; or the terminal is gone.
 */
export type AnswerResult = "sent" | "already" | "moved-on" | "no-terminal";

/** How many answered calls are remembered, so a second click on one is refused. */
const REMEMBERED = 50;

export interface AnswererDeps {
  /** Reads the sessions now and returns them: an answer goes only to the prompt the session shows now. */
  refresh(): readonly SessionView[];
  /** Types keys into the terminal with this shell pid; false when it is closed. */
  send(pid: number, keys: string): boolean;
  log: Log;
}

/**
 * Answers a session's prompt from its card, by typing the agent's keys into
 * its terminal. The card can be a moment old: the sessions are read again
 * first, and the answer goes only when the session still waits on the same
 * tool call with the same answer on offer. A key typed into a prompt that has
 * gone would land in the agent's input, or, for Esc, stop its turn.
 */
export class Answerer {
  /** The calls answered, oldest first. */
  private readonly answered: string[] = [];

  constructor(private readonly deps: AnswererDeps) {}

  answer(id: string, call: string, choice: Choice): AnswerResult {
    if (this.answered.includes(call)) return "already";
    const view = this.deps.refresh().find((v) => v.id === id);
    if (!view) return "moved-on";
    const keys = keysFor(view, call, choice);
    if (keys === undefined) return "moved-on";
    if (!this.deps.send(view.terminalPid!, keys)) return "no-terminal";
    this.answered.push(call);
    if (this.answered.length > REMEMBERED) this.answered.shift();
    this.deps.log.info(`Answered "${view.title}" (${view.id}) from its card: ${typeof choice === "number" ? `option ${choice + 1}` : choice} to ${view.reason?.kind} "${view.reason?.ask}".`);
    return "sent";
  }
}
