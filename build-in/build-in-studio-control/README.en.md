# Studio Control

Studio Control is a built-in Workflow project connected to Studio's VS Code extension host. The assistant calls its standard MCP tools.

You can also open this project folder in Studio and use Run Project to select an entrypoint, fill in its parameters and run it as an ordinary Workflow project, without an assistant or model configuration. Studio recognizes the project UUID and injects a control connection for its run page, using the opened project's files and CLI. Projects nested inside a workspace are supported. Ordinary runs default to the project directory and restrict file access to the registered workspace folders. Closing the run page revokes the connection. Install project dependencies first; inside the aggregate, use `pnpm install --ignore-workspace`.

| Entrypoint | Capability |
| --- | --- |
| `studio_state` | Read the run's permission policy, path access, workspace, active editor, installed themes and supported views |
| `get_related_projects` | Read declared related projects, UUIDs, names, Studio import status and verified directories |
| `open_file` | Open a permitted file at an optional one-based line and column |
| `get_diagnostics` | Read VS Code errors and warnings within the permission scope or for one file |
| `set_theme` | Select an installed theme by the name returned by the state tool |
| `open_terminal` | Open a terminal in a permitted directory without sending or executing commands |
| `show_view` | Show Explorer, Search, Source Control, Terminal or Assistant |

The optional `projectDir` parameter of `get_related_projects` selects a Workflow project allowed by the current permission policy, defaulting to the running project directory or the assistant's working directory. The result includes the source `projectId`, `projectDir` and a `relatedProjects` list. Each entry has `alias`, `projectId`, `imported`, `name`, `uri` and `projectDir`. Queries revalidate imported UUIDs. Missing or unavailable imports retain their declaration, with null names and directories. Remote imports return their URI with a null local directory. Import status does not imply mutual data-access grants; the run's Permission controls file access.

Diagnostics match files by their canonical paths while retaining entries registered through the original path or a symlink. File opening rechecks workspace, trust and session availability after loading the document, preventing editor display after revocation.

`set_theme` explicitly selects a theme in manual mode, turning off automatic system color-scheme and high-contrast detection. It updates an existing workspace override or otherwise the user's settings. Successful results include `theme` and `mode: "manual"`. Automatic system detection can be restored in VS Code settings.

Studio creates an authenticated loopback endpoint for each assistant session and injects `WORKFLOW_STUDIO_CONTROL_BRIDGE_URL` and `WORKFLOW_STUDIO_CONTROL_BRIDGE_TOKEN`. The assistant forwards the run's Permission through the MCP child environment `WORKFLOW_STUDIO_CONTROL_PERMISSION_POLICY`, outside model tool arguments. `auto` permits any local directory accessible to the process. `workspace` and `read-only` keep the registered workspace boundaries, checking symlinks against their real paths. `studio_state` returns `permissionPolicy` and `pathAccess` (`all` or `workspace`). Removing a root, revoking workspace trust or closing the session invalidates control. Editor actions follow tool permissions and Build/Plan approval rules; state, diagnostic and related-project reads are automatically approved.

Legacy Desktop Dock, launch-at-login, updates, cloud-app publication and Desktop database controls are not offered. Calling from a regular CLI or an MCP server without a host connection fails explicitly. A Studio Node extension host is required; the browser-only extension has no local control service.

Development dependencies use `link:../../core` and `link:../../cli` inside the aggregate. After installation, run `pnpm typecheck`, `pnpm test`, `pnpm coverage` and `pnpm build`. Existing built-in packaging tooling is retained for future releases; this migration delivers source and host integration only.

Run `npm run test:studio-control-live` from the aggregate's `studio` directory to call all seven packaged tools through real stdio MCP and an isolated VS Code Node extension host, including permission changes and session revocation. It also verifies all seven imported source entrypoints through ordinary project launch and run APIs, including the default project directory and connection isolation. It uses a headless browser and a temporary workspace, leaving visible desktop windows and the system clipboard untouched. It closes its server and terminals and restores the test instance's theme. Results are saved to `studio/.studio/studio-control-live/results.json`. A built Studio, installed assistant dependencies and Chrome are required; `STUDIO_CONTROL_TEST_BROWSER` can select another Playwright browser channel.
