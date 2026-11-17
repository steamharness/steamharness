# Changelog

All notable public changes of this release unit are recorded here.

## Legacy 0.1.1 - 2026-07-29

### Changed

- Changed the CLI to an independent version and tag, declaring its compatible Core range through a peer dependency.

## Legacy 0.1.2 - 2026-07-30

### Breaking Changes

- Project packaging reads only the root `.steamharnessignore`; other ignore files no longer apply.
  Migration: explicitly exclude credentials, dependency directories, and temporary files in `.steamharnessignore`.

### Added

- Added static Kanban project support to `workspace pack`, `upload`, `publish`, and `download`, preserving binary assets.

## Legacy 0.1.3 - 2026-08-07

### New Features

- **Global `--locale` switch**: changes local and Workspace output and propagates to Server and the Workflow runtime.
- **`--entrypoint` argument**: local and remote commands can pick an entrypoint and fall back to the default. See [CLI](../docs/cli/steamharness.mdx).

### Breaking Changes

- Project-group packaging and downloads exclude PersistentValue data and CLI credentials and verify every package with SHA-256.
  Migration: self-references, lock mismatches, and modified responses are rejected, so regenerate dependency locks.

### Added

- Added a global `--locale <zh-CN|en>` switch, with projects reading it through `workflow.getRuntimeLocale()`.
- Added `--entrypoint <id>` to local `run`, `json`, `resolve-params` and remote `run`, `debug-node`.
- Added `structure` validating and reporting schedule suggestions by entrypoint, time zone, window, or Cron.
- Added Workspace commands delivering and restoring Kanban project groups by exact dependency lock, without host data.

### Changed

- Changed release notes to be maintained in Chinese and English, with Docs showing the matching version per language.

## Legacy 0.1.4 - 2026-08-24

### New Features

- **Platform-aware downloads**: `workspace download` sends the current platform and resolves `latest` to that system's newest compatible version.
- **Per-version release targets**: `workspace upload/publish` select a Server runtime and Desktop download target per immutable version.

### Breaking Changes

- The Desktop local runtime event variable is now `STEAMHARNESS_DESKTOP_RUNTIME_EVENTS`.
  Migration: the former `STEAMHARNESS_APP_RUNTIME_EVENTS` variable is no longer accepted.

## Legacy 0.1.5 - 2026-08-26

### Fixed

- Fixed dated Alpha Core versions accepting newer patches in the same minor line when they satisfy the project's caret range.

## Legacy 0.2.0 - 2026-08-26

### Breaking Changes

- The CLI is now 0.2.0 and pins Core 0.2 exactly, validating both exact declarations before execution.
  Migration: only the same `major.minor` line is accepted, and every patch on that line runs directly.
- Local execution passes explicit storage contexts from the project's `dataStorage.mode`.
  Migration: missing declarations and forbidden cross-location access now fail immediately.

## Legacy 0.2.3 - 2026-09-01

### New Features

- **Local MCP endpoint**: `steamharness mcp <workflow-dir>` exposes every entrypoint as a standard stdio MCP tool.
- **Related project access**: `--related-project` explicitly enables mutually confirmed related-project KV access.
- **MCP lifecycle reporting**: hosted by the headless Desktop launcher, the CLI reports complete snapshots over dedicated IPC. See [CLI](../docs/cli/steamharness.mdx).

### Breaking Changes

- The `--grant-data-access` and Kanban `dataSources` grant flows are removed.
  Migration: project-group dependencies now come from mutually confirmed `steamHarness.projectInfo.relatedProjects`.
- `workspace upload --create` requires a predeclared top-level UUID and `dataStorage.mode`.
  Migration: Server no longer assigns or writes back project IDs.

### Added

- Added `steamharness mcp <workflow-dir>`, exposing every entrypoint as a standard stdio MCP tool.
- Added a repeatable `--related-project <alias>=<absolute-project-dir>` option for local runs.

### Changed

- Changed local `kv.*` and `persistentValue.*` to bind directly to the current project instead of a global scope.
- Changed headless Desktop-hosted MCP runs to report full lifecycle snapshots for one runId over dedicated IPC.
- Changed stdio stdout to carry only JSON-RPC, keeping input, args, report, stdout, and stderr in the snapshot.

### Fixed

- Fixed MCP form elicitation terminating the waiting run and recording a diagnostic on invalid or failed responses.
- Fixed the OpenAI Responses internal runner no longer writing AI SDK compatibility warnings to `stderr`.
- Fixed `steamharness structure` validating the complete `projectInfo` contract before analysis, exiting `1` on unsupported fields.

## Legacy 0.2.4 - 2026-09-05

### New Features

- **Related project knowledge and entrypoints**: `--related-project` now reads a target's knowledge base and calls its granted entrypoints.
- **Symlinked invocation fixed**: `steamharness structure .` no longer prints nothing and exits 0 as a false pass under pnpm-style installs.
- **Status shows the real server**: `workspace status` gains an `effective` field naming the server a command will actually use.

### Breaking Changes

- The CLI no longer has `--web-runtime` / `--no-web-runtime`; the `web` target went with the relay and Web entry point.
  Migration: browser runs are now the Desktop home Web build, and passing either option reports that it was removed.
- A server-located related project target hands over KV only; knowledge and entrypoint calls fail with a clear error.
  Migration: move the target to a `local` location, or put the needed capability in a locally runnable entrypoint.
- A local related project opens its knowledge base only with a persistent-value directory, shared with the child run.
  Migration: pass `--persistent-value-store-dir` or set `STEAMHARNESS_PERSISTENT_VALUE_STORE_DIR`.

### Added

- Added video output item recognition, keeping readable links in text output and the structured descriptor in JSON output.
- Added `--videos` reading video file references of the default conversation, with MIME inference for common paths.
- Added runtime support for file parameters using the audio control and audio file references.
- Added `effective` to `workspace status`, reporting the server, credential source, and precedence actually used.
- Added related projects reading a target's knowledge base, authorized per key by `grantToRelatedProject`.
- Added related projects calling granted entrypoints, taking the arguments that entrypoint's `createInput` parses.
- Added `structure` preserving optional Workflow entrypoint `group` display metadata.

### Changed

- Changed project-group `workspace upload` to return `202` with a `jobId` and poll deployment status instead of waiting.
- Changed the pinned `steamharness` to the dev channel, with system-AI model attributes coming from the Server catalog.
- Changed model effort levels to converge on what the model declares, with the usage denominator taken from its real window.
- Changed host image references to be resolved through the workflow file store before reaching the model, failing loudly.
- Changed remote runs to use the Runner artifact and image digests captured at enqueue time, unaffected by later uploads.

### Fixed

- Fixed the CLI no longer running as a silent no-op through a symlink, comparing `process.argv[1]` in both forms.
- Fixed a related project's storage root and its child run always landing on the same directory.
- Fixed a failed related-entrypoint call raising that entrypoint's own error instead of reading as an empty result.
- Fixed related-entrypoint calls no longer requiring a locally-stored target, so `server` entrypoints reach the server.

## 0.1.1 - 2026-10-18

### Changed

- Republished under the SteamHarness package names, with an independent version line starting at `steamharness@0.1.0` that is incompatible with the earlier release line.
- Publishing now uses GitHub Releases and npm Trusted Publishing (OIDC), without long-lived tokens.
- Runtime dependencies use the peer range `^0.1.0` to state compatibility during installation.

## 0.1.2 - 2026-10-27

- The minimum Core dependency is now `steamharness@0.1.2`; new projects use matching CLI and Core versions.

- Hosts can pass system AI authentication separately for ordinary projects and Assistant, with consistent validation on startup, account refresh and logout. Existing host connections remain supported, and Studio can start older project CLIs without sending assistant-only fields in their project login.

- Studio's built-in assistant now uses its fixed local application identity without requesting a personal Server project or a new ID. The application checks area hides after success. History, memory and configurations remain local without reading or publishing ordinary project configuration drafts. Server AI retains account authorization, and ordinary projects and related data retain their registration and access checks.

- Rechecks now read current relationship declarations and storage mode and discard diagnostics for removed relationships. Retired services and child frames cannot overwrite application checks. Kanban pauses previews and page methods during checks, including page restoration, and slow complete checks no longer falsely interrupt the connection. Local-storage applications can confirm a new ID, Workflow and Conversation accept their executor's inspected type, and built-in assistants keep their managed identity.

- Kanban, Workflow and Conversation now check application and related-project registration, imports and relationship declarations when opened, before any run or message. A shared checklist shows progress and required actions, hides the entire checks area after success and reappears when attention is needed, preserves local features and never replays operations on recheck.

- Unregistered projects now require confirmation to apply for a Server-assigned application ID and safely replace the local manifest ID. New applications use separate history and data without uploading source or inheriting old access. All three types share this flow; standalone upload only allocates with explicit --create, and groups never change IDs implicitly.

- Fixed generated project templates to match untouched source to the installed SDK API while preserving user edits. Project inspection now includes specific script validation diagnostics instead of only the validation summary.

- Fixed missing local related-project imports to show import guidance, followed by a recheck and deliberate retry. Kanban data and update checks use verified imported folders, including folders outside the project group, and never substitute another copy of the UUID when an explicit binding becomes invalid.

- Improved related-project guidance across Kanban, Workflow and Conversation: verify local imports first, then guide Server access or data grants. Compact related-project notices and expandable connection details distinguish them from missing current projects. Import changes update open pages, rechecks verify folder UUIDs, and no project or grant is changed automatically.

- Simplified Kanban, Workflow and Conversation Server guidance to Apply for a new application ID and Check again. Removed source upload and Account / Server actions, along with instructions to switch Servers.

- Fixed AI source highlighting when adding or editing project configuration models. The selected source uses the theme accent color, and unselected sources keep a neutral background through hovering and switching.

- Fixed Server setup guidance across Kanban, Workflow and Conversation: users can review and apply for a new Server-assigned application ID, replacing the local ID without uploading source. Explicit Server storage failures in `both` mode identify the affected project and related grants; local actions remain available and recovery never replays runs or queued inputs.

- Fixed: Default Server addresses follow the dev, alpha and main channels. Dev uses localhost:7126, empty saved addresses fall back correctly, and explicit connections retain priority.

- Fixed project starts and restores to retain source system-only AI restrictions and official template field locks when using supplied or saved run snapshots.

- Added role-filtered configuration lists with capability, role and active-state labels. Guests edit allowed values only; mode labels follow the selected profile, and drafts survive access changes.

- [Improved] Conversation and Assistant file and folder references use compact icon-and-name tags that wrap horizontally and show the full path on hover. Sent tags appear with the text inside the same user message bubble.

- [Fixed] Conversation and Assistant file cards in Studio now reuse the active Explorer file icon theme, including its icons, fonts and filename mappings. Cards follow icon and color theme changes and render the same icons for dropped and selected files.

- Improvement: Conversation file cards show icons for common document, code, media, and archive formats. In Studio, clicking a file opens its editor or document preview, and clicking a folder opens the system file manager, in both drafts and message history.

- [Fixed] Keep completed replies and their original model names when changing configured models in Conversation and Studio Assistant. The next turn uses the new model; durable reconnection failures no longer overwrite historical replies, and completed output previously hidden by this configuration error is restored.

- [Fixed] Conversation file selection and drag and drop now share file and folder import logic. Studio preserves original paths, browsers retain directory structure, and imports no longer depend on attachment type declarations.

- Improvement: Share application configurations across Studio assistant, Workflow, Conversation and Kanban windows, automatically synchronizing values and active selection while keeping sessions and runs independent and enforcing shared revisions on save.

- [Improved] Group Configure model with the missing-model error in Conversation and Studio Assistant, separate from message action icons. The guidance wraps in narrow panes and opens model settings without losing the draft.

- Added file and folder drops from VS Code, the desktop, and other locations to Conversation, with removable path cards and Core Agent context. Drafts, queues, and retries retain references; browser folder imports preserve nested files and empty folders.

- [Improved] Highlight the configuration in use and offer an explicit Use this configuration button for other profiles. Prevent duplicate switches, preserve the selection on failure, and refresh usage after external switches without replacing drafts.

- [Fixed] Keep user-message index visibility and left spacing consistent at fractional viewport widths caused by scaling or split panes, avoiding incorrect hiding and gaps between breakpoints.

- Fixed local configuration reads retaining source system-only restrictions with older publication templates, including hidden model fields.

- [Improved] Show the user-message index only on wide screens. At page widths of 680px or less, hide the index, count and hover preview without reserving left-side space; restore the index when widened.

- Studio and CLI Web honor system-only AI declarations, hide third-party controls, and share validation across saves, imports and assistant operations.

- [Added] Conversation can collapse intermediate text, reasoning and tools, keeping the final reply, plan and resource cards on success or only the red error on failure. A button after the model name and turn usage shows or hides each turn's process without a separate row; automatic folding follows the project code configuration, and Core Agent defaults to enabled.

- [Fixed] Show each answer's model name instead of its configuration entry ID in Assistant and Conversation, including sending previews and durable follow-ups. Recover older names from saved parameters and preserve them across configuration changes.

- [Added] A subtle user-message index on the left of long conversations. Each marker previews its message and position on hover or keyboard focus; clicking jumps to it and keeps your reading position. The narrow index shows the total count, scrolls for long lists, and previews attachments.

- [Fixed] Open an independent new conversation when creating an Assistant tab in Studio, preserve running conversations and drafts in existing tabs, and restore each tab's own selection.

- Improved model editing in a separate dialog with a segmented source selector. System AI only needs Provider and model selections and generates names automatically. Bordered fields and model lists clarify grouping; a lone Configuration values tab is hidden without publication management.

- [Improved] Show user-message timestamps and copy controls to the left of the bubble on hover or keyboard focus. Remove the footer space, tighten the gap before project replies, and increase bubble contrast while keeping controls accessible on narrow and touch screens.

- [Improved] Show a clickable Configure model action in Studio and CLI Web when no Agent models are configured. Open AI models in the active profile directly, also offer the action on failed messages, and restore model selection after saving while preserving message and configuration drafts.

- Improved the fork confirmation dialog with an explanation of the inherited history, opening the new conversation, and preserving the original conversation.

- Fixed parameter edits and resets being lost across conversations, cleared values lingering, and missed refreshes after approvals or service restarts. Messages can be submitted during initial dynamic loading or after a loading failure for server validation; an empty model catalog rejects stale selections.

- Improved Conversation parameter loading with per-conversation caching, immediate static fields, coalesced edits and background refreshes that preserve options, drafts and Slash menus. Background resolution pauses during runs; configuration and identity changes invalidate caches, every send is revalidated, and obsolete requests or connection failures no longer leave loading stuck.

- Fixed conversation submission applying resolved model values before validation and execution, so the first configured model is used by default and removed selections are resolved correctly.

- Fixed Studio and CLI Web system AI refreshes resetting draft subscriptions and models. Removed subscriptions never select another model, and reopening an empty catalogue retains sign-in guidance and the subscription link.

- Added system and third-party model lists as the first project configuration field, with on-demand subscriptions, add/edit/delete/default actions and draft protection. Composers only select saved models.

- Improved long-conversation and multi-window performance: reuse unchanged history, skip redundant writes, and checkpoint durable Agent web progress once per second while saving inputs and controls immediately. Coalesce Trace updates, skip hidden panel and inactive timeline work, and share attachment lists during transcript refreshes.

- Fixed repeated connection interruptions with large conversation histories: live snapshots carry output and trace summaries while exports retain full events. Pending history writes and slow-client snapshots coalesce, and pages share state serialization. Studio records exit codes, signals, and redacted service diagnostics.

- Added --group-id for creation and first uploads. Uploads and publication require developer access; published downloads require guest access, using current Server memberships.

- Improved Studio and CLI Web recovery: host restarts and internal continuations stay running without flashing “Run interrupted” or finished-answer actions. Only connection retries show Retry; final failures retain their cause.

- Improved: Studio and CLI Web open project configurations as a list with separate detail views, explicit execution selection, and draft protection on back navigation.

- Fixed durable workers cancelling live turns when their IPC owner disconnects. Reconnect resumes checkpoints, model and retry failures show their actual causes, and explicit Stop remains a durable cancellation.

- Improved: configuration publication uses a compact profile toolbar and aligned permission columns, expandable JSON paths, an icon action menu, and a fixed preview/save footer shared by Studio and CLI Web.

- Fix: Preserve Node built-in module prefixes in CLI bundles so Assistant and Web startup resolve `node:sqlite` instead of looking for a third-party `sqlite` package.

- [Fixed] Recover an exited Assistant service through Studio when retrying or stopping, restore its original port and refresh connection credentials while preserving the page and drafts. Accept the replacement service state sequence, reject retired snapshots, and bind cancellation to the original run and tasks.

- Fixed duplicate windows opening or running the same conversation: the duplicate view is read-only while different conversations can run in parallel. History saves merge each window's sessions. Durable reconnects and idle model changes no longer resubmit historical input, and startup failures retain their original cause.

- Fixed configuration uploads to use the locally verified template version instead of the latest version's field permissions, and preserved inherited child locks during publication filtering.

- [Fixed] Read configured Kanban basemaps through the authenticated project file bridge when the attachment endpoint returns 404. Preserve original image bytes, report file errors for permission or transfer failures, and cancel reads when the host closes or authentication changes.

- [Fixed] Allow stopping the current task during event-stream interruptions, bypass ordinary mutation queues for stop and cancel controls, and show pending, confirmed and failed stop feedback. Manual reconnect shows immediate progress and failure feedback and releases obsolete requests without replaying business operations.

- Added separate configuration values and publication permissions, multiple published profiles, defaults, JSON path controls and recipient previews; downloads verify and cache template assets and configuration tools work with the panel closed.

- [Fixed] Remove the 2 MiB limit from file resource cards. Load original image bytes through scoped asset URLs and fit images to the preview; preserve full text and Markdown content.

- [Fixed] Preview the workspace project for current-project Kanban and project cards in Studio Assistant, preserving named configurations and Server data access. Reopening saved cards no longer treats the dedicated assistant as the Kanban project.
- [Fixed] Keep inline resource preview failures in their own card in conversations and workflows, without leaving errors above the composer or affecting later messages and conversations.

- [Fixed] Keep project configurations and other dialogs below native window and mode controls in Studio Steam mode. Short windows retain headers, close buttons and configuration save controls while content scrolls, including nested field editors and rename dialogs.

- [Fixed] Resize conversation and Studio Assistant composers to the available height. Long drafts, attachments and primary parameters scroll within the input area, keeping the input and Send button accessible in short windows.

- [Fixed] Drag the Studio window from empty areas of the project header in Steam mode. Controls and title text retain normal clicks and selection; dialogs and IDE mode suspend the drag surface.

- [Improved] Integrate Studio Steam window controls and mode switching into the project menu or title, filling the window with runtime and tools while adapting to collapsed menus, narrow layouts and tool visibility.

- [Improved] Edit project configuration fields directly without a Set value checkbox. Reset icons restore defaults or clear overrides; boolean and multiple-choice controls retain their checkboxes.

- Fixed: project configuration file fields choose and upload files to Server storage, then save references. Type restrictions, replacement and clearing preserve the previous value when uploads fail.

- [Improved] Separate project configuration profiles, fields and saving. Group copy, rename and import/export into icon menus, use labeled icons for secondary actions, and keep saving and conflicting drafts accessible on narrow screens.

- [Fixed] Mount account access in the toolbar on Kanban pages without a sidebar, preventing initialization errors that leave the page connecting and loading indefinitely. Animate the loading indicator from the initial render.

- [Fixed] Retain values across configuration schema changes and preserve distinct worker configuration snapshots when durable sessions reload and resume.

- [Added] Share project configurations across Workflow, Conversation and Kanban, including a headless configuration command, custom fields, named profiles, full import/export and preserved conflicting drafts. Durable sessions reload after active work, and Kanban pages and resource previews update together. Business configuration no longer loads `.env`.

### Changed

- Keep the latest output visible when resource cards arrive together or previews resize asynchronously. Preserve the reading position when scrolling up, and resume following after clicking Go to latest message.

### Changed

- Fixed map and other resource cards failing to refresh after preview IDs expired. Refresh resolves the saved card in its original conversation or run, checks current access, loads the latest content, and shows a loading icon with retry available after a failure.

### Changed

- Match project page context menus to their targets: keep editing actions in inputs, offer Copy for read-only text selections, and omit Cut/Paste on empty areas.

### Changed

- Show tool descriptions directly in expanded permission sections, preserving multiline usage instructions.
- Group CLI Web tool permissions by common tool types and namespaces, with counts and initially collapsed sections that retain their expanded state on the page. Search names and descriptions to expand matching results, then clear the search to restore the previous sections.

### Changed

- Use square avatars with small corner radii throughout CLI Web messages and account views, removing the backing color once an image loads to avoid surrounding padding.
- CLI Web displays clickable project avatars before response duration and account avatars beside user messages. Project toolbars use the current project avatar, with stable updates and image fallbacks.
- Project templates save a type icon with random colors at a contrast ratio of at least 4.5:1 in the manifest; static inspection returns avatar metadata to Studio.

### Pi Durable

- [Fixed] Keep automatic retry records at the affected response's interruption point, followed by resumed content. Completing a run or reopening history no longer appends Retry below the complete answer; details still expand in place.

- Move the complete durable Agent task panel into Studio Trace. Remove the CLI Web sidebar, entry and width state while retaining transcripts, queues and forks. The host bridge carries deduplicated task snapshots, plan approval boundaries and explicit conversation controls, validates owners and returns action errors.

- [Fixed] Show the latest plan document and its approval state in the task sidebar even when the model does not call `update_plan`. Keep the correct plan through revisions, execution and reopening using approval boundaries; execution steps remain separately persisted and editable.

- [Fixed] Hide answer footer actions while sending, running, awaiting plan approval or user input, or stopping. Show Trace, copy, retry and export once the answer has finished, keeping actions available for finished historical answers. Retain original and revised plans, decisions and execution output across resumed reports and durable snapshots. Reopening durable history restores the complete plan from saved snapshots without rerunning models or tools.

- [Fixed] Display durable usage per answer turn with call, input, output and cache details, keeping other forks out of the original answer. The composer ring uses the open conversation's latest standard outputs after follow-ups, forks, compaction and resets, and labels nonzero occupancy below one percent explicitly.

- Show Conversation messages, attachments and delivery status immediately on send, or a pending queue item while busy. Save conversations and resolve parameters in the background, preserve new drafts across acknowledgements, and retain failed sends for retries under their original request identity.

- [Fixed] Keep queued message controls in place and loading icons spinning while saving, sending now or withdrawing, with immediate per-message feedback. Newly submitted messages can request withdrawal before confirmation, and failed actions retain the input and a retry action without duplicate submissions.

- Preserve a failed durable owner report and its original error even when the primary answer has completed. Update Core's streaming block and failure settlement behavior so a failed answer does not leave tasks appearing active or resume them on reopening.

- [Improved] Split Tasks into equal-height conversation/active-task and completed-task regions with independent scrolling, and mark the open conversation. Show all loaded history and expand arguments, results and errors beside the selected task, with an action to open its conversation.
- [Improved] Resize the task sidebar from its left edge or keyboard, double-click to reset, and retain its width. Preserve conversation reading space and the full-width narrow view. Settled tasks display their terminal outcome even if historical snapshots retain an abort mark.
- [Improved] Collapse Tasks to the right and group context and stop commands in a labeled actions menu. Show stop commands only for applicable active work, excluding independent forks.
- [Improved] Remove the composer turn selector: messages queue while busy and run directly while idle. Durable queued messages have a Send now icon. Confirm before creating and opening a fork, and fix navigation when its state frame has not rendered yet.

- [Fixed] Show submitted arguments for active and completed tools in task details, including nested Code Mode calls. Update Core to prevent missing or misidentified tool output and reuse of previous approvals in ordinary Agent mode when call IDs repeat across turns.
- [Fixed] Update the durable Agent Core feature dependency to capture commands at submission, reject predeclared catalog drift on recovery, and protect source/destination backup ownership while retaining the existing conversation and task sidebar UI.
- Added task definition versions, checkpoints, wake times and Code Mode scripts to durable task details. The Records view shows extensions, tool catalogs, execution targets and storage status using the existing Studio / VS Code style and four-view layout.
- Fix export and compaction after a durable foreground finishes. Preserve recovery commands during slow tool initialization, resume saved queued inputs, and restore fork history and source links after a lost receipt. Isolate command confirmations by owner and target conversation, ignore JSON key order when deduplicating commands, and keep full session frames out of persistent trace history.
- Added a Studio / VS Code styled durable Agent sidebar with Tasks, Plan, Records, and Usage views, a narrow-panel return action, queued-input withdrawal, steering, message forks, context reset, and scoped stop controls.
- Persistent Agents now use bidirectional worker commands, stable request identities, unconfirmed-command recovery, and full snapshots. Foreground/background/connectivity states are separate, pages select conversations independently, slow connections retain the latest snapshot, and answers remain inline without duplication.
- Release completed Conversation tasks even if saving their final state fails. Stop and join workers and cancel parked approvals when saving the stop intent fails, preventing continued execution or stalled shutdown.
- CLI Web / Studio recover Conversations that declare recovery using their original run, messages, arguments and approvals. Show Recovering in the existing status line, retry unexpected worker exit up to three times, and continue the same run on Retry. Host closure preserves checkpoints; explicit Stop durably cancels tasks and conversation deletion removes Agent storage.

### Fixed

- Restore legacy conversation history by most recent activity on its first open in Studio / CLI Web, then remember the last selected conversation while keeping each open window's selection independent.
- Recover stalled Web connections with handshake and snapshot deadlines, observable SSE heartbeats, and continued backoff retries during temporary outages. Retry replaces the old connection immediately and restores the complete state without rerunning background tasks.
- Fix profile image data URLs not displaying in CLI Web. Refresh avatars, names and avatar removal periodically without interrupting tasks on transient network failures.
- Fixed downloads reusing a different local version by UUID and incorrectly reporting a root or pinned dependency as already downloaded.
- Fixed published source downloads being rejected when a project declares pending relationships.
- Fix published Workflow and Conversation downloads being incorrectly restricted to Kanban projects.
- Remove remote execution commands from root help and describe permissions and upload progress as project operations and static file processing.

### Changed

- [Improved] Use status icons in CLI Web conversation and workflow history, with continuously spinning indicators for running entries. Show the project's running count on the right of the page header, including when the sidebar is collapsed or hidden on narrow screens, independently of search and pagination and excluding idle durable workers.
- Remove Workspace remote execution and release targets; uploads use static project types and downloads have no platform restriction.

### New Features

- **Project template module**: Workflow, Conversation, and Kanban starters plus four local examples, for creating projects from Studio Start.
- **Standard message input**: Conversation always uses the standard input, with attachments under `conversation.attachments`.
- **Context rings**: CLI Web and Studio render rings through Core's standard `display` protocol, and Core Agent shows context occupancy.
- **File transfer commands**: `workspace file-upload/file-download/file-delete` move project images and files, up to 50 MiB each.

### Breaking Changes

- **API paths**: project endpoints moved from `/api/workflows` to `/api/projects`, and `workflowId` / `workflowName` are now `projectId` / `projectName`.
- **Upload convention**: the ignore file is now `.steamharnessignore`, and the upload package header is `X-SteamHarness-Package-Name`.
- **Project templates**: the runtime global is now `steamharness`, and entrypoints use `steamharness.defineProject`.
- Conversation removes its enable setting and custom main fields, with attachments moving to `conversation.attachments`.
  Migration: declare attachments through `conversation.attachments` and parameters through Auxiliary, Quick, Mode, and Slash.

### Added

- Added a standalone project-template module with three starters and four examples needing no model or sign-in.
- Added project creation from Studio Start, with centralized bilingual metadata, UUIDs, exact dependencies, and collision checks.
- Added a filterable parameter menu above the Conversation input for `/`, supporting selectors and boolean toggles.
- Added CLI Web and Studio rendering rings through Core's standard `display` protocol, pinned right of the composer.
- Added Core Agent using that ring for context occupancy, with details on hover or keyboard focus.
- Added keyboard and context-menu copying of CLI Web responses, errors, and logs, using the host clipboard inside Studio.
- Added a read-only Kanban bridge and lightweight activity records for local Studio analytics, merging real histories.
- Added Studio runs using imported related projects, validated by UUID and mutual grants.
- Added Chinese and English in Web run, Assistant, and Kanban interfaces, following the VS Code host language.
- Added `workspace file-upload/file-download/file-delete` for project images and files without publishing source.

### Changed

- Changed Conversation to hide the composer while awaiting user input or approval, then restore it with drafts and attachments.
- Changed `conversation.userInput` to configure visibility and answer-driven parameter updates that older requests cannot overwrite.
- Changed Quick groups with one visible parameter to open their options directly, close after selection, and restore trigger focus.
- Changed Quick parameter triggers to show an icon and the current selection, hiding text from the right in narrow toolbars.
- Changed the Conversation `/` menu to support project-declared execution commands, listing every command for a bare slash.
- Changed the Conversation menu to drop the left checkmark and keep a rounded container, with export results in the body.
- Changed context summaries to show running and completed states while preserving other drafts and attachments.
- Changed the area above the input to show plain text, where commands preserve the draft and update parameters.
- Changed connection status and retry to move into the affected reply, keeping sessions and drafts usable while offline.
- Changed CLI Web and Studio project runs to drop the fixed overall deadline, preserving cancellation on stop and close.
- Changed the Studio assistant to keep Studio Control's workspace, diagnostics, file navigation, theme, terminal, and view tools.
- Changed the gap between composer images and text, adding preview zoom, fit, actual size, and panning.
- Changed the composer to support selection, undo, redo, and host clipboard cut, and to allow displayed UI text to be selected.
- Changed image attachments in the composer and conversation to render directly instead of showing filenames.
- Changed New conversation to the top-right toolbar, with project information added on the left.
- Changed AI configuration to separate names from model selections, and AI usage to show balance, quota progress, and remaining amounts.
- Changed Web scrollbars to stay hidden until hovered, without changing layout dimensions.
- Changed conversation resource cards to fill the row and show successful KV, knowledge, and project calls directly.
- Changed resource cards to preview accessible cross-project resources, locate them in resource views, or open separate windows.
- Changed embedded Studio pages to copy through the VS Code clipboard, confirming with the host before reporting success.
- Changed embedded Studio projects to use the workstation account, ignoring cached CLI and environment credentials when signed out.
- Changed conversation execution details to a single Trace entry, opening the bottom panel in Studio with live events and tool calls.
- Changed alignment with Core's ordered parameter declarations so the CLI can inspect and run the new configurations.

### Fixed

- Fixed accumulated Conversation Slash commands now being validated on refresh and send, keeping valid parameters on conflict.
- Fixed sends retaining dynamic options, with replacing or restoring options clearing the old option state.
- Fixed export receipts counting the messages actually included in the file.
- Fixed Studio analysis reading wrong records after project type changes, UUID casing, and directory aliases.
- Fixed multiple windows preserving conversation context and deduplicating queued input, without stale records overwriting terminal states.
- Fixed request errors such as required-parameter validation lingering after a successful run, cleared when switching entrypoints.
- Fixed object and array output deltas discarding prior values, retaining a ring's limit and unit when only its value changes.
- Fixed inline ring updates preserving keyboard focus and showing only the inspected tooltip when several rings coexist.
- Fixed Conversation content clipped above the composer at the end of scrolling, preserving position while reading earlier messages.
- Fixed Thinking and tool status icons being rebuilt during streaming, which restarted the loading animation.
- Fixed the built-in Studio assistant's Auto approve default being overridden with Workspace in CLI Web.
- Fixed nested built-in Core links after moving projects under `build-in/`, which stopped local commands and MCP from starting.
- Fixed the Studio composer's paste shortcut being blocked by clipboard permissions, now passing text and images through the host.
- Fixed right-click opening the standard VS Code editing menu while preserving selection replacement and undo.
- Fixed obsolete AI usage replies overwriting new data and usage lingering after an account change.
- Fixed usage failures changing conversation input state, and slow usage queries blocking submissions and saves.
- Fixed long AI configuration names retaining the model summary and action icons.
- Fixed the Workflow parameter panel closing when its draft refreshes, so parameters can be edited consecutively.
- Fixed Studio menu paste commands not reaching the embedded input and losing text when images were pasted with it.
- Fixed image attachments previewing in the page and background page loads no longer taking input focus.
- Fixed sign-in feedback in narrow sidebars wrapping onto another row instead of stacking one character per line.
- Fixed resource cards reading local data despite Server storage declarations and project names missing localized values.
- Fixed stale preview reads being discarded after account or directory changes, preserving remote Kanban across re-verification.

## 0.2.0 - 2026-11-18

### New Features

- **Bot project memory**: Project configuration exposes default-on memory and retains saved entries when disabled
- **Compiled project releases**: Build, validate and run compiled entries with separate launch snapshots
- **Native Kanban conversations**: Embed local native chats with streaming replies, drafts, queues and approvals

### Breaking Changes

- Final sealed releases encode internals in v2 `structure.json` while retaining readable project and entry summaries.
- Minify declarations, configuration definitions, and JSON assets without changing string content or number literals.
- Snapshots and uploads/downloads share the decoder and integrity checks. Rebuild older releases from source.
  Migration: Rebuild old releases from source and use the v2 decoder for sealed structures.
- Project types, structure reports, templates and the Web host now use Bot.
- Conversation protocols remain, with stable request identities across initial, resumed and subsequent turns.
  Migration: Use Bot in project types/templates and retain stable request identities in embedded conversation messages.
- Move identity, name, version and declarations to `steamharness.json`; stop reading or writing `package.json.id` and `steamHarness`.
- Register aggregate child entries explicitly; each child configuration supplies its icons, declarations and schedules.
- Unregistered configurations stay inactive; uploads and downloads preserve the parent/child structure.
  Migration: Move legacy package.json project fields to steamharness.json and register aggregate child entries explicitly.
- Select registered entries in check, run, Web and MCP; Web switching preserves each entry’s drafts and background tasks.
- Remove related projects, dependency locks and combined publishing commands.
  Migration: Use aggregate entries/defaultEntry and per-entry commands instead of related-project, dependency-lock and combined-release flows.

### Added

- Added explicit Kanban Web apps with isolated origins, fixed HTTP/WebSocket proxies, scoped sessions, declared microphone access and connection cleanup on account changes.
- Added Kanban-only uploads containing complete static output without requiring build sources.
- Added “Search memory” to the Bot memory permission group alongside save, get, update and delete.
- Added a default-on memory switch and a Bot memory tool permission group to Bot project configuration.
- Added source memory defaults to releases and switch support to old installed configurations, preserving saved entries when memory is disabled.
- Added complete Workflow timelines and frame navigation to Kanban through local journals/attachments, including read-only previews.
- Added local Workflow start/stop, output pagination and run images to Kanban using native history. Optional Server guidance is collapsed by default.
- Added Cropper.js cropping, proportional resizing and padding before image parameter uploads.
- Added optional cropping with cancellation preserving the old value, using the same flow for selected files and clipboard images.
- Added numeric sliders with values/bounds in Workflow, Bot auxiliary fields and input prompts, retaining ordinary numeric inputs.
- Added Workflow image parameter thumbnails with full-image viewing and a top-right remove button.
- Added a clipboard-image button beside the file picker in browsers and Studio.
- Added live following of output and delayed images on the latest Workflow page, with pause-on-reading and a resume action.
- Added structured activity cards separating summaries, targets, screenshots and full text.
- Added 100-item Workflow pages with new-output notices and a stable reading position on older pages.
- Added incremental local history with paged image/text reads that remain available after stopping.
- Added clickable embedded Bot message cards for project-linked records, retaining message nodes and drafts during summary/status updates.
- Added per-reply business cards to embedded Kanban Bot chats, scrolling with replies and preserving drafts, history and message positions during status updates.
- Added an expandable task-plan progress panel beside the CLI Web response status.
- Added success-only panel hiding, retaining final progress after failure or cancellation.
- Added Send now within Bot replies to insert the message at the current position, collapse the preceding reply and continue output below it.
- Added hidden Send requested queue rows, stable section ordering across streaming/history reopening and retry support for failed sends.
- Added release commands and compiled execution with entry selection, validated inventories, compressed packaging and automatic latest-release uploads.
- Added entry-specific run snapshots retaining project identity/logo so Studio windows can start the selected entry.
- Added shared session writers for Conversation views in one Kanban page, with separate parameter and draft state.
- Added immediate claim release on close, continued editing after recovery/topic navigation and execution-owner retention for running tasks.
- Added project-defined @ choices, dynamic updates and header/transcript/footer slots to embedded Kanban Conversations.
- Added native composer reuse for multi-participant topics and delivery acknowledgements to other target conversations.
- Added @ search and references to current-entry skills, project files and project entries in Conversation composers.
- Added inline reference highlighting, filename-only labels with full-path hovers, keyboard selection and draft/queue persistence.
- Added local aggregate discovery and native Conversation embedding in Kanban with streams, drafts, parameters, queues, approvals and cancellation.
- Added business Workflow adapters for sends/durable receipts, binding each view to one conversation without passing login credentials.
- Added connection-error retention for cancelled requests without stale ordinary operation errors after recovery.
- Added aggregate Workflow calls and native Conversation stream subscriptions to Kanban.
- Added reuse of execution owners and durable FIFO queues, with manual recovery after reopening.
- Added a single project subagent-model choice reusing the AI model list, with Follow main model.
- Added unavailable display for deleted choices and child-model configuration in Studio while Settings supplies the main model.
- Added read-only runtime diagnostics to Kanban previews.
- Added the last 50 Bridge requests with file routes, HTTP status, pending reads and safe failure categories, plus queries for explicitly read-only page methods.
- Added a subagent status entry beside Responding with running, queued and completed counts.
- Added expandable roles, phases, progress, results and errors with child-conversation navigation.
- Added status retention after parent completion, expansion persistence across streaming/follow-up replies and last-known state while offline.
- Added interruption of old managed execution trees after forced-exit reopening, requiring explicit batch recovery.
- Added separate user and business queues: only successful user turns release pending input, never background reports.
- Added Studio editor opening for local file links, inline code paths and absolute paths in Agent replies and plans.
- Added relative/file-URI paths and line/column positions, plus corrected managed-file link handling.
- Added host user models, available choices and Manage models while retaining project model configuration APIs.
- Added safe-boundary updates and endpoint-matched credential restoration; keys stay out of page state, ordinary history and exports.
- Added initial Studio permission snapshots and capability-negotiated updates to CLI Web.
- Added startup-setting retention for current/background work, with updates adopted at safe idle boundaries.
- Added inheritance/history/pending-input/request-ID retention across remounts and recovery; standalone CLI does not persist this setting yet.

### Changed

- Changed Workflow, Bot and Kanban local runs in Studio and CLI Web to remove project ID, cloud registration and Server gates and guidance.
- Changed local identity fallback to use directory isolation without a valid ID; release builds still validate the authored UUID.

- Changed default account avatar colors for light and dark backgrounds while keeping the same pattern and colors across theme changes.
- Changed CLI Web sign-in to use the Server website instead of a local password form.
- Changed authorization to support return links, cancellation and shared entry sign-in state, with credentials isolated by channel and Server.
- Changed CLI Web Workflow history to match Bot lists: title, status icon and timestamp in one row.
- Changed long history titles to truncate automatically.
- Changed screenshot activity cards to place text left and images right, stack on narrow screens and retain full-image previews.
- Changed existing Workflow run views to show only results; entry and parameter forms appear when creating a run.
- Changed CLI Web to place Project Assistant next to the workspace name with the running count on its right.
- Changed toolbar ordering to New conversation, project entry windows, then other actions.
- Changed SteamHarness project artifact paths to use dist/steamharness/.
- Changed release, lock, snapshot, staging and template ignore paths to match; uploads exclude tool caches and reports.
- Changed child-completion inputs to stay hidden from user messages/queues while retaining assistant continuations and history.
- Changed internal completion to leave paused user queues unadvanced.
- Changed sleep rows and details to show expected/actual end times in the browser’s timezone, retained after completion and history reopening.
- Changed resource-card previews to reuse the current Studio window’s split editor and preview tabs instead of separate native windows.
- Changed templates, default Kanban entries and transfers to use build/<entryId>/ in source-root artifact namespaces.
- Changed frontend builds to clean only their own output.
- Changed entry artifacts, caches, reports and packaging to use root dist.
- Changed Kanban entry paths to resolve from the aggregate root, transfers to verify inventories and runtime data to remain outside projects.
- Changed subagent row summaries to show elapsed time and tokens on the right, with status retained in icons/details.
- Changed the latest response usage to include owned subagents in conversation totals.
- Changed background timing/usage to update live, freeze timing on settlement or disconnection and avoid double-counting after reopening.
- Changed Conversation, Workflow and assistant history to default to project/entry-isolated local SQLite.
- Changed window/crash coordination to use local file locks, with opt-in Server storage and no automatic migration or overwrite of old cloud/local records.
- Changed startup checks to run silently, hiding the check area while checking or ready.
- Changed Studio and standalone Conversation/Workflow/Kanban views to show guidance and rechecking only on failure.
- Changed reply timing to retain final durations after completion/failure/Stop and history reopening, with separate timing for durable follow-up turns.
- Changed Studio model parameters to use only Settings models and hide project AI.
- Changed standalone CLI Web to fall back consistently to project setup/defaults/requests, removing project references to Settings models.
- Changed Studio conversation/message/Workflow exports to use native save dialogs and notify the saved path after a successful write.
- Changed save cancellation to stay quiet and write failures to show errors.
- Changed CLI Web to consolidate AI usage, configurations, tools and skills under Project information.
- Changed the panel to fixed dimensions, sidebar navigation and independent scrolling, retaining drafts, tool search and model setup shortcuts.
- Changed skills to remain read-only with no permission switches.
- Changed CLI Web to separate tools and skills into tabs.
- Changed tools to retain permission controls and skills to use read-only guide cards without Enable/Auto-approve switches.
- Changed Conversation and Workflow to share the same panel.
- Changed local Conversations to consume inherited Core Agent parameter contracts directly.
- Changed structure reports, dynamic model options and execution input to share hidden/fixed parameter handling.
- Changed Web run failures to show concise HTTP status/guidance instead of expanding upstream HTML pages.
- Changed raw diagnostics to be collapsed under Technical details for Conversation and Workflow.
- Changed New conversation to use a clear plus icon in the Conversation toolbar.
- Changed aggregates to open their default entry with an icon-only Project windows button.
- Changed entry cards to compact type/default/current/runtime indicators with icons opening browser pages or Studio tabs.
- Changed entry opening by removing split views; any entry can open repeatedly in independent tabs on the shared runtime host.
- Changed entry icons/colors to be configured independently while only the root project owns a version.
- Changed user model menus to group built-in/custom choices with an Add model action at the bottom of standalone controls.
- Changed model and effort to select independently, preserving project grouping, reset and source restrictions.
- Changed parameter bindings to accept `userSetting: { key: "agent.permissionPolicy", mode: "fixed" | "default" }`.
- Changed fixed controls to show the system policy and open user settings; default controls keep the three editable permission choices.
- Changed defaults to follow the system value again after reset, save inheritance and overrides separately, and preserve permissions for active work.

### Fixed

- Fixed the installed Web worker’s metadata imports by bundling private workspace modules instead of relying on unpublished packages.
- Fixed localhost fallback links, login overwriting the selected Server with an old account, and late errors after cancellation.
- Fixed sign-out to clear the local account and attempt Server credential revocation.
- Fixed Kanban bridge failures to show the operation, error code and diagnostic ID.
- Fixed embedded failure diagnostics and CLI host logs to share an ID for looking up the underlying exception.
- Fixed guidance for cross-window ownership, expired views and Workflow receipt failures while retaining user-facing business rejection reasons.
- Fixed Bot release memory defaults to use the final entry/configuration declaration, fill omitted defaults and preserve v2 configuration profiles.
- Fixed New conversation reusing a blank Bot conversation already open in another window; each click creates an independent conversation.
- Fixed large inline images leaving results on progress text with a running indicator; completed records show saved images after refresh.
- Fixed terminal streaming to print initial output-item content immediately.
- Fixed Bot Stop to send cancellation directly while connected, show stopping progress and ignore late output instead of waiting for host recovery/durable retries.
- Fixed stalled owned workers to be interrupted and the UI to update at execution end without waiting for history receipts.
- Fixed Stop to preserve drafts, pause pending input and retain the child conversation’s cancellation scope.
- Fixed retry, new input and queue continuation after initial model/tool setup fails in manual recovery mode.
- Fixed Retry to preserve composer drafts while unfinished execution still requires explicit recovery.
- Fixed selected-text, message and code copying in Kanban/embedded conversations through confirmed host clipboard writes.
- Fixed editing routes to target the focused document and selection drags to avoid navigation.
- Fixed native conversation labels to show known project references by name and retain unknown tokens.
- Fixed renamed reference labels to refresh history without changing routes, code or drafts.
- Fixed scheme-less website addresses being treated as local files.
- Fixed website links to use Studio’s browser preference while retaining file line/column positions, attachments and text selection.
- Fixed selected @ menu contrast with paired theme colors for names, descriptions and categories plus a clear selection marker.
- Fixed plan text selections during confirmation/reordering, compatibility-mode scroll resets, narrow-window status overflow and untranslated stopping states.
- Fixed plan progress announcements for screen readers while the panel is collapsed.
- Fixed duplicate bubbles and lingering previews after Send now.
- Fixed history recovery to retain confirmation/deduplication identities and independent-fork retries to use the original task input.
- Fixed idle persisted-input promotion to run immediately and restored history to follow actual execution order.
- Fixed background reports blocking new input, Send now or idle configuration updates after a failed parent turn.
- Fixed queue handling to keep older user input paused while active replies retain normal queueing.
- Fixed compiled Kanban preview reloads to watch only artifacts and entry declarations.
- Fixed project-local image, JSON and other business writes triggering page reloads and interrupting editing.
- Fixed embedded header heights and icon sizes to match native window controls in Studio Steam mode.
- Fixed Server connection guidance to show failure-specific primary actions and one-click registration of unregistered projects.
- Fixed blocking guidance to hide Bot input, Workflow forms and Kanban controls while retaining drafts for recovery.
- Fixed cloud project opening through the host or an authenticated browser handoff.
- Fixed false open-in-another-window warnings while CLI Web checks ownership after switching Bot conversations.
- Fixed confirmed ownership conflicts to retain their read-only warning.
- Fixed Bot Stop to retain queued inputs and show Resume queue.
- Fixed Stop after owner exit to cancel persisted work directly without restarting the old model.
- Fixed Bot approval recovery to restore redacted credential references by model/endpoint so omitted history secrets do not look like a configuration change.
- Fixed durable commands to retry confirmation timeouts, temporary disconnects and readiness races by original request ID; late receipts reconcile pending input.
- Fixed repaired project connections to resume original input, browser deadlines to include recovery, and Stop to cancel retries immediately.
- Fixed composer initialization to wait for the first session snapshot so newly typed drafts are not cleared.
- Fixed project checks to retain results during retries/same-account verification, avoiding flickering guidance or ready-Kanban reloads.
- Fixed account changes to clear old check results.
- Fixed failure guidance to include HTTP status, recovery steps and account/Server settings, project information and cloud project actions.
- Fixed embedded multi-Bot sending to update immediately instead of waiting for a full read.
- Fixed native submission states and durable Workflow receipts, with explicit retries retaining the original request ID and composer draft.
- Fixed macOS packaging to exclude AppleDouble metadata from downloaded sources.
- Fixed package names containing path traversal and stale staging directories after packaging failures.
- Fixed download validation to reject runtime data, unregistered artifacts and entry names/paths colliding with managed directories or Windows device names.
- Fixed cross-entry Bot creation to sync the execution owner’s history before parameter setup, avoiding background replacement and false missing-session errors.
- Fixed cross-entry Conversation submit/resume/resolve/stop to allow a 120-second per-command durable receipt window while retaining cancellation.
- Fixed aggregate Workflow calls to retain the full 120-second Bridge/HTTP receipt window without automatically replaying writes.
- Fixed configuration attachment uploads to retain the current account across background checks while rejecting old results after account changes or sign-out.
- Fixed System AI catalogs to cache for 30 seconds.
- Fixed manual refresh and account changes to clear the catalog cache.
- Fixed Conversation, Workflow and assistant messages, drafts, runs and checkpoints to persist locally by default.
- Fixed streaming/history retention across login changes, with analysis using the same local records.
- Fixed worker crash recovery to await the old execution lease before continuing the same task with committed writes preserved.
- Fixed lease-recovery waits to stay bounded and respond to cancellation.
- Fixed worker output to await transport completion so slow hosts cannot accumulate full snapshots.
- Fixed live-host worker crashes to resume child tasks/checkpoints up to three times while retaining settled replies.
- Fixed Stop/forced-exit reopening to pause managed trees and user queues; background completion does not release pending input.
- Fixed unconfirmed child results to show Awaiting verification, with reasons and unfinished progress.
- Fixed child views to show the parent’s business task receipt so a finished reply is not mistaken for completed work.
- Fixed state isolation for cancellation, independent forks and other conversations.
- Fixed background history recovery starting executors during offline fork creation or receipt retries.
- Fixed Agent lease conflicts and false session-not-ready errors caused by that recovery.
- Fixed child reply timing to use persisted start/end times rather than restarting when a detail view is opened, refreshed or restored.
- Fixed history recovery and cross-window sync to reconcile completed, failed and stopped Agent turns.
- Fixed stale responding/recovery flags so settled replies stop timing and are not replayed.
- Fixed forks to run independently with isolated model, mode, permissions, execution locks and recovery.
- Fixed fork retention after source deletion, attachment copying, stale-control cleanup and compatibility with legacy shared-host branches.
- Fixed worker startup to retain early control commands, preventing reopened follow-up timeouts.
- Fixed duplicate Kanban preview refresh icons during loading or repeated refreshes.
- Fixed fork creation to copy only history through the selected reply without rerunning the project or checking System AI.
- Fixed fork dialogs to show creation/opening progress after confirmation, open the result automatically and display failures.
- Fixed fork creation without usable AI; model validation occurs when new input is sent.
- Fixed all project templates so Kanban no longer generates a Workflow execution script.
- Fixed independent fork effort changes and reopening incorrectly requiring the main conversation.
- Fixed fork/child navigation to match the current view’s request, ignore late/duplicate/foreign receipts and expose the source conversation.
- Fixed Stop All to retain original run/task-set checks across worker replacement.
- Fixed file/retry button flicker by keeping background draft saves from disabling controls while typing.
- Fixed real conversation switches to continue waiting for host confirmation.
- Fixed template creation to retain a complete empty-ID local project when Server ID allocation fails.
- Fixed later ID-registration retries to preserve intervening source edits.
- Fixed context usage tooltips to follow light, dark and host themes for background, text, border and shadow.
- Fixed large Kanban attachment reads to use full file timeouts instead of the ordinary 30-second task limit.
- Fixed attachment timeouts to return recognizable file Bridge errors.
- Fixed Studio analysis to skip imports whose folders were deleted, preventing Start status refresh failures.
- Fixed current-workspace missing projects and other read failures to remain marked unavailable.
- Fixed composer Stop to include current-conversation background batches/children and remain available during background work.
- Fixed disconnected owners to pause remaining work/input until explicit input reconciles the tree, avoiding queues stuck after configuration changes.
- Fixed Kanban/image cards to retain aggregate entry paths instead of failing with `Unknown project entry.`.
- Fixed read-only diagnostics to include card instances/reads and preview transports to retain the full large-file timeout.
- Fixed repeated Kanban configuration acknowledgements causing handshake request floods and map loading failures.
- Fixed page method updates to be coalesced.
- Fixed reconnection guidance to use a delayed compact overlay, avoiding brief-disconnect flicker while preserving map layout.
- Fixed new input after Stop while retaining legacy queue and edited submission identity compatibility.
- Fixed consecutive queued sends, immediate Send now/withdrawal and original-message restoration on failure; Stop/failure keep older input paused.
- Fixed embedded Workflow/Conversation/Kanban shortcuts to run before Studio shortcuts, forwarding only unhandled keys.
- Fixed input editing, copy/paste and IME handling during shortcut forwarding.
- Fixed subagent summaries to use neutral colors, reserving red for failed tasks and error details.
- Fixed historical failures making the entire subagent entry look like an error alert.
- Fixed conversation error classification by origin: execution diagnostics go to Studio Trace and operation failures remain separate.
- Fixed parameter, attachment and resource-opening errors to stay above the composer with dismissal that does not bypass validation.
- Fixed resource cards to retain explicit project and entry targets.
- Fixed previews to check the target entry, avoiding false project-unavailable errors for maps opened from the Assistant or another entry.
- Fixed forced-exit shutdown to bound worker cleanup and release conversation locks.
- Fixed queues to advance only after success; failure, Stop and timeouts retain input, and successful new explicit input can release the paused queue.
- Fixed embedded configuration styles leaking into nested dialogs, restoring content/footer spacing for adding and editing models.
- Fixed skill preview navigation to sit outside the independent document scroll area.
- Fixed content overlapping the navigation bar while retaining loading, retry and return-to-list actions.
- Fixed Skills to list/count actual project and Core guides with search, full SKILL.md previews and Markdown source.
- Fixed skill discovery tools appearing as skills and preview/return navigation changing the panel size.
- Fixed Project information to sync tool registrations/permissions while retaining search and editor focus.
- Fixed configuration failures stuck loading and child editors remaining open after the main panel closes.
- Fixed cards, selection and light/dark styling, with top tabs on narrow screens and stable panel dimensions.
- Fixed Studio analysis to skip stale imports after standalone manifests are removed or converted to aggregate children.
- Fixed local history to follow project declarations while genuine read failures remain unavailable.
- Fixed empty user model controls to show Configure model and open settings; adding a model restores the selection list.
- Fixed grouped menus to retain model management during loading and active work.
- Fixed the model ID `inherit` being mistaken for a permission marker.
- Fixed credential redaction to retain unrelated custom project output named `userSettings`.
- Fixed Kanban refreshes to recheck current related imports, preserving valid missing-import guidance while ignoring resolved errors.

### Removed

- Removed global and account memory with its tools, skills, authorization, service integration and settings controls.
