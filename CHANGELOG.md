# Changelog

## 0.1.0

First release.

- **Board.** A view in the activity bar. At the top, the harbour: a night scene with the lighthouse, its sweeping beam, and the sessions as boats on the water, placed by state and by time in that state; the beam lights the boats it passes and swings to a boat before a jump, and the tide rises with the 5-hour usage. Below, one card per session, grouped by state, showing what each session is doing, its tool calls per minute over the last 15 minutes, how full its context window is, the tokens it has used with their price at API list rates, its project, where it runs and its model. Click a boat or a card to jump; rename a session from its card through the agent's own rename; hide a state group with a click on the legend.
- **Status bar.** Counts of sessions that are working, waiting for you, and finished since you last looked, with a spinner while any session works and a highlighted background while any session waits. The hover list shows every session's title, project, worktree and state.
- **Jump.** `Lookout: Jump to Session` (`Ctrl+Alt+J`) lists the sessions, the ones that need attention first, with how long each has been in its state, and brings the chosen one's tab or terminal to the front. `Lookout: Jump to Next Session That Needs You` (`Ctrl+Alt+Shift+J`) goes straight to the one that has waited longest and cycles through the rest on repeated presses.
- **Finished turns.** A session that finishes a turn while you are not looking at it is marked finished until you open its tab or terminal; the marks survive a window reload. `Lookout: Mark All Sessions as Seen` clears them.
- **Notifications.** A notification with a Jump button when a session starts to wait for you (`lookout.notifications.waiting`, on by default) or finishes a turn (`lookout.notifications.done`, off by default).
- **Usage.** The 5-hour and weekly limits in the status bar item and on the board (bars coloured by consumption: amber from half, red from 80%), from Claude Code's cache. Claude Code fetches them again when they are older than 10 minutes (`lookout.usage.refresh`: `auto`, `manual` or `off`); `Lookout: Refresh Usage` fetches at once.
- **Remote Control.** A "Remote" switch on every card turns Claude Code's Remote Control on or off for that session, so it can be driven from claude.ai/code or the Claude app. A session in a terminal of this window gets `/remote-control` typed into it; a session in the Claude Code panel is brought to the front with the command to type. The switch stays lit while Remote Control is on.
- **Agents.** Claude Code: sessions in the VS Code panel and in integrated terminals. Sessions in another VS Code window are listed with that window's name.
- **Icon.** The lighthouse is the mark everywhere: the activity bar, and the status bar item through an icon font the extension ships.
- **Platforms.** Linux, WSL, Linux remotes, and Windows.
