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

Set the version in `package.json` (and `package-lock.json`), give it a section in `CHANGELOG.md`, and push a tag `v<version>`. The Release workflow (`release.yml`) checks the tag against `package.json`, runs the checks and tests, publishes a GitHub Release with the `.vsix` attached and that version's changelog section as its notes, then publishes the `.vsix` to both registries, each in a job of its own and with no stored token. A registry that already has the version is skipped.

**To finish a release a registry refused**, run the workflow by hand with the tag: Actions → Release → Run workflow, or `gh workflow run release.yml -f tag=v0.1.1`. A run by hand skips building and goes straight to the registries.

### Open VSX: trusted publishing

Open VSX trusts this repository's `release.yml` (Settings → Trusted Publishers on open-vsx.org, no environment pinned), so publishing to it must stay in that file: renaming it, or moving the Open VSX job to another workflow, breaks the trust. The job asks GitHub for an OIDC token (`id-token: write`) and `ovsx publish --trusted-publishing` exchanges it for a short-lived one. No `OVSX_PAT` is used; delete that secret once a release has published.

### Visual Studio Marketplace: a managed identity in Azure

Azure DevOps retires global personal access tokens on December 1, 2026, so the Marketplace job signs in to Azure as a user-assigned managed identity through the run's OIDC token and publishes with `vsce publish --azure-credential`. A user-assigned managed identity, not an app registration: an app registration signs in but is refused at publish. One-time setup:

1. **An Azure subscription.** The identity is an Azure resource; a free subscription is enough.
2. **The identity.** In the Azure portal, Managed Identities → Create, in any resource group and region.
3. **Its federated credential.** On the identity: Federated credentials → Add credential → *GitHub Actions deploying Azure resources*; Organization `nimrod-teich`, Repository `lookout`, Entity **Environment**, name `marketplace`. The job runs in that GitHub environment, so the credential trusts it from a tag push and from a run by hand alike. Leave the environment without deployment branch rules for the same reason.
4. **Its IDs, as repository variables** (they name the identity; they grant nothing on their own): from the identity's Overview, `gh variable set AZURE_CLIENT_ID -R nimrod-teich/lookout --body <Client ID>` and `gh variable set AZURE_TENANT_ID -R nimrod-teich/lookout --body <Tenant ID>`. Without them the job skips the Marketplace with a warning.
5. **Its place on the publisher.** The publisher's Members page knows the identity only by its Azure DevOps profile ID, which exists once the identity has called Azure DevOps. Run the workflow by hand with a tag: the job signs in, finds that the identity may not publish yet, and fails with that ID and the link to the publisher's page. At `https://marketplace.visualstudio.com/manage/publishers/nimrod-teich` → Members, add that ID as **Contributor**, then run it again.

Once a release has reached the Marketplace this way, delete the `VSCE_PAT` secret.
