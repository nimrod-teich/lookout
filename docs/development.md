# Development

Node 22 or newer.

```bash
npm run check   # type-check
npm run lint
npm test
npm run build   # bundle to dist/
```

`src/core` has no dependency on the VS Code API and is tested against temporary directories. `src/vscode` is tested against a stub of the `vscode` module (`test/vscode/stub-vscode.ts`). `src/webview` is the board's page. Press F5 in VS Code to run the extension in an Extension Development Host, or open `preview/index.html` in a browser after `npm run build` to see the board with fixture sessions (`?theme=light`, `?fixture=empty`, `?fixture=reasons` for every kind of wait, `?earlier=1&scope=all` for every project's earlier sessions, `&many=57` for that many to page through, `&archived=2&archiveOpen=1` with two of them archived, `&capped=1` for the note past 500, `?fixture=agents` for three agents side by side, `&hideAgents=codex` with an agent hidden from the legend, `&markers=always` or `never` as the setting).

## Adding an agent

An agent is an `AgentProvider` (`src/core/agents/agent.ts`): it reports the agent's live sessions with a status, a title and a current directory. Location, ordering, finished marks, the jump list and notifications work on those reports and need no change. `src/core/agents/claude` is the reference provider; the controller (`src/vscode/controller.ts`) lists the providers it polls. An agent that hosts sessions in its own editor panel also gets a `PanelAdapter` (`src/vscode/agents`) to bring a session's tab to the front.

Every agent also has a row in the catalog, `src/core/agents/catalog.ts`: its id, its name, its colour (a CSS variable, defined in `media/board.css` for dark and light themes and in `media/search.css` and `media/findings.css`), its boat (an SVG path in a 16-unit box, also in `icons/` for the icon font: `npm run icons`) and its capabilities. Nothing else names, colours or draws an agent, and the UI offers only what the capabilities allow. A test holds the colours, the icon files, the settings, and the README's Supported agents table and badge to the catalog. `?fixture=agents` in the board's preview shows three agents side by side.

## Releasing

Set the version in `package.json`, add its section to `CHANGELOG.md`, and push a tag `v<version>`. The release workflow publishes a GitHub Release with the `.vsix` attached.

The same workflow then publishes the `.vsix` to the Visual Studio Marketplace and to Open VSX when the repository holds the secrets `VSCE_PAT` (a Marketplace-scoped Azure DevOps token for publisher `nimrod-teich`) and `OVSX_PAT` (an Open VSX access token for the same namespace); a missing secret skips that registry, and the `.vsix` on the Release can be uploaded by hand instead.
