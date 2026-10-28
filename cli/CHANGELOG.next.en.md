# Unreleased

- Improvement: Web run failures summarize upstream HTML error pages with an HTTP status and actionable guidance. Original diagnostics are collapsed under Technical details in Conversation and Workflow.

- Improvement: Moved database management into Project information and removed its toolbar button. Database cards show shared entries and connection status; requests and host grants have a separate view with readable permission controls. Key-value and knowledge data use searchable, paginated lists and detail editors.

- Improvement: Use a clear plus icon for the New conversation toolbar button to make the create action easier to recognize.

- Improvement: Aggregates open their default entry and use an icon-only Project windows button. Compact entry cards show types, default/current markers and runtime states, with an icon to open a new browser page or Studio tab. Removed split views; every entry, including the current one, can open repeatedly with independent view state on the shared host. Entry icons and colors are independent; only the root owns a version.

- Changed: database management saves aliases and approved database IDs, while hosts manage requests and permissions. Entries support multiple references, approved requests display IDs, and archives preserve references.

- Fixed database binding guidance to open database management directly for requests, approval and recovery. The assistant and Conversation share the management interface, and startup checks use readable status labels. Review IDs no longer overwrite response IDs and leave management requests waiting indefinitely.

- User model menus group built-in and custom models with direct choices and an Add model action at the bottom of standalone model controls. Model and effort can be selected independently while preserving custom project grouping, reset and source restrictions.

- Fixed empty user model controls to show Configure model with setup guidance and open model settings directly. Adding a model restores the selection list.

- Fixed grouped model menus to keep user model management available during loading and active work, preserved `inherit` as a model ID, and kept unrelated project output named `userSettings` intact during credential redaction. Kanban refreshes recheck current related imports so valid setup guidance survives a preview refresh and resolved errors stay hidden.

- Added host user models, available-model choices and a Manage models action while retaining project configuration APIs. Updates apply at idle boundaries; keys stay out of page state, ordinary history and exports and are rehydrated only for matching model endpoints.
- Fixed concurrent entry database bindings overwriting each other and database requests accepting another consumer's binding metadata. Corrected Kanban database API examples.

- Breaking: check, run, Web and MCP select registered entries. Web windows retain independent drafts and background tasks. Database access requires host requests, approval and binding. Removed related projects, dependency locks and combined publishing commands.

- Parameter `userSetting` bindings support fixed user policies or user defaults with project overrides. Fixed controls show the actual policy and open user settings; editable controls retain the three original choices. Reset restores inheritance without persisting the displayed value as an override; active work keeps its snapshot.

- Added initial host user permission snapshots and capability-negotiated updates to CLI Web. Durable sessions keep startup settings for active and background work, adopting updates at a safe idle boundary while preserving inheritance parameters, history, pending input, and request identities across remounts and recovery. Standalone CLI does not persist this setting yet.

- Keep project deployment configuration in root config.json, centralizing database aliases and IDs; package entries declare only the aliases they use. STEAMHARNESS_PROJECT_CONFIG can override deployment values; migration updates one ID, permissions remain host-managed, and distributions retain authored values.
