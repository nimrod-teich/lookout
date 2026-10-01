# Changelog

## 0.1.0

First release.

- **Status bar.** Counts of sessions that are working, waiting for you, and finished since you last looked, with a spinner while any session works and a highlighted background while any session waits. The hover list shows every session's title, project, worktree and state.
- **Jump.** `Lookout: Jump to Session` (`Ctrl+Alt+J`) lists the sessions, the ones that need attention first, with how long each has been in its state, and brings the chosen one's tab or terminal to the front. `Lookout: Jump to Next Session That Needs You` (`Ctrl+Alt+Shift+J`) goes straight to the one that has waited longest and cycles through the rest on repeated presses.
- **Finished turns.** A session that finishes a turn while you are not looking at it is marked finished until you open its tab or terminal; the marks survive a window reload. `Lookout: Mark All Sessions as Seen` clears them.
- **Notifications.** A notification with a Jump button when a session starts to wait for you (`lookout.notifications.waiting`, on by default) or finishes a turn (`lookout.notifications.done`, off by default).
- **Agents.** Claude Code: sessions in the VS Code panel and in integrated terminals. Sessions in another VS Code window are listed with that window's name.
- **Platforms.** Linux, WSL, Linux remotes, and Windows.
