# Unreleased

- Improved assistant model configuration for system and third-party sources. Generation guidance uses saved model lists and removes Provider management from the composer.

- Improved Assistant recovery with silent host and internal continuations, without flashing interruption errors. Connection retries and final failure details remain visible; generator guidance now documents retry kinds and presentation.

- Fixed Assistant recovery after host disconnects: durable work resumes on reconnect, unexpected model interruptions retry automatically, and exhausted retries show their cause on the affected answer.

- Added guidance and tools for configuration publication and child permissions, lock reasons, author drafts and recipient previews without automatically publishing personal credentials.

- Fixed: project configuration file fields choose and upload files to Server storage, then save references. Type restrictions, replacement and clearing preserve the previous value when uploads fail.

- [Added] Let the assistant manage all project configurations and custom fields through Studio Control, including headless operations and complete import/export. Generate `configuration.json` for every project type and remove business env scaffolds and the legacy host configuration tool.

- Generator guidance now covers Agent native web search capability declarations, per-run controls, protocol limits, activity and source outputs, and persistent follow-up context.

### Context compaction

- Update Agent guidance for automatic compaction at 90% before every model request, including tool loops, overflow recovery, bounded summaries and their limits.

### Skill tools

- Rename `skill` to “List and read skill guides”, explain `list`, `read`, the default `SKILL.md` and reference paths, and distinguish the section's tool count from its guide count.

### Pi Durable

- [Fixed] Align retry guidance with budgets resetting after a successful model response. Later failures restart at Retry 1 / 10 while records with repeated attempt numbers remain separate.

- [Fixed] Update per-turn model usage and per-conversation context contracts, isolate fork consumption, and include system instructions and tool declarations in estimates. Verify the actual assistant's answer usage and standard composer rings remain consistent after recovery.

- [Improved] Align generation guidance with next-turn queuing, atomic send-now promotion and fork confirmation, preserving the standard composer and original input identity.
- [Improved] Align tool diagnostics with retained submitted arguments and separate output for call IDs reused across turns, binding approvals to each durable task. Synchronize the Studio bundle with the complete durable session integration.
- [Fixed] Generation guidance specifies command snapshots before queuing, strict JSON task input, persisted predeclared catalog checks, and exclusive source/destination ownership for SQLite backups.
- Added authorized tool discovery with Studio Control connecting on the first search. Hosts can opt into QuickJS Code Mode through an environment variable; it remains off by default. Update generation guidance for durable extensions, tasks, remote execution and storage, with cross-process recovery checks for nested script tools and background timers.
- Enabled durable sessions and task plans in Developer Assistant, with restricted background subagents (up to 4, read/grep/find/ls only, no recursive delegation), single-result reporting, and fork plan inheritance. Studio / CLI Web displays tasks, plans, records, and parent/child usage.
- Updated generation guidance for session leases, controls/snapshots, child-tool permissions, configuration switching, and background compaction. Offline tests exercise the real workflow through background tool crash recovery and result deduplication.
- Update Agent recovery guidance for retained memory approvals, initial context that preserves durable history, and continuation from committed stream fragments. Verify the actual assistant's SIGKILL recovery and output and usage replay.
- Enable Pi Durable recovery for Project Assistant, preserving committed tool results, questions and plan approvals across processes without duplicating answers, writes or usage. Update tool contracts and generator guidance for Pi 1.2.0, SQLite, stable request identities and durable cancellation.

### Changes

- Generation declares static project types and publishes source with related project locks without Server execution targets.
- Remove server environment, execution form and related execution guidance; related entrypoints execute locally with explicit server data access. Upload and publish through the existing CLI commands.

### New Features

- **Studio VS Code host**: the default host becomes Studio VS Code with an independent working directory and Studio Control's standard MCP.
- **Asking mid-plan**: in plan mode the assistant uses Core's `ask_user` tool to ask one or more questions in a single turn.

### Breaking Changes

- Conversation hides the composer by default while awaiting an answer or plan approval, and turns off `/plan` and its footer notice once the plan is accepted.
  Migration: projects that keep the composer declare it explicitly in the generic `userInput` configuration.
- Conversation removes its enable setting and custom main fields, moves attachments to `conversation.attachments`, and rejects retired configurations during validation.
  Migration: declare attachments through `conversation.attachments` and keep only Auxiliary, Quick, Mode, and Slash parameters.

### Added

- Added a generic Conversation `userInput` configuration covering composer behavior for question and plan-approval requests.
- Added `/export` exporting every current session record and showing the result in the body.
- Added `/compact` immediately summarizing actual context with running, completed, or failed states.
- Added `get_related_projects` querying relation declarations, UUIDs, names, Studio import status, and verified directories.
- Added reading VS Code workspace state and diagnostics, file navigation, themes, terminals, and views through Studio Control's standard MCP.
- Added Studio Control credentials staying out of coding shells while tool permissions and Build/Plan approvals stay intact.
- Added Kanban discovery and invocation of registered page queries, navigation, and viewpoint methods after resolving the configuration and preview instance.
- Added generator coverage of the Kanban file Bridge and CLI image migration commands, verifying bytes by reading back after upload.
- Added generator card guidance for the browser preview switch and Desktop's upper-right preview area.
- Added Core API reference coverage for Conversation resource card tools and Kanban preview and save parameters.
- Added a task-oriented generator index of APIs and public types so the assistant locates a contract before reading the detail.
- Added plan-mode questions through `ask_user` with options, multi-select, or free-form answers, all kept in the conversation.
- Added declaring the context window in an Auxiliary panel.

### Changed

- Changed modes to a single `/plan` toggle that defaults to Build and shows a footer notice while Plan is enabled.
- Changed generator guidance to cover generic Slash parameters, execution commands, and conditional footer text below the input.
- Changed generator guidance to cover live Agent context queries, measurement updates, and the ring shown at run start.
- Changed current context occupancy to stay separate from incrementally reported billed usage.
- Changed generator guidance to reuse Core's standard ring output pinned to the right of the composer, without host-specific context logic.
- Changed AI and permission triggers to icons plus the current selection, dropping the right trigger's text first at narrow widths.
- Changed the default Auto approve policy to allow directories outside the workspace.
- Changed the prompt and Studio Control to follow each turn's policy, with Workspace and Read only keeping their path boundaries.
- Changed the default host to Studio VS Code with an independent working directory, keeping Core coding tools, skills, memory, and resource cards.
- Changed generator guidance to cover method registration, disposal, cancellation, and state queries after timeouts.
- Changed Kanban previews to run independently by configuration ID without touching the host's active configuration, and to document pinned height and borders.
- Changed the Kanban skill to separate small-card presentation from device dimensions through the presentation API, keeping read-only cards on content while preserving edit state.
- Changed the Kanban generator skill to cover full-screen, phone, tablet, and Conversation previews, reflowing content by iframe size while preserving drafts and uploads.
- Changed the generator card reference to spell out the `current` target, pin precedence, removal arguments, and preview parameter validation.
- Changed Kanban project resource cards to default to previewable types and to separate the preview switch from Kanban parameter mode.
- Changed `dependency-config` to verify `release.dependencies` delivery values and alias matches first.
- Changed related-project publishing to use the CLI project-group flow to pin versions and source hashes.
- Changed upload targeting to check the effective server through `workspace status` before uploading.
- Changed generator guidance to stop treating "do not install dependencies" as absolute when the project root is writable, the package manager runs, and the task needs it.
- Changed installs to run only `<manager> install`, without editing dependency versions or inventing build scripts, reporting any lockfile change.
- Changed unsupported environments to keep the real error instead of switching registries, hand-placing packages, or editing source.
- Changed the two Desktop tools for login items and updates to stop raising confirmation cards in build mode while plan mode still confirms each call.
- Changed Core tool approval to stop only plan-mode turns by setting `requiresUserApproval` from the mode of the turn.
- Changed build mode to still require the matching tool permission for those two tools, refusing disabled tools as before.
- Changed the capability-index generator to fail instead of listing less when it cannot read a spread member, an empty related-project interface, or a missing context interface.
- Changed assistant parameters to explicit action declarations: separate Quick menus for system AI and permissions, and an independent Build/Plan Mode switch.
- Changed the generator skill's `references/param-panels.md` to document action order, group fields, group-local reset, and argument propagation.

### Fixed

- Fixed generator guidance conflating manual summarization of all context with automatic compaction that keeps recent turns.
- Fixed incomplete summaries replacing the original transcript on provider failure, truncation, or cancellation.
- Fixed images being split into KV chunks and file APIs being reported as absent.
- Fixed the boundary between Agent convenience executors and static project declarations, so params and tools reach structure reports.
- Fixed falling back to `node -e` JSON parsing and announcing that dependencies must not be installed.
- Fixed `--fix` overwriting a reference page with no generated-block markers and taking the surrounding text with it.

### Removed

- Removed Project Assistant's Context parameter menu; the context window now comes from the model itself.
- Removed Desktop Control integration, its built-in dependency, and unadapted Kanban host control tools.
- Removed Conversation's enable setting and custom main field declarations.
