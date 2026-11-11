# Unreleased

- Terminal streaming immediately prints initial output-item content.

- Workflow results show 100 items per page, preserve the selected history page while output arrives, and provide a return to the latest page. Local output is saved incrementally and remains readable after stopping.

- Fix Bot Stop waiting on host recovery and durable command retries. Connected pages send cancellation directly and show stopping progress immediately. Interrupt a stalled owned worker, ignore late output, and update the UI when execution ends without waiting for its history receipt. Preserve drafts, pause queued input, and keep child cancellation scoped.

- Fix retrying, sending new messages, and continuing queues after initial model or tool setup fails in manual recovery mode. Retry preserves the composer draft, and unfinished execution still requires explicit recovery.

- Fix selected-text, message, and code copying in Kanban and embedded conversations through confirmed host clipboard writes. Route editing to the focused document and keep selection drags from navigating.

- Native conversations display known project references by name and preserve unknown tokens. Label updates refresh history display while retaining routing identities, code, and drafts.

- CLI Web groups Project Assistant with the workspace name and places the running count beside it. Toolbar actions start with New conversation, followed by project windows and the remaining actions.

- Embedded Bot message cards can open project records through a card callback while preserving message nodes and drafts during text and status updates.

- Fix scheme-less website addresses in conversations being treated as local files. Website links follow the Studio host's browser preference while file positions, attachment handling and text selection are preserved.

- Embedded Kanban Bot conversations can display business cards below their matching replies, preserving drafts, history, and message positions during status updates.
- Group SteamHarness project artifacts under dist/steamharness/, including releases, locks, snapshots, package staging and template ignore rules. Uploads exclude tool caches and reports.

- Fix contrast for selected @ menu choices with paired theme colors for names, descriptions and categories, plus a visible selection marker.

- Fix CLI Web plan selections and scroll positions being lost during confirmation pauses and task reordering in older browsers, overflowing status labels in narrow panes, and untranslated stopping states. Announce progress while the plan panel is collapsed.

- Fix duplicate bubbles and lingering sending previews after Send now. Retain request identities for confirmation and replay, retry the original task after an independent fork, start promoted persisted inputs while idle, and restore history in execution order.

- CLI Web shows task-plan progress beside the response status, with an expandable task list. The panel hides when the reply succeeds and preserves the last progress after failure or cancellation.

- Send now during a Bot reply immediately places the message at the current conversation position, collapses the preceding response, and continues output below the message. Remove the Send requested queue row. Streaming and reopened history preserve these sections; failed sends can be retried.

- Fix queued background reports blocking new input, explicit queue sends, or idle configuration updates after a failed turn. Older user queues stay paused, and active replies retain normal queueing.

- Hide subagent completion inputs from user messages and pending queues while retaining assistant continuations and history. Internal completion does not independently advance a paused user queue.

- Sleep activity rows and details show expected and actual end times in the browser’s local timezone, retaining them after completion and history replay.

- Resource cards reuse a split editor and preview tab in the current Studio window instead of opening a separate native window.

- Fixed compiled Kanban previews reloading during local data writes. Only artifact and entry declaration changes trigger preview reloads, preserving active edits when images or JSON are saved elsewhere in the project.

- Knowledge cards now use descriptive titles and retain search and document selections when opening, refreshing, and returning to results.
- Match embedded project header heights and icon sizes to the native window controls in Studio Steam mode.

- Added declared read-only Workflow operations for local knowledge cards and Kanban previews, with per-request host checks that reject preview writes.

- Server connection guidance now shows actions for the reported failure, supports one-click cloud project creation, and groups typed project/database checks. Blocking failures hide Bot input, Workflow forms, and Kanban controls while preserving drafts; cloud project navigation uses the host or an authenticated browser handoff.
- Fixed CLI Web briefly showing the open-in-another-window warning while checking ownership after switching Bot conversations. Confirmed conflicts still show the read-only warning.

- Fixed Bot Stop preserving queued inputs and showing Resume queue; stopping an exited owner cancels persisted work without restarting its old model.
- Fixed Bot approval recovery comparing saved model references with restored credentials, so omitted history secrets no longer interrupt plan confirmation as a settings change.

- Breaking: project types, structure reports, templates and the Web host now use Bot; conversation protocols remain, with stable request identities across initial, resumed and subsequent turns.

- Durable Agent commands automatically retry confirmation timeouts, temporary connection failures, and readiness races with the original request ID. Late receipts reconcile pending input, repaired project connections resume the original run, browser deadlines cover recovery, and Stop cancels retries.
- Add project release builds, compiled execution, entry selection, validated inventories and automatic release uploads. Release run snapshots keep the project identity and logo while selecting a separate default entry for each Studio window.

- Conversation views within one Kanban page can share a session writer while retaining separate parameter and draft state. Closing a view releases its claim immediately; reopened views remain editable and running tasks retain their execution owner.
- The Conversation composer becomes editable after its first session state arrives, preventing newly typed drafts from being cleared by the initial snapshot.

- Fixed project checks retaining completed results during automatic retries and same-account verification, preventing flickering guidance and ready Kanban reloads while clearing old results on identity changes. Failure guidance includes HTTP status, recovery steps, and direct account/Server, project information, and Server project actions.

- Fixed delayed updates after sending in Kanban multi-Bot topics: embedded composers expose provisional submission states and durable Workflow results, with explicit retries preserving request identity and drafts.
- Embedded Kanban Conversations support project-defined @ choices, dynamic UI updates, and header/transcript/footer slots; projects can reuse the native composer for multi-participant topics and acknowledge deliveries to other conversations.
- Conversation composers support @ references to the current entry's skills, project files and project entries, with inline highlighting, compact file names and full paths on hover, keyboard selection and preservation in drafts and queued messages.
- Kanban can discover local aggregate entries and embed native Conversation chats with streaming, drafts, parameters, queues, approvals, and cancellation. Business Workflows can adapt submissions and durable receipts; each view is bound to one conversation without receiving login credentials. Cancelled requests retain their connection error type without leaving ordinary operation errors after recovery.
- Exclude AppleDouble filesystem metadata from macOS project packages so database artifact inventories and downloaded sources stay intact.

- Templates, default Kanban entries, uploads, and downloads use build/<entryId>/ under each source root's artifact namespace; frontend builds clean only their own output.

- Reject package names containing path traversal and clean staging after failures. Downloads validate required entries and database inventories and reject runtime data or unregistered artifacts. Entry names and paths cannot collide with managed directories or Windows device names.

- [Fix] Refresh acquired execution history before preparing a newly created cross-entry Bot session, preventing background history refreshes from replacing an in-flight session.

- Database generation accepts an aggregate root and --entry, deduplicates source roots, and returns outputs. Generated code, entry artifacts, caches, reports, and archives use root dist. Kanban entry paths resolve from the aggregate root; upload/download verify the new inventory and runtime data stays outside projects.

- [Fix] Allow 120 seconds for cross-entry Conversation submission, resume, input resolution, and cancellation receipts while retaining cancellation; map nested database failures to safe Kanban guidance.

- Fixed Kanban aggregate Workflow calls preserving the full 120-second receipt window through the Bridge and HTTP transport without automatically replaying writes.

- Kanban can invoke aggregate Workflows and subscribe to native Conversation streams, reusing execution owners and persisted FIFO queues with optional manual recovery after restart.

- [Fixed] Configuration attachment uploads remain valid during background account checks. The host still rejects stale results after the account changes or authentication is lost.

- [Fixed] Database and knowledge startup checks preserve Server transport and authorization errors. Temporary outages trigger automatic checks, and login or permission failures no longer incorrectly request rebinding.

- [Fixed] AI model catalogues are cached for 30 seconds and resource display data for 5 seconds. Each resource kind loads its bindings once, concurrent reads are merged, and manual refreshes and edits invalidate display data. Execution checks stay online, independent startup checks run concurrently, and management UI requests time out after 15 seconds.

- [Fixed] Conversation, Workflow and assistant messages, drafts, runs and checkpoints persist locally by default without login or remote database waits for history. Streaming is preserved, login changes retain local history, and analysis reads the same local records.

- Fixed worker crash recovery with relational storage by waiting for the previous execution lease to expire before resuming existing tasks, preserving committed writes and bounded, cancellable recovery.

- [Fixed] Worker output now waits for transport completion, preventing full snapshots from accumulating behind a slow host. Unexpected worker crashes under a live host resume the same child tasks and checkpoints up to three times while preserving settled replies. Stop or reopening after a forced host exit still pauses managed work and user queues; background completion cannot release queued input.

- [Improved] Subagent rows show elapsed time and token usage on the right, with status in icons and details. The latest response shows conversation usage including owned subagents, updates during background work, freezes elapsed time on settlement or disconnection, and preserves totals on reopen.

- Fixed subagent work with an unconfirmed result to show Awaiting verification with its reason and unfinished progress. Child conversations show the same task receipt as the parent so a finished reply is not mistaken for completed work. Cancellation, independent forks and other conversations retain their own state.

- Fixed database validation accepting conflicting or reserved model client names that could not be connected after generation.

- Changed: task-board templates use generated Browser descriptors and Task rows scoped by configuration, with optimistic row versions. Unbound boards block edits, failed writes retain drafts, and stale pages cannot write to rebound resources.

- Fixed background history recovery starting an executor while an offline fork or receipt replay was pending, preventing Agent lease conflicts and false session-not-ready errors.

- Added knowledge resource/grant/binding and document/attachment commands, plus database data for applied model rows. Catalogs support pagination and search; Web panels open Server resource pages without KV editing or local/remote switches.

- Conversation, Workflow and assistant history default to local SQLite isolated by project and entry. Local file locks coordinate windows and crash recovery. Server storage remains explicit; existing cloud and legacy local records are not automatically migrated or overwritten.

- Added database bind/bindings/unbind for host-owned relational bindings by account, project, entry and alias, with Core typed queries in Node runs and no project-persisted resource IDs.

- Added database provisioning, inspection, retry and read/write grant commands, plus versioned migrations with SQL, model snapshots and checksums. Applied-history changes, schema drift and unaccepted destructive migrations are rejected.

- Add database (db) init/validate/generate for steamharness.database.ts and steamharness.schema, including typed dual-target artifacts. Packaging generates assets automatically; upload/download verify static inventories while excluding other local runtime data.

- Run project startup checks silently in the background. Conversation, Workflow and Kanban pages in Studio and standalone CLI Web show setup guidance and rechecking only when a check fails.

- Fixed subagent reply durations to use persisted execution timestamps instead of restarting when their detail view is first opened, refreshed or restored.

- Keep the final duration visible after a reply completes, fails or stops, including after refreshing or reopening history. Durable Agent follow-ups are timed separately.

- Fixed history recovery and cross-window synchronization to reconcile completed, failed and stopped Agent turns, clearing stale responding and recovery states without replaying finished replies.

- Removed global and account memory, including tools, skills, authorization, service integration and settings controls.

- Fixed forks to run as independent new conversations with isolated models, modes, permissions, execution locks and recovery. Source deletion preserves branches, historical attachments are copied, old execution controls are removed, and legacy shared-host forks migrate safely. Worker startup now retains early control commands, preventing follow-up confirmation timeouts after reopening.
- Fixed duplicate refresh icons in conversation Kanban preview headers during loading and repeated refreshes.

- Fixed conversation forks to copy history through the selected response without rerunning the project or checking System AI. A progress dialog opens after confirmation, opens the branch on success and displays failure reasons. Branch creation works when AI is unavailable; model validation happens when sending new input.

- Fixed project templates: Kanban no longer includes a Workflow execution script. Task boards use the database alias API, clearly mark temporary mode without a binding, isolate named configurations, and protect existing data when reads or writes fail.

- Fixed independent fork effort changes and reopening without incorrectly requiring the main conversation. Fork and child navigation now follows only the current view's matching request, ignores late, duplicate or unrelated receipts, and exposes the source conversation. Stop All retains run and task identity checks across worker replacement.

- Fixed file selection and response retry buttons flickering while typing by keeping background draft saves from disabling them. Conversation switches still wait for host confirmation.

- Fixed template creation to preserve complete local projects with an empty ID when Server ID allocation fails. Registration can be retried separately while preserving source edits.

- Fixed the context window usage tooltip to follow light, dark and host themes for its background, text, border and shadow.

- Fixed Kanban attachment workers to use the full file deadline, preventing large map images from being stopped by the ordinary 30-second task limit. Timeouts return a recognized bridge error.

- Fixed Studio local analysis to ignore stale imports whose folders were deleted, preventing Start status refresh failures. Missing projects in the current workspace and other read failures remain unavailable.

- Fixed composer Stop to include the current conversation's background batches and subagents, keeping Stop available during background work. Disconnected owners pause their remaining tree and user queue until explicit input reconciles it, preventing configuration updates from holding messages indefinitely.

- Fixed Kanban and image cards losing their aggregate entry path and showing `Unknown project entry.`. Card instances and reads now appear in read-only runtime diagnostics, and file reads retain their full timeout through the preview transport.

- Fixed repeated Kanban configuration acknowledgements flooding the host and disrupting map loading; page method updates are coalesced. Connection recovery uses a delayed compact overlay, preserving the map layout and avoiding flicker during brief interruptions.

- Fixed sending new input after Stop and handling legacy queues and edited submission identities. Queue-enabled conversations accept consecutive sends; Send now and withdrawal respond immediately and restore failed actions, while Stop and failure keep older messages paused.

- Fixed: Workflow, Conversation and Kanban pages in Studio handle project shortcuts first and forward unhandled keys to Studio, preserving text editing, clipboard shortcuts and IME input.

- Added: Project configuration reuses the AI model list for a single subagent selection with Follow main model. Removed selections stay unavailable, and Studio can configure child models while using Settings for the main model.

- Added read-only Kanban runtime diagnostics with the latest 50 bridge requests, file routing, HTTP status, pending reads and safe failure categories, plus queries of explicitly read-only page methods.

- Fixed the subagent summary to use a neutral color. Red is limited to failed tasks and error details, so historical failures do not make the entire entry look like an error alert.

- Fix: Route conversation execution diagnostics to Studio Trace by origin. Keep parameter, attachment and resource-opening errors above the composer with a dismiss button; hiding an alert preserves validation.

- Fixed resource cards to preserve explicit project and entry targets and inspect previews using the target entry, preventing false project-unavailable errors when opening maps from the Assistant or another entry in the same project.

- Added a subagent status entry beside “Responding…” with running, queued and completed counts. Expand roles, phases, progress, results and errors, and open child conversations. The entry remains after the parent response, preserves expansion across streaming and subsequent replies, and identifies offline snapshots.

- Added: Interrupt unfinished managed execution trees on reopening and require explicit batch recovery. Keep pending user input separate from business queues; only successful user turns advance it, never background reports.

- [Changed] Studio model parameters use only Settings models and hide project AI. Standalone CLI Web falls back to project configuration consistently for setup, defaults and requests. Removed project references to Settings models.

- [Fixed] Bound worker shutdown and release conversation ownership after forced exit. Queues advance automatically only after success; failures, cancellation and timeouts retain pending messages, and new explicit input can run before the paused queue.

- Added: Open local file links, inline code paths and plain absolute paths from Agent replies and plans in the Studio editor, including relative paths, file URIs and line/column locations. Fixed managed attachment link handling.

- Fixed embedded project configuration styles affecting nested dialogs, restoring content and footer spacing when adding or editing models in Project information.

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
