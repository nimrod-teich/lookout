# Settings

Every `lookout.*` setting, with its default. The settings come in two sections, **Agents** (a switch per agent, and where each keeps its files) and **General**. The commands and their keys are in the [README](../README.md#commands).

| Setting | Default | Description |
| --- | --- | --- |
| `lookout.statusBar.enabled` | `true` | Show Lookout's item in the status bar: the usage, and a click to open the board. |
| `lookout.statusBar.showUsage` | `true` | Show the 5-hour usage as a coloured bar in the status bar item; the hover lists every limit. |
| `lookout.statusBar.usageReset` | `true` | After the usage bar, the time until the 5-hour window resets: `32% · 1h12m`. |
| `lookout.usage.refresh` | `auto` | `auto`: fetch when the numbers are older than 10 minutes or a window has reset; at most once every 3 minutes on the machine, and after a fetch that brought no new numbers the wait doubles each time, up to 30 minutes. `manual`: fetch only on `Lookout: Refresh Usage`. `off`: never start the Claude Code binary; show only what it cached. While `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set for Claude Code, Lookout does not fetch either. |
| `lookout.usage.alerts` | `true` | Say when the 5-hour window reaches 70% and 90% and the weekly limit 90%: once per window, in the VS Code window in front (any window when none is) and, while VS Code is not in front, on the desktop. |
| `lookout.notifications.waiting` | `true` | Notify when a session of this window starts to wait for you and you are not looking at it. |
| `lookout.notifications.done` | `false` | Notify when a session of this window finishes a turn and you are not looking at it. |
| `lookout.notifications.os` | `true` | While VS Code is not in front, also show those notifications on the desktop. |
| `lookout.notifications.sound` | `false` | Play a short system sound with each desktop notification. |
| `lookout.notifications.cooldownSeconds` | `30` | A session gets at most one desktop notification per event in this time. While three or more sessions need you, one notification sums them up. |
| `lookout.state.typedQuestions` | `true` | Count an idle session as needing you when its last reply asks you something. Off: such sessions are Finished or Idle like any other. |
| `lookout.statusBar.usageAgent` | `auto` | Whose usage the status bar's bar shows when more than one agent reports usage: `auto`, the window under the most pressure (the highest share used, fresh numbers first), or `claude`, `codex`, `copilot`. A pinned agent that reports none leaves the bar to `auto`. |
| `lookout.agentMarkers` | `auto` | When to tell agents apart by colour and boat: `auto` once the board shows two or more agents (running, earlier or in the usage), `always`, or `never`. |
| `lookout.agents.claude` | `true` | Watch Claude Code: its panel and `claude` in terminals, with its usage. Off: none of its sessions, earlier sessions, search matches or usage, none of its files read, and Claude Code never run to refresh the usage. |
| `lookout.agents.codex` | `true` | Watch Codex: the Codex extension's panel, VS Code's Chat, `codex` in terminals and `codex exec` runs. |
| `lookout.agents.copilot` | `true` | Watch Copilot: VS Code's Chat (its Copilot, Copilot CLI and Local sessions) and `copilot` in terminals. |
| `lookout.claudeConfigDir` | `""` | Claude Code config directory to read sessions from. Empty uses `CLAUDE_CONFIG_DIR` from the Claude Code extension's settings or the environment, then `~/.claude`. |
| `lookout.codexHome` | `""` | Codex's home folder, where its `sessions` are. Empty uses `CODEX_HOME`, then `~/.codex`. |
| `lookout.copilotHome` | `""` | Copilot CLI's home folder, where its `session-state` is. Empty uses `COPILOT_HOME`, then `~/.copilot`. |
