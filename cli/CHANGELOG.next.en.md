# Unreleased

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

- [Fixed] Open an independent new conversation when creating an Assistant tab in Studio, preserve running conversations and drafts in existing tabs, and restore each tab's own selection.
- [Added] A subtle user-message index on the left of long conversations. Each marker previews its message and position on hover or keyboard focus; clicking jumps to it and keeps your reading position. The narrow index shows the total count, scrolls for long lists, and previews attachments.

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

### Conversation scrolling

- Keep the latest output visible when resource cards arrive together or previews resize asynchronously. Preserve the reading position when scrolling up, and resume following after clicking Go to latest message.

### Resource Card Refresh

- Fixed map and other resource cards failing to refresh after preview IDs expired. Refresh resolves the saved card in its original conversation or run, checks current access, loads the latest content, and shows a loading icon with retry available after a failure.

### Studio Context Menus

- Match project page context menus to their targets: keep editing actions in inputs, offer Copy for read-only text selections, and omit Cut/Paste on empty areas.

### Tool permissions

- Show tool descriptions directly in expanded permission sections, preserving multiline usage instructions.
- Group CLI Web tool permissions by common tool types and namespaces, with counts and initially collapsed sections that retain their expanded state on the page. Search names and descriptions to expand matching results, then clear the search to restore the previous sections.

### Project Avatars

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

### Changes

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
