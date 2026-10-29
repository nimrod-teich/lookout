# Several Claude accounts

Lookout tells several Claude accounts on one machine apart, whether each has a config directory of its own or you switch the one sign-in. This page says how to set up each, and what Lookout then shows.

## A config directory per account

This is the setup Anthropic's docs describe. Each account keeps its own config directory, chosen by `CLAUDE_CONFIG_DIR`, with its own settings, sessions and sign-in, and both accounts can run at once:

```bash
# In ~/.zshrc or ~/.bashrc: `claude` keeps the account in ~/.claude,
# `claude-personal` uses ~/.claude-personal.
alias claude-personal='CLAUDE_CONFIG_DIR=~/.claude-personal claude'
```

Run `claude-personal` once and sign in. Then list the directory in VS Code's user settings:

```json
"lookout.claudeConfigDirs": ["personal=~/.claude-personal"]
```

- **Names.** `label=path` names a directory. Without a label, a directory goes by its name less a leading `.claude-`, and `~/.claude` by `default`. Add `"work=~/.claude"` to the list to name the default one.
- **Spelling.** Claude Code names a directory's stored sign-in after the exact `CLAUDE_CONFIG_DIR` string; on macOS that is its Keychain item's name. Write the path in the setting as the alias writes it. `~` is fine; a trailing slash makes another sign-in.
- **The default directory.** Leave `CLAUDE_CONFIG_DIR` unset for the account in `~/.claude`. Set to `~/.claude`, it still counts as another sign-in to Claude Code, which then asks you to sign in again.
- **Check each sign-in** with `claude auth status --text` and `claude-personal auth status --text`.
- **Credentials in the environment.** A `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` exported in your shell wins over every directory's sign-in. Lookout's usage refreshes run without them. For your own terminals, drop them in the alias. Write `$HOME` there, not `~`: zsh leaves a `~` after `=` as it is when it is a command's argument.

  ```bash
  alias claude-personal='env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY CLAUDE_CONFIG_DIR="$HOME/.claude-personal" claude'
  ```

- **The Claude Code panel** in VS Code runs one directory, the first one Lookout watches: `lookout.claudeConfigDir`, else the Claude Code extension's `CLAUDE_CONFIG_DIR`, else the environment's, else `~/.claude`. An earlier session of another directory resumes in a terminal instead: `claude --resume <id>` in its folder, with that directory in `CLAUDE_CONFIG_DIR` and without the two variables.
- **Two directories on one account** show one usage tab, which names both in its hover.

## Accounts switched in one directory

If you switch the one sign-in in `~/.claude`, with `/login` or a tool that swaps it, every session is in the one directory and the board already shows them all. To have each say which account it ran on, name the accounts by their e-mail address:

```json
"lookout.claudeAccountNames": { "you@work.example": "work", "you@home.example": "personal" }
```

- **How Lookout tells them apart.** Claude Code stamps the organization of the account into a session's transcript each time the session starts or resumes, since around version 2.1.280. Lookout learns which organization is whose when a directory it watches is signed in to that account, so sign in to each account once while VS Code runs. It keeps a hash of the address, never the address.
- **Usage** is the signed-in account's, under its name. The other account's numbers come back when you switch back and they are fetched again.
- **What carries no name:** sessions from before the stamps, and accounts never signed in while Lookout ran.
- **With directories too,** a named account's name replaces its directory's label.

## What you see

Once Lookout watches two or more accounts:

- **Cards.** A chip with the account on every Claude Code card, running, earlier or starred. The jump list, the search page, the conversation tab and the notes name it too, and **Group by: Account** makes a section per account.
- **Usage.** A tab per account on the board, each with its own refresh, its own wait after a 429 and its own alerts: "Your 5-hour limit (personal) is at 90%".
- **Status bar.** The window under the most pressure across the accounts, with the account's name before the bar. `lookout.statusBar.usageAgent` pins one account: `claude:personal`.
- **`Lookout: Refresh Usage`** asks which account to fetch, or all.
- **Lookout's output** lists the directories it watches, and says which have no sign-in yet and which share an account. It never logs an e-mail address.

## Where the sign-ins are

On macOS, Claude Code keeps each directory's sign-in in a Keychain item of its own, `Claude Code-credentials` for `~/.claude` without the variable and one named after the directory otherwise. On Linux and Windows it keeps a `.credentials.json` inside each directory. Lookout reads neither: a refresh runs Claude Code's own binary, which uses the sign-in itself.
