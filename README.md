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

<p align="center"><b>Every AI coding agent session at a glance: what is working, what needs you, and where.</b><br>Works with Claude Code, Codex and Copilot CLI.</p>

<p align="center">
  <a href="#what-it-does">What it does</a> &nbsp;|&nbsp;
  <a href="#supported-agents">Supported agents</a> &nbsp;|&nbsp;
  <a href="#install">Install</a> &nbsp;|&nbsp;
  <a href="#commands-and-settings">Commands</a> &nbsp;|&nbsp;
  <a href="#how-it-works">How it works</a>
</p>

Running several AI coding agents at once means clicking through tabs and terminals to find out which one finished and which one is stuck on a question. Lookout keeps that answer in the status bar, takes you to the right tab or terminal with one keystroke, and finds any conversation, running or not, by a word you remember from it. Claude Code in its VS Code panel or a terminal, Codex and Copilot CLI in terminals: one board, one jump key, one search, each agent with its own colour and boat once more than one is on the board. It reads only what the agents already write on disk.

## What it does

<table>
  <tr>
    <td><b>Board</b></td>
    <td>The Lookout view in the activity bar. At the top, the harbour: a night scene where every session is a boat on the water. Its lane says its state, its distance from the lighthouse how long it has been there; the beam lights the boats it passes and swings to a boat before a jump, and the tide rises with your 5-hour usage. Hover a boat for the session's details; its card lights up below.</td>
  </tr>
  <tr>
    <td><b>Cards</b></td>
    <td>One card per session, grouped into Needs you, Finished, Working and Idle: the title, time in state, what it asks you when it waits, its tool calls per minute over the last 15 minutes (the bars grow from the left while it is younger than that, and a pin marks the minute the conversation was compacted), a ring for how full its context window is (amber from 75%, red from 90%), the tokens it has used so far with their price at API list rates, its project and worktree, its git branch (`⎇ main`, read from git itself while it runs, so a session working in a worktree shows that worktree's), where it runs, and its model with the reasoning effort of its last reply (`Opus 5.5 · high`). A session that needs you says why and quotes the ask: a permission with the tool and its command or file, a question with its answers, a plan to approve, or another dialog; a reply that ends on a question gets a dashed card. A working session whose transcript has been silent for more than 10 minutes says "quiet" and how long. The card's hover says where its state comes from and how old that is. Click a card to jump to the session: a panel session's tab comes to the front at its newest message, with the cursor in its prompt box, or at the prompt it waits on; a click on its title renames it through the agent; a click on a state in the legend hides that group. A tab or terminal with nothing sent yet is left off the board while it is idle; once it works it is listed as "Empty tab" (or "Empty session" in a terminal) until the agent titles it.</td>
  </tr>
  <tr>
    <td><b>Favourites</b></td>
    <td>A small star on every card, live and earlier, shows when you point at the card; a click stars the session, and its star stays lit. Starred sessions are gathered at the top of the board, newest star first, running or not and whatever project they belong to: a click jumps to a running one, resumes an earlier one of this window's folders, or opens another project's conversation. Stars are kept for the machine, so every window shows them.</td>
  </tr>
  <tr>
    <td><b>Earlier</b></td>
    <td>Under the live sessions, a collapsed group holds the sessions that are not running and that the agent has not archived, newest first: those of this window's folders, or those of every project on the machine, as the toggle on its heading says (<b>This window's folders</b> or <b>All projects</b>, kept per workspace). Each shows its project and the git branch it last worked on. The group lists the newest 500 and says so when there are more; older ones are not listed or searched. It shows 20 at a time: <b>‹ Newer</b> and <b>Older ›</b> under them turn the page, and a search or a change of scope starts again from the newest. Click the heading to open it. Click a session of this window's folders to resume it in the agent's panel; a session of another project opens its conversation instead, because the agent resumes a session only in a window open on its folder.</td>
  </tr>
  <tr>
    <td><b>Archive</b></td>
    <td>An earlier card shows an archive button next to its star when you point at it. A click moves the session to an <b>Archived</b> group under Earlier, collapsed and paged the same way, newest archive first, whatever project it belongs to; the button on an archived card brings it back to Earlier. Archiving takes the session's star away, and a session that runs again leaves the archive. A search covers archived sessions too and opens the group on a match. Lookout keeps this archive itself, for the machine, so every window shows it; it writes nothing to the agents. Sessions archived in Claude Code's own panel, or by Codex, stay out of both groups.</td>
  </tr>
  <tr>
    <td><b>Search</b></td>
    <td>A box above the cards looks through every conversation, live and earlier (in the Earlier group's scope): what you wrote and what the agent replied, not tool traffic. Every word must appear in one message. Operators narrow it: <code>since:</code> and <code>before:</code> keep the messages written in a time (<code>today</code>, <code>yesterday</code>, <code>12h</code>, <code>3d</code>, <code>2w</code>, <code>2026-10-01</code>); <code>project:</code> and <code>branch:</code> keep the sessions whose project, worktree or git branch contains the value; <code>file:</code> keeps the sessions whose tool calls worked on a path containing it. Several <code>project:</code>, <code>branch:</code> or <code>file:</code> values mean any of them; of several times, the narrowest counts; a value with spaces goes in quotes. Days begin at midnight in your time zone, also in a remote window. Operators alone list the sessions they keep. The sessions with matches stay, each with its newest three matches under the card and the words marked; the rest hide until the box is cleared. Big transcripts are read a little at a time, and the box says how many are left.</td>
  </tr>
  <tr>
    <td><b>Search&nbsp;page</b></td>
    <td>The same search with the room to read it, in an editor tab: <code>Lookout: Search All Sessions</code>, the search icon on the board's title bar, or a click on the board's "195 matches in 61 sessions". Every session with matches is listed, the newest match first, with its project, git branch, whether it is running, and up to 20 of its matches, each with who wrote it, when, and the sentence around it. The page takes the same operators as the board. A click on a match opens the conversation tab at that message; a click on a session, or on "+N more", at its newest match.</td>
  </tr>
  <tr>
    <td><b>Conversation&nbsp;tab</b></td>
    <td>A click on a match, or on "+N more", opens that session's whole conversation in an editor tab, scrolled to the match, under its title, project and git branch, in the harbour's night colours with the messages' Markdown rendered: headings, lists, quotes, links, inline code and code blocks. The tab has a search of its own: it marks the words, dims the messages without them, and steps through the matches with Enter and the arrows. It follows the conversation as it grows, and an Open session button brings the agent's own tab or terminal to the front.</td>
  </tr>
  <tr>
    <td><b>Usage</b></td>
    <td>Every limit of the account on the board and in the status bar's hover, as Claude Code's own panel shows them: <b>Session (5hr)</b>, <b>Weekly (7 day)</b> and the per-model weekly limits such as <b>Weekly Fable</b>, each with its share used and when it resets ("Resets in 3h"). The session limit also shows as a coloured bar in the status bar item, with the time to its reset: <code>32% · 1h12m</code>. The bars turn amber from half and red from 80%; a card's context ring turns amber from 75% and red from 90%. Lookout says once per window when the 5-hour window reaches 70% and 90% and the week 90%, in the VS Code window in front when there is one. Numbers more than 30 minutes old, or from before a reset, turn grey. Claude Code fetches the numbers again when they are older than 10 minutes or a window has reset, with its own credentials: at most once every 3 minutes on the machine, and less often while fetches fail. <code>Lookout: Refresh Usage</code> fetches at once, unless a fetch started in the last 3 minutes. When more than one agent reports usage, each has its own group, its limits named as that agent names them, and the status bar's bar shows the window under the most pressure, after that agent's boat (<code>lookout.statusBar.usageAgent</code> pins one agent). Codex's group shows its <b>5h limit</b> and <b>Weekly limit</b> as Codex's own <code>/status</code> names them, from what Codex records with each reply, so its numbers are as fresh as its last reply and turn grey after 30 minutes like Claude's; Lookout cannot fetch them anew. The same alerts go out for Codex's windows, named for Codex.</td>
  </tr>
  <tr>
    <td><b>Watch</b></td>
    <td>One status bar item shows how many sessions are working (a clock for those gone quiet), how many wait for you, how many finished since you last looked, and your 5-hour usage as a ten-cell bar coloured by consumption, with the time to its reset. Its background lights up while any session waits on a prompt the agent reports. Hover for every session's title, project, worktree and state, what each waiting one asks, and every usage limit.</td>
  </tr>
  <tr>
    <td><b>Jump</b></td>
    <td><code>Ctrl+Alt+J</code> lists the sessions, the ones that need attention first, with how long each has been in its state and what each waiting one asks. Pick one and its tab or terminal comes to the front. A session in another VS Code window on the same machine works too: that window brings its tab or terminal forward and comes to the front itself; when the desktop does not let it, Lookout says which window to switch to. <code>Ctrl+Alt+Shift+J</code> goes straight to the session of this window that has waited longest; press it again to cycle through the others that need you.</td>
  </tr>
  <tr>
    <td><b>Notify</b></td>
    <td>A notification with a Jump button when a session starts to wait for you, saying why and quoting the ask, and optionally when one finishes. Neither fires for the session you are looking at. While VS Code is not the window in front, the same notification also shows on your desktop, with a sound if you want one; it cannot jump, so it names <code>Ctrl+Alt+Shift+J</code>. A session gets at most one desktop notification per event every 30 seconds, and while three or more sessions need you, one notification sums them up.</td>
  </tr>
  <tr>
    <td><b>No&nbsp;setup</b></td>
    <td>Lookout reads the state the agent already records on disk. It installs no hooks, reads no credentials, and sends nothing off the machine. The programs it starts are Claude Code's own binary, to refresh the usage numbers, your desktop's own notifier for desktop notifications, and, on macOS and Windows, the system's process list (`ps` and `lsof`, Windows PowerShell) to find the agents' processes.</td>
  </tr>
</table>

### Session states

| State | Meaning |
| --- | --- |
| Needs you | The session is blocked on you, and the card says why: a **permission** (the tool and what it would run or change, e.g. `Bash: npm test`, or the call a subagent waits on), a **question** (with its answers), a **plan** to approve, or another **dialog** (the agent's own word for it). A session of this window whose last reply asks you something, ending on a question mark or asking for a choice or a yes/no, is here too, after the prompts, marked as **asked you a question** with a dashed card: Lookout read it from the reply rather than from the agent, so it is less certain. It stays until the session works again or you dismiss it with the card's ✓. |
| Finished | The session finished a turn while you were not looking at it. The mark clears when you open its tab or terminal, and survives a window reload. For a session in a terminal, "looking" means you were last in that terminal: you brought it forward or sent its session a prompt, and switched to no tab, typed in no editor and prompted no panel session since. VS Code keeps a terminal its active one while you work elsewhere, so that alone does not count. |
| Working | The session is running a turn. |
| Working in the background | Its turn is over, but shell commands it started (`run_in_background`) still run: the card says "1 background job · 2h", and how long they were busy, "busy 45m", counting the looks at which their processes used CPU or their output grew. With no CPU and no output for 15 minutes it says "idle 20m: may be stuck"; when Claude Code has deleted a job's output file, as after a restart, it says "orphaned". When the last job ends the session is Finished. Linux and WSL. |
| Idle | The session waits for the next prompt. After a window reload the agent restores its tabs but starts a session only once you open its tab: until then the card says "Tab open · not started", from the session's transcript, and a click opens the tab. Tabs of this window's folders only; another project's tab opens blank. |
| State unknown | The session's file records no state, or cannot be read. Lookout does not guess; the card says which. A session in its first minute counts as idle, from its process's start. |
| Earlier | Not running. Its transcript is still there, so it can be searched, read in the conversation tab, and resumed from a window open on its folder. |

## Supported agents

| Agent | Live sessions | Jump to terminal | Jump to tab | Rename | Resume | Search | Usage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [Claude Code](https://claude.com/claude-code) | ✓ in the VS Code panel and in terminals | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| [Codex](https://github.com/openai/codex) | ✓ the Codex extension's panel, the `codex` program in terminals, and `codex exec` runs | ✓ | ✓ | — | ✓ in the panel or a terminal | ✓ | ✓ |
| [Copilot CLI](https://github.com/github/copilot-cli) | ✓ the `copilot` program in terminals | ✓ | — | — | ✓ in a terminal | ✓ | — |

**Live sessions**: where Lookout finds the agent's running sessions. **Jump to terminal** and **Jump to tab**: Lookout brings a session in a VS Code terminal, or in the agent's own editor tab, to the front, in any VS Code window on the same machine. **Rename**: a click on a card's title renames the session through the agent (Claude: its own rename in the panel, `/rename` in a terminal). **Resume**: a click on an earlier session of this window's folders resumes it (Claude: in its panel; Codex: a thread of its extension in the extension, any other with `codex resume <id>`; Copilot: `copilot --resume <id>`; each command in a new terminal in the session's folder). **Search**: the board's search, the search page and the conversation tab read the agent's conversations. **Usage**: the account's limits on the board and in the status bar. Copilot CLI records each session's premium requests and AI credits, but not the account's monthly allowance, so it has no usage group; its cards show their tokens. Where an agent lacks one, Lookout leaves that action out rather than offering one that fails.

The Copilot chats in VS Code's own Chat and Agents views are not watched: VS Code keeps them in its workspace storage, its logs showed no confirmation still waiting, and its commands that open one take VS Code's own session object rather than an id. Copilot CLI sessions in a terminal are watched.

Each agent has its own colour and boat: Claude a coral sloop, Codex a teal cutter, Copilot a violet ferry. Once the board shows two or more agents, running, among the earlier sessions or in the usage, they mark every place a session shows: the boat's hull and sails in the harbour (its lantern keeps the state's colour), a thin edge on the card and a small boat before its title, a chip per agent in the legend that hides that agent's sessions, usage and search matches, the jump list, the status bar's hover, the usage groups, the search page and the conversation tab, with the agent's name in hovers and lists. With one agent nothing changes (`lookout.agentMarkers` shows them always, or never). Red, amber and green stay the colours of states and usage; the agents' colours differ from them and from each other in lightness too, and a boat always stands next to the colour.

Sessions in another VS Code window are listed with that window's name, and a jump to one goes through that window. Windows see each other through a folder in the extension's global storage, so only windows whose extensions run on the same machine, in the same VS Code profile, see each other: a window connected over SSH or to a container sees the other windows connected to the same host, not your local ones. Sessions Lookout cannot bring forward are listed with where they run: **outside VS Code** (a terminal of no VS Code window, a script, `claude -p`, `codex exec` run elsewhere) or **window without Lookout** (an agent's panel in a VS Code window where Lookout is off, or in another editor). A click on one opens its conversation.

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

On SSH and container remotes Lookout runs on the remote machine, where none of your desktop is, so desktop notifications are off there; the notification inside the VS Code window still comes. Under WSL they reach the Windows desktop.

Windows and macOS support is new. The process handling is tested on both in CI; neither has been run against a live agent session yet.

## Commands and settings

| Command | Key | What it does |
| --- | --- | --- |
| `Lookout: Jump to Session` | `Ctrl+Alt+J` | Lists the sessions and brings the chosen one's tab or terminal to the front. Clicking the status bar item runs it too. |
| `Lookout: Jump to Next Session That Needs You` | `Ctrl+Alt+Shift+J` | Jumps to the session that has waited longest for you, then to the finished ones. Each press moves to the next. |
| `Lookout: Mark All Sessions as Seen` | | Clears every "finished" mark. |
| `Lookout: Show Sessions` | | Opens the board. |
| `Lookout: Refresh Usage` | | Has Claude Code fetch the account's usage again. |
| `Lookout: Search All Sessions` | | Opens the search page: every conversation's matches in an editor tab. |

| Setting | Default | Description |
| --- | --- | --- |
| `lookout.statusBar.enabled` | `true` | Show the session counts in the status bar. |
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
| `lookout.agents.codex` | `true` | Watch Codex sessions: the `codex` program in a terminal. |
| `lookout.codexHome` | `""` | Codex's home folder, where its `sessions` are. Empty uses `CODEX_HOME`, then `~/.codex`. |
| `lookout.agents.copilot` | `true` | Watch Copilot CLI sessions: the `copilot` program in a terminal. |
| `lookout.copilotHome` | `""` | Copilot CLI's home folder, where its `session-state` is. Empty uses `COPILOT_HOME`, then `~/.copilot`. |
| `lookout.claudeConfigDir` | `""` | Claude Code config directory to read sessions from. Empty uses `CLAUDE_CONFIG_DIR` from the Claude Code extension's settings or the environment, then `~/.claude`. |

## How it works

| What | Where it comes from |
| --- | --- |
| Which processes are alive, and their parents | Linux: `/proc`. Windows: a process list from PowerShell, read in the background and cached. |
| Where a session runs | A panel session descends from the window's extension host. A terminal session descends from the shell of one of the window's terminals. Every window with Lookout records itself in a shared folder under the extension's global storage, with its name and its terminals' shell pids, so a session that descends from another window's extension host or from one of its terminals' shells is named after that window. An agent's panel session that descends from none of them runs in a window without Lookout; anything else runs outside VS Code. |
| Jumping to another window's session | A request in the same shared folder, `jump-<pid of that window's extension host>-<time>.json`, naming the session and the window that asks. Every window watches the folder, and looks every second besides; the one it names brings the session's tab or terminal forward, comes to the front, and answers with `jumped-<pid>-<time>.json`. To come to the front it runs VS Code's own `workbench.action.focusWindow`; when the desktop does not let it, it finds its own window by its title, whose folder part and application name must both match, with `xdotool` or `wmctrl` on X11 (and XWayland), `osascript` on macOS (addressing VS Code's own process), and Windows PowerShell on Windows and from WSL, within 3 seconds in all. It acts only on requests younger than 2 seconds. The window that asked waits 6 seconds; when the other window showed the session but could not come forward, it says "Opened … in window …; switch with Alt+Tab" (⌘\` on a Mac, Alt+\` on GNOME); with no answer, it takes its request back and says so. Mail older than 10 seconds is ignored and removed. |
| When to look again | The agent's session folder is watched for changes, with a poll every 5 s as a backstop. |
| Which agent a session belongs to | The agent whose records it comes from. Lookout's own list of agents gives each one its name, colour and boat, and says which of Lookout's actions it allows. |
| Finished turns | Lookout sees a session go from working to idle while its tab is not the one in front, or, for a terminal session, while you were last somewhere other than its terminal. VS Code tells an extension which tab is in front and which terminal is the active one, not whether you are in that terminal; clicking into a terminal, or back into the tab in front, sends no event, so Lookout goes by where you last brought forward, typed or sent a prompt. |
| Usage refresh | Every window on the host records its refreshes as files in a folder under the extension's global storage, each one created exclusively, so one window makes each attempt: one every 3 minutes on the host at most, and when an attempt leaves the numbers as they were, the next one at the same numbers waits twice as long, up to 30 minutes. |
| Usage alerts | Each alert is a file named after the source of the numbers, the limit, the threshold and the window's reset minute, created exclusively in a folder under the extension's global storage; the window that creates it announces. A window in front claims at once; the others wait 10 seconds first, so the alert shows where you are. Stale numbers, and windows that have reset, are never announced. |
| Desktop notifications | The desktop's own tools, run without a shell and stopped if they take longer than 2 seconds (Windows PowerShell, which starts slower, 5): `notify-send` on Linux (sound with `paplay` or `canberra-gtk-play`), `osascript`'s `display notification` on macOS (sound with `afplay`), and a Windows toast shown by Windows PowerShell on Windows and from WSL (the toast says it comes from Windows PowerShell). Which of them are there is checked once. Nothing is sent from SSH or container remotes. |

With Claude Code:

| What | Where it comes from |
| --- | --- |
| Which sessions exist, and their state | `<config>/sessions/<pid>.json`, one file per Claude Code process. A file counts only while its process is alive. A file that still does not parse two seconds after it was written leaves the state unknown. |
| Why a session waits | The session file's `waitingFor`, filed the way Claude Code files it (`permission prompt`, `sandbox request`, `worker request` and `goal proposal` are permissions, `input needed` a question, `dialog open` a dialog), and its own line for the dialog when it writes one (`needs`). Otherwise the tool call still open in the transcript: its command, file or address, an AskUserQuestion's question and answers, an ExitPlanMode's plan (or the plan file, `<config>/plans/<slug>.md`); for a subagent's call, the subagent transcript written last. Claude Code can write the tool call a moment after the wait, so a notification of a bare permission prompt waits up to two seconds for it. |
| Asked you a question | The session's last reply, when no tool call, prompt or interrupt came after it and its last paragraph ends with a question mark or asks for a choice or a yes/no. Code blocks don't count. |
| Quiet | When the transcript was last written, or one of its subagents' transcripts. |
| Title, current directory, activity | The session's transcript, `<config>/projects/<project>/<session-id>.jsonl`, read incrementally. A tool call with no result yet is what the session is doing. |
| Compactions | The pins on the pulse: the transcript's `compact_boundary` system entries and `isCompactSummary` user entries. Claude Code writes both for one compaction, well under a second apart, so marks less than 10 seconds apart are one; a summary alone, as in older transcripts, counts too. Subagents' compactions are left out. |
| Tokens and price | Claude Code writes a cost checkpoint into the transcript now and then (`cost-state`: tokens per model and its own price in USD, subagents included). Lookout reads from the last checkpoint and adds the main transcript's usage since, priced at Anthropic's list rates (cache writes at 1.25× input for 5-minute entries, 2× for 1-hour ones). Subagent usage after the checkpoint is not counted, and a model Lookout has no price for leaves the price out. |
| Jumping to a panel session | The Claude Code extension's `claude-vscode.editor.open` command with the session id; if that fails, the tab whose label matches the session title. |
| Earlier sessions | The transcript files of the folders open in the window, `<config>/projects/<folder>/<session-id>.jsonl`, or, for All projects, of every folder under `<config>/projects`, looked through again at most every 15 seconds; minus the live ones and the ones the Claude Code extension archived. The newest 500 with a conversation are listed; a list reads at most 120 new transcripts and the next list follows a moment later, so a long history fills in within a few seconds. A session of another project shows where it started, the first `cwd` its main chain records, and Claude Code resumes only the sessions of the folder its window is open on, which is why such a session opens its conversation. The branch is the last `gitBranch` of the main chain, so a subagent's never counts. The archived list is the extension's own state, which VS Code keeps in its state database next to the extensions' storage (`state.vscdb`, read with Node's sqlite); under WSL that database is on the Windows side, so the Windows user folders are looked at too. When it cannot be read, every past session is listed. A title comes from the transcript's first lines (up to 1 MB in, when Claude Code wrote large request records first) and its last, where Claude Code stamps it again on resume; a transcript with no conversation is left out. |
| Search | The transcript again: what you wrote and what the agent replied, not tool calls or their output, nor subagents. `since:` and `before:` go by each message's own time; the board sends its time zone along, so days are yours even when the extension runs on a remote host with another clock. An earlier transcript last written before a `since:` is not read at all. `file:` goes by the paths the main chain's tool calls name in their input (`file_path`, `path`, `pattern`, `notebook_path`), collected while the transcript is read; tool results are never looked at for paths. Each transcript, live or earlier, is read into memory the first time you search, then only what was appended; a search reads unread conversations for 150 ms at a time and the board asks again until all are read, saying how many are left. Every word of the query must appear in one message; the newest three matches per session are shown on the cards. The conversation tab is Lookout's own: the agent's panel cannot be scrolled to a message from outside, so the tab shows the whole conversation, searchable, and a button brings the agent's own tab forward. It follows the conversation as it grows. |
| Usage | `~/.claude.json`, where Claude Code caches the usage it last fetched (`cachedUsageUtilization`); with another config directory, `.claude.json` inside it. Numbers cached for another account than the signed-in one, or a cache that does not parse, show "No usage reported". A refresh starts the Claude Code binary bundled with the Claude Code extension, with `CLAUDE_CONFIG_DIR` set to the config directory Lookout reads, and sends it a `get_usage` request; it fetches with its own credentials, calls no model, and rewrites its cache. The numbers shown then come from that cache, not from the binary's answer; a refresh that leaves the cache as it was counts as failed. Lookout never reads your credentials. No refresh starts while `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set in VS Code's environment, in the Claude Code extension's `claudeCode.environmentVariables`, or in the `env` of Claude Code's `settings.json` (read before each refresh, never written); <code>Lookout: Refresh Usage</code> says so. |

These files and that command are internal to Claude Code and can change between versions.

With Codex (checked against Codex 0.163.0), which keeps no file per running session, so Lookout reads the state from what Codex appends to its rollouts and says so in the card's hover ("From the rollout tail"):

| What | Where it comes from |
| --- | --- |
| Which sessions exist | The `codex` processes running interactively: `codex`, `codex "<prompt>"`, `codex resume`, `codex fork`. Linux: `/proc`, with each process's directory. macOS: `ps`, and each new process's directory once from `lsof`. Windows: the process list from PowerShell, which gives no directory. A session with nothing sent yet has no rollout and stays off the board while it is idle; so does one waiting on Codex's own start-up questions, such as whether to trust a folder, which Codex writes nowhere. And the threads a `codex app-server` (the Codex extension's, one per window) or a `codex exec` run holds: a process that loads a thread holds `<home>/thread-writer-locks/<thread id>.lock` open until it lets the thread go, read from the process's open files (Linux: `/proc/<pid>/fd`; macOS: `lsof`). The daemon that serves the terminal program (`app-server --managed-daemon`) keeps a thread loaded after its terminal has ended, so its locks are not read. Windows tells no process's open files: there a thread the extension wrote in the last 10 minutes counts as loaded in its newest app-server. |
| Where a thread of the extension runs | In the panel of the window whose extension host runs its app-server. The extension keeps a thread loaded until no view of it is open and it has been idle for three hours, or more than ten such threads are loaded, so a thread you switched away from stays on the board, idle, until then. |
| Which rollout is whose | Codex writes each thread to `<home>/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`, its first line `session_meta` with the thread's id, directory (`cwd`) and who wrote it (`originator`, `codex-tui` for the terminal program). Codex neither names its thread anywhere a process can be tied to nor keeps the file open, so: `codex resume <id>` names its thread; otherwise a process takes a rollout of its own directory written while it ran, the newest process first, each preferring a thread created after it started, then the one written last (a thread switched to with `/new` or `/resume` counts), then, of two written in the same second, the one that moved since the last look. Threads the terminal program wrote go before those of other originators. Two sessions in one folder can trade places when one switches threads after the other started. |
| State | The rollout's last records: `event_msg` `task_started` opens a turn (working), `task_complete` or `turn_aborted` ends it (idle); a turn read from its middle goes by the last record. A record Codex writes after an interrupt, when a command it left running in the background ends, does not reopen the turn. The last reply is `event_msg` `item_completed` with an `AgentMessage` in a terminal's thread, and `event_msg` `agent_message` in the extension's. |
| Why a session waits | A command Codex runs is a `response_item` `custom_tool_call` named `exec`, whose input calls `tools.exec_command({cmd, …})`; one that asks for `sandbox_permissions: "require_escalated"` and has no `custom_tool_call_output` yet is waiting for your approval: a **permission**, quoting the command, with Codex's justification kept as its own words. Codex writes no event for the approval prompt itself, and an approved command's result follows within a second while it runs on in the background, so a wait is read right after approval for that second at most. A `function_call` `request_user_input_async` with a question and its options is a **question**: Codex accepts it at once and ends the turn, and it stays open until your next message. A reply that ends on a question is read as for Claude. |
| Title | Codex's own name for the thread, from `<home>/session_index.jsonl` (`thread_name`); before Codex names it, the first prompt, cut to 60 characters. |
| Model, effort, context | `turn_context` (`model`, the collaboration mode's `reasoning_effort`); `event_msg` `token_count` (`last_token_usage.total_tokens` of `model_context_window`). |
| Branch | Read from git itself in the session's directory: Codex's rollouts record none. |
| Quiet, pulse, activity | When the rollout was last written; the times of its tool calls; the command of the last call without a result. |
| When to look again | The sessions folder is watched, its date folders included, with the poll every 5 s as a backstop. |
| Earlier sessions | Every rollout under `<home>/sessions`, looked through again at most every 15 seconds, minus the live ones; Codex moves archived threads to `<home>/archived_sessions`, which is not read. A thread's folder is its `session_meta.cwd`, read once per file; a list reads at most 120 new rollouts and the next list goes on, so a long history fills in within a few seconds. This window's folders means threads whose folder is one of them or inside one. Titles as for live sessions. Codex records no branch, so earlier Codex sessions show none and `branch:` never picks them. Rollouts Codex compressed (`.jsonl.zst`) are not read, since Lookout carries no decompressor: the Earlier group says how many were left out. |
| Search, conversation tab | The `response_item` messages: yours, without the context Codex adds (`<environment_context>` and the like), and Codex's, its progress notes and its answers; not tool calls or their output. `file:` goes by the files Codex changed (`item_completed` `FileChange`, keyed by path) and the paths of the commands it parsed as reads, listings and searches (`parsed_cmd`). Read a little at a time, as for Claude. |
| Resume | `codex resume <id>` in a new terminal named after the session, in the folder the thread worked in; Codex appends to the same rollout. A thread the extension wrote (`originator` `codex_vscode`) opens in the extension instead, as a jump does. |
| Jump to a thread of the extension | The thread in the extension's editor (the address `openai-codex://route/local/<thread id>` in `chatgpt.conversationEditor`): its tab, brought to the front in its own group, or a new tab, where the thread shows as in the side bar, an approval prompt included; a new tab takes a few seconds to load. The side bar shows one thread at a time, and the only way to point it at another, the extension's link `vscode://openai.chatgpt/local/<thread id>`, makes VS Code ask whether the extension may open it, so Lookout does not use it. |
| Usage | `event_msg` `token_count`'s `rate_limits`: `primary` and `secondary`, each with `used_percent`, `window_minutes` and `resets_at` (epoch seconds; `resets_in_seconds` counts from the record's time). The 300-minute window is shown as **5h limit** and the 10,080-minute one as **Weekly limit**, as Codex's `/status` names them; another length is named by it ("1h limit"). The newest reading of the live sessions' rollouts counts, or, with none running, the newest rollout of the last week's; its time is the record's, so the numbers turn grey 30 minutes after Codex last replied. A `token_count` whose `rate_limits` is null (Codex signed in with an API key) leaves the group out. |
| Tokens and price | The thread's totals, `token_count` `total_token_usage` (input, of it cached, cache writes, output). The price is API-equivalent, since a ChatGPT plan is not billed per token: each reply's `token_usage_record` at OpenAI's list prices for its model (`src/core/agents/codex/pricing.ts`, the Standard tier, with the long-context rates above 272K input tokens), each reply counted once. A model with no price there, or a rollout longer than the 8 MB Lookout reads on first sight, shows its tokens without a price. |

With Copilot CLI (checked against Copilot CLI 1.0.98), which keeps a folder per session under `<home>/session-state/<id>/` and says which process holds it:

| What | Where it comes from |
| --- | --- |
| Which sessions exist | A session folder whose `inuse.<pid>.lock` names a running `copilot` process (Linux: `/proc`; macOS: `ps`; Windows: the process list). A session resumed with `copilot --resume <id>` has no lock until something is sent, so a running `copilot` whose command line names a session holds it too. Sessions Copilot runs for an editor (`workspace.yaml` `client_name` other than `github/cli`) are left out. A session with nothing sent stays off the board while it is idle. |
| State | Working or idle: Copilot's own `working` flag for the session in `<home>/open-sessions-state.json` (the card's hover says "From the session file"). Waiting: a `permission.requested` event in the session's `events.jsonl` with no `permission.completed` for its `requestId`: a **permission** quoting the command (`fullCommandText`) or the file (`fileName`), with Copilot's `intention` as its own words. With no flag for a session, a prompt that no turn's end followed is working. A reply that ends on a question is read as for Claude. |
| Title, folder | `workspace.yaml`: `name` (Copilot's title, or yours) and `cwd`; before Copilot names it, the first prompt, cut to 60 characters. |
| Model, effort, context, tokens | `session.usage_record` events: the model, its `reasoningEffort`, the input tokens of its last call of `maxPromptTokens`, and the tokens of each call summed. Copilot bills premium requests, not tokens, so no price is shown. The `model.*` events are Copilot's helper models (the one that names a session, for one) and are left out. |
| Branch | Read from git itself in the session's folder. |
| Earlier sessions, search, conversation tab | The other session folders, newest first, in the same scopes and with the same limits as Codex's; `user.message` and `assistant.message` (`content`) are the messages, and `file:` goes by the paths Copilot's tools named (`path` arguments, an `apply_patch`'s files, a shell command's `possiblePaths`). |
| Resume | `copilot --resume <id>` in a new terminal in the session's folder; Copilot goes on in the same session folder. |
| When to look again | The session folders and the open-sessions file are watched, with the poll every 5 s as a backstop. |

Copilot's home is `lookout.copilotHome`, else `COPILOT_HOME`, else `~/.copilot`. Lookout never reads Copilot's `config.json` or any stored sign-in, and calls nothing of GitHub's. These files are internal to Copilot CLI and can change between versions.

Codex's home is `lookout.codexHome`, else `CODEX_HOME`, else `~/.codex`; Codex has no setting that moves its sessions elsewhere, so its `config.toml` is never read. Lookout never reads Codex's `auth.json` and calls nothing of OpenAI's. These files are internal to Codex and can change between versions.

## Development

Node 22 or newer.

```bash
npm run check   # type-check
npm run lint
npm test
npm run build   # bundle to dist/
```

`src/core` has no dependency on the VS Code API and is tested against temporary directories. `src/vscode` is tested against a stub of the `vscode` module (`test/vscode/stub-vscode.ts`). `src/webview` is the board's page. Press F5 in VS Code to run the extension in an Extension Development Host, or open `preview/index.html` in a browser after `npm run build` to see the board with fixture sessions (`?theme=light`, `?fixture=empty`, `?fixture=reasons` for every kind of wait, `?earlier=1&scope=all` for every project's earlier sessions, `&many=57` for that many to page through, `&archived=2&archiveOpen=1` with two of them archived, `&capped=1` for the note past 500, `?fixture=agents` for three agents side by side, `&hideAgents=codex` with an agent hidden from the legend, `&markers=always` or `never` as the setting).

### Adding an agent

An agent is an `AgentProvider` (`src/core/agents/agent.ts`): it reports the agent's live sessions with a status, a title and a current directory. Location, ordering, finished marks, the status bar, the jump list and notifications work on those reports and need no change. `src/core/agents/claude` is the reference provider; the controller (`src/vscode/controller.ts`) lists the providers it polls. An agent that hosts sessions in its own editor panel also gets a `PanelAdapter` (`src/vscode/agents`) to bring a session's tab to the front.

Every agent also has a row in the catalog, `src/core/agents/catalog.ts`: its id, its name, its colour (a CSS variable, defined in `media/board.css` for dark and light themes and in `media/search.css` and `media/findings.css`), its boat (an SVG path in a 16-unit box, also in `icons/` for the icon font: `npm run icons`) and its capabilities. Nothing else names, colours or draws an agent, and the UI offers only what the capabilities allow. A test holds the colours, the icon files, the settings and the Supported agents table to the catalog. `?fixture=agents` in the board's preview shows three agents side by side.

### Releasing

Set the version in `package.json`, add its section to `CHANGELOG.md`, and push a tag `v<version>`. The release workflow publishes a GitHub Release with the `.vsix` attached.

## License

[MIT](LICENSE)

---

<p align="center"><sub>Lookout is an independent project. It is not affiliated with or endorsed by Anthropic or any other agent vendor.</sub></p>
