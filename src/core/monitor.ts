import type { AgentProvider } from "./agents/agent";
import { buildView, type WindowContext } from "./model";
import { ancestorsOf, type ProcessTable } from "./proc";
import type { SessionView } from "./types";

/** Asks every agent provider for its live sessions and places them relative to the window. */
export class Monitor {
  constructor(
    private readonly providers: readonly AgentProvider[],
    private readonly proc: ProcessTable,
  ) {}

  poll(ctx: WindowContext, now: number = Date.now()): SessionView[] {
    return this.providers.flatMap((provider) =>
      provider.poll(now).map((session) => buildView(session, ancestorsOf(this.proc, session.pid), ctx)),
    );
  }
}
