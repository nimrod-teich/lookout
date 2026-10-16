<p align="center">
  <img src="media/banner.png" alt="Lookout: a lighthouse whose beam sweeps over coding sessions floating on a dark sea" width="100%">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.0-FFB000?style=flat-square&labelColor=0A2436" alt="Version 0.1.0">
  <img src="https://img.shields.io/badge/VS%20Code-1.94%2B-17607F?style=flat-square&labelColor=0A2436" alt="VS Code 1.94 or newer">
  <img src="https://img.shields.io/badge/runs%20on-Linux%20%7C%20macOS%20%7C%20Windows%20%7C%20WSL%20%7C%20remotes-17607F?style=flat-square&labelColor=0A2436" alt="Runs on Linux, macOS, Windows, WSL and remote hosts">
  <img src="https://img.shields.io/badge/telemetry-none-17607F?style=flat-square&labelColor=0A2436" alt="No telemetry">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-17607F?style=flat-square&labelColor=0A2436" alt="MIT license"></a>
</p>

<p align="center"><b>Every AI coding agent session at a glance: what is working, what needs you, and where.</b></p>

<p align="center">
  <a href="#what-it-does">What it does</a> &nbsp;|&nbsp;
  <a href="#supported-agents">Supported agents</a> &nbsp;|&nbsp;
  <a href="#install">Install</a> &nbsp;|&nbsp;
  <a href="#commands-and-settings">Commands</a> &nbsp;|&nbsp;
  <a href="#how-it-works">How it works</a>
</p>

Running several AI coding agents at once means clicking through tabs to find out which one finished and which one is stuck on a question. Lookout keeps that answer in the status bar, takes you to the right tab with one keystroke, and finds any conversation, running or not, by a word you remember from it.

## What it does

<table>
  <tr>
    <td><b>Board</b></td>
    <td>The Lookout view in the activity bar. At the top, the harbour: a night scene where every session is a boat on the water. Its lane says its state, its distance from the lighthouse how long it has been there; the beam lights the boats it passes and swings to a boat before a jump, and the tide rises with your 5-hour usage. Hover a boat for the session's details; its card lights up below.</td>
  </tr>
  <tr>
    <td><b>Cards</b></td>
    <td>One card per session, grouped into Needs you, Finished, Working and Idle: the title, time in state, what it is doing right now (the tool it runs, or what it asks you), its tool calls per minute over the last 15 minutes (the bars grow from the left while it is younger than that), a ring for how full its context window is, the tokens it has used so far with their price at API list rates, its project and worktree, where it runs and its model. Click a card to jump to the session; a pencil renames it through the agent; a click on a state in the legend hides that group. A tab with nothing sent yet is listed as "Empty tab".</td>
  </tr>
  <tr>
    <td><b>Earlier</b></td>
    <td>Under the live sessions, a collapsed group holds the sessions of this window's folders that are not running and that the agent has not archived, newest first. Click the heading to open it; click a session to resume it in the agent's panel.</td>
  </tr>
  <tr>
    <td><b>Search</b></td>
    <td>A box above the cards looks through every conversation, live and earlier: what you wrote and what the agent replied, not tool traffic. Every word must appear in one message. The sessions with matches stay, each with its newest three matches under the card and the words marked; the rest hide until the box is cleared. Big transcripts are read a little at a time, and the box says how many are left.</td>
  </tr>
  <tr>
    <td><b>Conversation&nbsp;tab</b></td>
    <td>A click on a match, or on "+N more", opens that session's whole conversation in an editor tab, scrolled to the match, in the harbour's night colours with the messages' Markdown rendered: headings, lists, quotes, links, inline code and code blocks. The tab has a search of its own: it marks the words, dims the messages without them, and steps through the matches with Enter and the arrows. It follows the conversation as it grows, and an Open session button brings the agent's own tab or terminal to the front.</td>
  </tr>
  <tr>
    <td><b>Usage</b></td>
    <td>Your 5-hour and weekly limits on the board, with each window's reset time, and the 5-hour one as a coloured bar in the status bar item. The bars turn amber from half and red from 80%. Claude Code fetches the numbers again when they are older than 10 minutes, with its own credentials; <code>Lookout: Refresh Usage</code> fetches at once.</td>
  </tr>
  <tr>
    <td><b>Watch</b></td>
    <td>One status bar item shows how many sessions are working, how many wait for you, how many finished since you last looked, and your 5-hour usage as a ten-cell bar coloured by consumption. Its background lights up while any session waits. Hover for every session's title, project, worktree and state, and every usage limit.</td>
  </tr>
  <tr>
    <td><b>Jump</b></td>
    <td><code>Ctrl+Alt+J</code> lists the sessions, the ones that need attention first, with how long each has been in its state. Pick one and its tab or terminal comes to the front. <code>Ctrl+Alt+Shift+J</code> goes straight to the session that has waited longest; press it again to cycle through the others that need you.</td>
  </tr>
  <tr>
    <td><b>Notify</b></td>
    <td>A notification with a Jump button when a session starts to wait for you, and optionally when one finishes. Neither fires for the session you are looking at.</td>
  </tr>
  <tr>
    <td><b>No&nbsp;setup</b></td>
    <td>Lookout reads the state the agent already records on disk. It installs no hooks, reads no credentials, and sends nothing off the machine. The only program it starts is Claude Code's own binary, to refresh the usage numbers when you ask.</td>
  </tr>
</table>

### Session states

| State | Meaning |
| --- | --- |
| Needs you | The session is blocked on you: a permission prompt or a question. The reason is shown next to it. |
| Finished | The session finished a turn while you were not looking at it. The mark clears when you open its tab or terminal, and survives a window reload. |
| Working | The session is running a turn. |
| Idle | The session waits for the next prompt. |
| State unknown | The session runs an agent version that doesn't record its state. A session in its first minute counts as idle instead. |
| Earlier | Not running. Its transcript is still there, so it can be searched, read in the conversation tab, and resumed. |

## Supported agents

| Agent | Watch | Jump |
| --- | --- | --- |
| [Claude Code](https://claude.com/claude-code) | Sessions in the VS Code panel and in terminals; past sessions of the window's folders | Sessions in the VS Code panel and in the integrated terminals of the same window; past sessions resume in the panel |

Sessions in another VS Code window are listed with that window's name; sessions in a terminal outside VS Code are listed as such. Neither can be jumped to from this window, but both can be searched and read.

## Install

Download `lookout-<version>.vsix` from the [Releases page](https://github.com/nimrod-teich/lookout/releases) and install it:

```bash
code --install-extension lookout-<version>.vsix
```

Or build it from source:

```bash
git clone https://github.com/nimrod-teich/lookout.git
cd lookout
npm install
npm run package
code --install-extension lookout-*.vsix
```

Updating an installed copy restarts the extension host, which ends the agent sessions that window hosts. Update when they are idle.

### Requirements

- VS Code 1.94 or newer.
- The extension runs where the agent runs: Linux, macOS or Windows, including WSL and remote hosts (SSH, containers), since it lives on the remote side there.
- A recent version of a [supported agent](#supported-agents).

Windows and macOS support is new. The process handling is tested on both in CI; neither has been run against a live agent session yet.

## Commands and settings

| Command | Key | What it does |
| --- | --- | --- |
| `Lookout: Jump to Session` | `Ctrl+Alt+J` | Lists the sessions and brings the chosen one's tab or terminal to the front. Clicking the status bar item runs it too. |
| `Lookout: Jump to Next Session That Needs You` | `Ctrl+Alt+Shift+J` | Jumps to the session that has waited longest for you, then to the finished ones. Each press moves to the next. |
| `Lookout: Mark All Sessions as Seen` | | Clears every "finished" mark. |
| `Lookout: Show Sessions` | | Opens the board. |
| `Lookout: Refresh Usage` | | Has Claude Code fetch the account's usage again. |

| Setting | Default | Description |
| --- | --- | --- |
| `lookout.statusBar.enabled` | `true` | Show the session counts in the status bar. |
| `lookout.statusBar.showUsage` | `true` | Show the 5-hour usage as a coloured bar in the status bar item; the hover lists every limit. |
| `lookout.usage.refresh` | `auto` | `auto`: fetch when the numbers are older than 10 minutes, at most every 5 minutes. `manual`: fetch only on `Lookout: Refresh Usage`. `off`: never start the Claude Code binary; show only what it cached. |
| `lookout.notifications.waiting` | `true` | Notify when a session of this window starts to wait for you and you are not looking at it. |
| `lookout.notifications.done` | `false` | Notify when a session of this window finishes a turn and you are not looking at it. |
| `lookout.claudeConfigDir` | `""` | Claude Code config directory to read sessions from. Empty uses `CLAUDE_CONFIG_DIR` from the Claude Code extension's settings or the environment, then `~/.claude`. |

## How it works

| What | Where it comes from |
| --- | --- |
| Which processes are alive, and their parents | Linux: `/proc`. Windows: a process list from PowerShell, read in the background and cached. |
| Where a session runs | A panel session descends from the window's extension host. A terminal session descends from the shell of one of the window's terminals. A session that descends from another window's extension host is named after that window: every window with Lookout records itself in a shared folder under the extension's global storage. |
| When to look again | The agent's session folder is watched for changes, with a poll every 5 s as a backstop. |
| Finished turns | Lookout sees a session go from working to idle while its tab or terminal is not the one in front. |

With Claude Code:

| What | Where it comes from |
| --- | --- |
| Which sessions exist, and their state | `<config>/sessions/<pid>.json`, one file per Claude Code process. A file counts only while its process is alive. |
| Title, current directory, activity | The session's transcript, `<config>/projects/<project>/<session-id>.jsonl`, read incrementally. A tool call with no result yet is what the session is doing; the first line of the latest assistant message is what it last said. |
| Tokens and price | Claude Code writes a cost checkpoint into the transcript now and then (`cost-state`: tokens per model and its own price in USD, subagents included). Lookout reads from the last checkpoint and adds the main transcript's usage since, priced at Anthropic's list rates (cache writes at 1.25× input for 5-minute entries, 2× for 1-hour ones). Subagent usage after the checkpoint is not counted, and a model Lookout has no price for leaves the price out. |
| Jumping to a panel session | The Claude Code extension's `claude-vscode.editor.open` command with the session id; if that fails, the tab whose label matches the session title. |
| Earlier sessions | The transcript files of the folders open in the window, `<config>/projects/<folder>/<session-id>.jsonl`, minus the live ones and the ones the Claude Code extension archived. The archived list is the extension's own state, which VS Code keeps in its state database next to the extensions' storage (`state.vscdb`, read with Node's sqlite); under WSL that database is on the Windows side, so the Windows user folders are looked at too. When it cannot be read, every past session is listed. A title comes from the transcript's first lines and its last, where Claude Code stamps it again on resume; a transcript with no conversation is left out. |
| Search | The transcript again: what you wrote and what the agent replied, not tool calls or their output, nor subagents. Each transcript, live or earlier, is read into memory the first time you search, then only what was appended; a search reads unread conversations for 150 ms at a time and the board asks again until all are read, saying how many are left. Every word of the query must appear in one message; the newest three matches per session are shown on the cards. The conversation tab is Lookout's own: the agent's panel cannot be scrolled to a message from outside, so the tab shows the whole conversation, searchable, and a button brings the agent's own tab forward. It follows the conversation as it grows. |
| Usage | `~/.claude.json`, where Claude Code caches the usage it last fetched. A refresh starts the Claude Code binary bundled with the Claude Code extension and sends it a `get_usage` request; it fetches with its own credentials, calls no model, and rewrites its cache. Lookout never reads your credentials. |

These files and that command are internal to Claude Code and can change between versions.

## Development

Node 22 or newer.

```bash
npm run check   # type-check
npm run lint
npm test
npm run build   # bundle to dist/
```

`src/core` has no dependency on the VS Code API and is tested against temporary directories. `src/vscode` is tested against a stub of the `vscode` module (`test/vscode/stub-vscode.ts`). `src/webview` is the board's page. Press F5 in VS Code to run the extension in an Extension Development Host, or open `preview/index.html` in a browser after `npm run build` to see the board with fixture sessions (`?theme=light`, `?fixture=empty`).

### Adding an agent

An agent is an `AgentProvider` (`src/core/agents/agent.ts`): it reports the agent's live sessions with a status, a title and a current directory. Location, ordering, finished marks, the status bar, the jump list and notifications work on those reports and need no change. `src/core/agents/claude` is the one provider; the controller (`src/vscode/controller.ts`) lists the providers it polls. An agent that hosts sessions in its own editor panel also gets a `PanelAdapter` (`src/vscode/agents`) to bring a session's tab to the front.

### Releasing

Set the version in `package.json`, add its section to `CHANGELOG.md`, and push a tag `v<version>`. The release workflow publishes a GitHub Release with the `.vsix` attached.

## License

[MIT](LICENSE)

---

<p align="center"><sub>Lookout is an independent project. It is not affiliated with or endorsed by Anthropic or any other agent vendor.</sub></p>
