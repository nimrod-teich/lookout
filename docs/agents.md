# Supported agents

The Supported agents table in the [README](../README.md#supported-agents) says what Lookout does for each agent. This page says what its columns mean, where each agent runs and what a click does there, and what applies to some agents only.

## What the columns mean

**Live sessions**: where Lookout finds the agent's running sessions. **Jump to terminal** and **Jump to tab**: Lookout brings a session in a VS Code terminal, or in the agent's own editor tab, to the front, in any VS Code window on the same machine. **Rename**: a click on a card's title renames the session through the agent (Claude: its own rename in the panel, `/rename` in a terminal). **Resume**: a click on an earlier session of this window's folders resumes it (Claude: in its panel; Codex: a thread of its extension in the extension, one of VS Code's Chat there, any other with `codex resume <id>`; Copilot: a session of VS Code's Chat in VS Code's Chat, any other with `copilot --resume <id>`; each command in a new terminal in the session's folder). **Search**: the board's search, the search page and the conversation tab read the agent's conversations. **Usage**: the account's limits on the board and in the status bar. Copilot CLI records each session's premium requests and AI credits, but not the account's monthly allowance, so it has no usage group; its cards show their tokens. Where an agent lacks one, Lookout leaves that action out rather than offering one that fails.

In VS Code's Chat, every Copilot session type is watched, with its approvals: **Copilot** (the type VS Code 1.142 offers by default, which runs Copilot CLI's runtime), **Copilot CLI** (which the Copilot extension runs) and **Local**; so is the **Codex** type, where VS Code runs Codex itself. A click opens the session in an editor, on the prompt it waits on.

Each agent has its own colour and boat: Claude a coral sloop, Codex a teal cutter, Copilot a violet ferry. Once the board shows two or more agents, running, among the earlier sessions or in the usage, they mark every place a session shows: the boat's hull and sails in the harbour (its lantern keeps the state's colour), a thin edge on the card and a small boat before its title, a chip per agent in the legend that hides that agent's sessions, usage and search matches, the jump list, the status bar's hover, the usage groups, the search page and the conversation tab, with the agent's name in hovers and lists. With one agent nothing changes (`lookout.agentMarkers` shows them always, or never). Red, amber and green stay the colours of states and usage; the agents' colours differ from them and from each other in lightness too, and a boat always stands next to the colour.

Sessions in another VS Code window are listed with that window's name, and a jump to one goes through that window. Windows see each other through a folder in the extension's global storage, so only windows whose extensions run on the same machine, in the same VS Code profile, see each other: a window connected over SSH or to a container sees the other windows connected to the same host, not your local ones. Sessions Lookout cannot bring forward are listed with where they run: **outside VS Code** (a terminal of no VS Code window, a script, `claude -p`, `codex exec` run elsewhere) or **window without Lookout** (an agent's panel in a VS Code window where Lookout is off, or in another editor). A click on one opens its conversation.

## Where each agent runs

Every place each agent runs, whether Lookout shows it, and what a click on its card does.

| Agent | Where it runs | On the board | A click |
| --- | --- | --- | --- |
| Claude Code | The Claude Code extension's panel, in a tab or the side bar | ✓ | Its tab, at its newest message |
| Claude Code | `claude` in a VS Code terminal | ✓ | Its terminal |
| Claude Code | `claude` in another terminal, `claude -p`, a script | ✓ as **outside VS Code** | Its conversation |
| Claude Code | VS Code's Chat, its **Claude** type | Not checked, see Limitations | |
| Claude Code | The Claude desktop app | Not checked, see Limitations | |
| Claude Code | Claude Code on the web | — | |
| Codex | The Codex extension's side bar and editor tabs | ✓ | The thread in the extension's editor, with its approval prompt |
| Codex | VS Code's Chat, its **Codex** type | ✓ | The session in an editor, with its approval prompt |
| Codex | `codex` in a VS Code terminal | ✓ | Its terminal |
| Codex | `codex` or `codex exec` in another terminal | ✓ as **outside VS Code** | Its conversation |
| Codex | The Codex desktop app | Not checked, see Limitations | |
| Codex | Codex cloud tasks | — | |
| Copilot | VS Code's Chat, its **Copilot** type | ✓ | The session in an editor, with its approval prompt |
| Copilot | VS Code's Chat, its **Copilot CLI** type | ✓ | Its editor tab, with its approval prompt |
| Copilot | VS Code's Chat, its **Local** type | ✓ | The chat in an editor, with its approval prompt |
| Copilot | `copilot` in a VS Code terminal | ✓ | Its terminal |
| Copilot | `copilot` in another terminal | ✓ as **outside VS Code** | Its conversation |
| Copilot | Copilot's coding agent, on GitHub or as the **Cloud** type of VS Code's Chat | — | |

An agent's panel in a VS Code window where Lookout is off shows as **window without Lookout**, and a click opens its conversation.

## Limitations

What applies to some agents only. ✓: it applies to that agent.

| Limitation | Claude Code | Codex | Copilot |
| --- | --- | --- | --- |
| Cloud sessions are not shown, since Lookout calls no service | ✓ Claude Code on the web | ✓ cloud tasks | ✓ the coding agent |
| VS Code's Chat type for the agent was not checked: on the machine Lookout was tested on, VS Code's **Claude** type offered no model, since its own Claude sign-in was not set up | ✓ | — | — |
| The desktop app was not checked. A WSL, SSH or container window cannot see it in any case, since it runs on the local side | ✓ | ✓ | — |
| The state is inferred from the end of the conversation, since the agent keeps no state file; the card's hover says so | — | ✓ | — |
| Which terminal runs which thread is inferred from folders and start times; two sessions in one folder can trade places when one switches threads | — | ✓ | — |
| A thread in an editor counts as running while Codex keeps it loaded, which can be hours after its last reply (the extension keeps it until no view shows it and it has been idle for 3 hours) | — | ✓ | — |
| On Windows, which of the extension's threads run is inferred from when they were written (the last 10 minutes) | — | ✓ | — |
| Usage limits are as of the agent's last reply, and turn grey 30 minutes after it | — | ✓ | — |
| No usage group: the agent records no account allowance | — | — | ✓ |
| Prices are at API list rates, not what a plan bills | ✓ | ✓ | — |
| No price: the agent bills premium requests, not tokens | — | — | ✓ |
| No rename from Lookout | — | ✓ | ✓ |
| Earlier sessions show no git branch, and `branch:` finds only running ones | — | ✓ | ✓ |
| Compressed earlier sessions (`.jsonl.zst`) are counted, not read | — | ✓ | — |
| A Local chat shows a change a few seconds late, since VS Code saves the chat within seconds | — | — | ✓ |

For every agent: a remote window (WSL, SSH, a container) sees the agents that run on the remote side, and under WSL VS Code's Local chats are read from the Windows side as well.
