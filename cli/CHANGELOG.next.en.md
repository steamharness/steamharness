# Unreleased

- Fixed Studio local analysis to ignore stale imports whose folders were deleted, preventing Start status refresh failures. Missing projects in the current workspace and other read failures remain unavailable.

- Fixed composer Stop to include the current conversation's background batches and subagents, keeping Stop available during background work. Disconnected owners pause their remaining tree and user queue until explicit input reconciles it, preventing configuration updates from holding messages indefinitely.

- Fixed Kanban and image cards losing their aggregate entry path and showing `Unknown project entry.`. Card instances and reads now appear in read-only runtime diagnostics, and file reads retain their full timeout through the preview transport.

- Fixed repeated Kanban configuration acknowledgements flooding the host and disrupting map loading; page method updates are coalesced. Connection recovery uses a delayed compact overlay, preserving the map layout and avoiding flicker during brief interruptions.

- Fixed sending new input after Stop and handling legacy queues and edited submission identities. Queue-enabled conversations accept consecutive sends; Send now and withdrawal respond immediately and restore failed actions, while Stop and failure keep older messages paused.

- Fixed memory job feedback to distinguish paused authorization from extraction failures, explain recovery, and disable unavailable or repeated retries without reporting edit conflicts.

- Fixed: Workflow, Conversation and Kanban pages in Studio handle project shortcuts first and forward unhandled keys to Studio, preserving text editing, clipboard shortcuts and IME input.

- Added: Project configuration reuses the AI model list for a single subagent selection with Follow main model. Removed selections stay unavailable, and Studio can configure child models while using Settings for the main model.

- Added read-only Kanban runtime diagnostics with the latest 50 bridge requests, file routing, HTTP status, pending reads and safe failure categories, plus queries of explicitly read-only page methods.

- Fixed the subagent summary to use a neutral color. Red is limited to failed tasks and error details, so historical failures do not make the entire entry look like an error alert.

- Fix: Route conversation execution diagnostics to Studio Trace by origin. Keep parameter, attachment and resource-opening errors above the composer with a dismiss button; hiding an alert preserves validation.

- Fixed resource cards to preserve explicit project and entry targets and inspect previews using the target entry, preventing false project-unavailable errors when opening maps from the Assistant or another entry in the same project.

- Added a subagent status entry beside “Responding…” with running, queued and completed counts. Expand roles, phases, progress, results and errors, and open child conversations. The entry remains after the parent response, preserves expansion across streaming and subsequent replies, and identifies offline snapshots.

- Added: Interrupt unfinished managed execution trees on reopening and require explicit batch recovery. Keep pending user input separate from business queues; only successful user turns advance it, never background reports.

- Added: A Project memory switch defaults off for ordinary projects and on for the Assistant. Memory navigation updates quietly when configuration changes, and disabled projects cannot call memory operations.

- [Changed] Studio model parameters use only Settings models and hide project AI. Standalone CLI Web falls back to project configuration consistently for setup, defaults and requests. Removed project references to Settings models.

- [Fixed] Bound worker shutdown and release conversation ownership after forced exit. Queues advance automatically only after success; failures, cancellation and timeouts retain pending messages, and new explicit input can run before the paused queue.

- Fixed memory panel layout with a continuous list, on-demand details and compact switches. Configuration, outage and authorization states are distinct, with a working return to the list on narrow layouts.


- Added: Open local file links, inline code paths and plain absolute paths from Agent replies and plans in the Studio editor, including relative paths, file URIs and line/column locations. Fixed managed attachment link handling.

- Fixed embedded project configuration styles affecting nested dialogs, restoring content and footer spacing when adding or editing models in Project information.

- Added: Show global/current memory in project information according to Core capabilities, with compact details, editing and forgetting; keep account credentials in the host and scope worker grants.

- [Fix] Keep the skill preview return toolbar outside its independent document scroll area, preventing content from overlapping navigation while preserving loading, retry and return states.

- Fixed the Skills page to list and count actual project and Core built-in guides, with search and complete SKILL.md previews and Markdown source. The discovery tool is no longer shown as a skill, and navigation keeps the panel size fixed.

- Fix: CLI Web Project information synchronizes tool registrations and permissions while preserving search and focus. Configuration failures no longer remain stuck loading, and closing the panel dismisses its editors. Refined cards, selection states and light/dark styling, with horizontal tabs on narrow screens and stable panel dimensions.

- Improvement: Conversation, message and workflow exports in Studio use the native save dialog and show the saved path in a notification after writing succeeds. Cancellation stays quiet and write failures show an error.

- Improvement: CLI Web consolidates AI usage, project configurations, tools, skills and databases under Project information. The redesigned panel uses fixed dimensions, sidebar navigation and independently scrolling sections while preserving configuration drafts, tool searches and model setup shortcuts. Skills remain read-only without permission switches.

- Fix: Studio local analysis ignores stale imports whose standalone manifests were removed or converted to aggregate child entries. Local history uses project declarations without deployment database configuration; actual read failures remain unavailable.

- Improvement: CLI Web separates tools and skills into tabs. Tools retain permission controls; skills appear as read-only guide cards without Enable or Auto-approve switches, shared by Conversation and Workflow.

- Fix: CLI Web passes validated `STEAMHARNESS_PROJECT_CONFIG` database mappings to project workers so inspection and Workflow execution use the same IDs for root and child configurations.

- Breaking: project identity, name, version and declarations now use independent `steamharness.json` files. Removed reads and writes of `package.json.id` and `steamHarness`. Aggregates explicitly register child entries whose configuration defines icons, declarations, database aliases and schedules. Unregistered configurations stay inactive, and transfers preserve the parent and child structure.

- Improvement: CLI Web databases show references and icon actions with host navigation; requests, reviews and grants live in Studio, Server Web or CLI commands. Standalone Web sessions explain the preview limitation.

- Local Conversations consume inherited Core Agent parameters consistently across structure reports, dynamic model options and execution input, including hidden and fixed fields.

- Improvement: Web run failures summarize upstream HTML error pages with an HTTP status and actionable guidance. Original diagnostics are collapsed under Technical details in Conversation and Workflow.

- Improvement: Moved database management into Project information and removed its toolbar button. Database cards show shared entries and connection status; reference settings stay in Project information, while host interfaces maintain requests and permissions.

- Improvement: Use a clear plus icon for the New conversation toolbar button to make the create action easier to recognize.

- Improvement: Aggregates open their default entry and use an icon-only Project windows button. Compact entry cards show types, default/current markers and runtime states, with an icon to open a new browser page or Studio tab. Removed split views; every entry, including the current one, can open repeatedly with independent view state on the shared host. Entry icons and colors are independent; only the root owns a version.

- Changed: database management saves aliases and approved database IDs, while hosts manage requests and permissions. Entries support multiple references, approved requests display IDs, and archives preserve references.

- Fixed database binding guidance to open the linked databases in Project information. Requests and permissions are managed by the host; the assistant and Conversation share the linking interface, and startup checks use readable status labels. Review IDs no longer overwrite response IDs and leave management requests waiting indefinitely.

- User model menus group built-in and custom models with direct choices and an Add model action at the bottom of standalone model controls. Model and effort can be selected independently while preserving custom project grouping, reset and source restrictions.

- Fixed empty user model controls to show Configure model with setup guidance and open model settings directly. Adding a model restores the selection list.

- Fixed grouped model menus to keep user model management available during loading and active work, preserved `inherit` as a model ID, and kept unrelated project output named `userSettings` intact during credential redaction. Kanban refreshes recheck current related imports so valid setup guidance survives a preview refresh and resolved errors stay hidden.

- Added host user models, available-model choices and a Manage models action while retaining project configuration APIs. Updates apply at idle boundaries; keys stay out of page state, ordinary history and exports and are rehydrated only for matching model endpoints.
- Fixed concurrent entry database bindings overwriting each other and database requests accepting another consumer's binding metadata. Corrected Kanban database API examples.

- Breaking: check, run, Web and MCP select registered entries. Web windows retain independent drafts and background tasks. Database access requires host requests, approval and binding. Removed related projects, dependency locks and combined publishing commands.

- Parameter `userSetting` bindings support fixed user policies or user defaults with project overrides. Fixed controls show the actual policy and open user settings; editable controls retain the three original choices. Reset restores inheritance without persisting the displayed value as an override; active work keeps its snapshot.

- Added initial host user permission snapshots and capability-negotiated updates to CLI Web. Durable sessions keep startup settings for active and background work, adopting updates at a safe idle boundary while preserving inheritance parameters, history, pending input, and request identities across remounts and recovery. Standalone CLI does not persist this setting yet.

- Keep project deployment configuration in root config.json, centralizing database aliases and IDs; package entries declare only the aliases they use. STEAMHARNESS_PROJECT_CONFIG can override deployment values; migration updates one ID, permissions remain host-managed, and distributions retain authored values.
