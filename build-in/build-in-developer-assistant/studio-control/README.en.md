# Studio Control

Studio Control is the `studio-control` Workflow entry inside the Assistant aggregate. Both entries share the Assistant projectId, dependencies, installation and version; `main` remains the default Conversation entry. The assistant discovers and calls its control operations on demand through `steamharness mcp <assistant-project-dir> --entry studio-control`.

Open the Assistant project root in Studio to run the `studio-control` entry and select an internal operation without starting a model conversation. Studio recognizes the Assistant projectId and entry ID and provides a control connection for the run. Direct runs default to the aggregate root and registered workspace scope; closing the last run tab revokes the connection. This directory is not an independent project or installation.

| Entrypoint | Capability |
| --- | --- |
| `get_configurations` | Query or fully export fields, profiles, values, selection and revision for an explicit local or Server project |
| `manage_configurations` | Manage profiles and custom fields, set or clear values, or atomically import; revision checks apply and read-only mode rejects writes |
| `open_configurations` | Open the selected project's configuration panel |
| `studio_state` | Read the run's permission policy, path access, workspace, active editor, installed themes and supported views |
| `get_entries` | Read registered entries, types, code roots and database requirements |
| `open_file` | Open a permitted file at an optional one-based line and column |
| `get_diagnostics` | Read VS Code errors and warnings within the permission scope or for one file |
| `set_theme` | Select an installed theme by the name returned by the state tool |
| `open_terminal` | Open a terminal in a permitted directory without sending or executing commands |
| `show_view` | Show Explorer, Search, Source Control, Terminal or Assistant |

Configuration operations work with the panel closed. Pass a JSON `input` with `storage: "local"` plus `projectDir` and `entryId`, or `storage: "server"` plus `projectId`, `entryId` and `target`. Query first, then pass the returned `revision` and explicit profile `id` for value/profile changes. Import generates new IDs and preserves selection. Exports include all sensitive values. See [Project configurations](../../../docs/en/concepts/project-configuration.mdx).

The optional `projectDir` parameter of `get_entries` selects an aggregate project allowed by the current permission policy, defaulting to the running project or assistant working directory. It returns `projectId`, `projectDir`, `defaultEntry` and `entries`. Each entry includes its ID, type, name, code root, entry file, configuration definition and database requirements. Entries belong to one aggregate project. Database spaces require a separate request, approval and binding on their declared local or server host. The current Permission policy still controls file access.

Diagnostics match files by their canonical paths while retaining entries registered through the original path or a symlink. File opening rechecks workspace, trust and session availability after loading the document, preventing editor display after revocation.

`set_theme` explicitly selects a theme in manual mode, turning off automatic system color-scheme and high-contrast detection. It updates an existing workspace override or otherwise the user's settings. Successful results include `theme` and `mode: "manual"`. Automatic system detection can be restored in VS Code settings.

Studio creates an authenticated loopback endpoint for each assistant session and injects `STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL` and `STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN`. The assistant forwards the run's Permission through the MCP child environment `STEAMHARNESS_STUDIO_CONTROL_PERMISSION_POLICY`, outside model tool arguments. `auto` permits any local directory accessible to the process. `workspace` and `read-only` keep the registered workspace boundaries, checking symlinks against their real paths. `studio_state` returns `permissionPolicy` and `pathAccess` (`all` or `workspace`). Removing a root, revoking workspace trust or closing the session invalidates control. Editor actions follow tool permissions and Build/Plan approval rules; state, diagnostic and entry-registry reads are automatically approved.

Legacy Desktop Dock, launch-at-login, updates, cloud-app publication and Desktop database controls are not offered. Calling from a regular CLI or an MCP server without a host connection fails explicitly. A Studio Node extension host is required; the browser-only extension has no local control service.

Run `pnpm typecheck`, `pnpm test`, `pnpm coverage` and `pnpm build` from the parent Assistant project. Tests use isolated host mocks and real stdio MCP to verify the embedded entry, authentication, cancellation and all three permission policies. Studio daily checks run in the background.
