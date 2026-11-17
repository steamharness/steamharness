# Unreleased

### New Features

- **Bot project memory**: Bots keep project memory on by default, save lasting facts and look them up on each turn
- **Local runtime persistence**: Run history and Agent checkpoints default to local SQLite, keeping remote reads off the reply path
- **Cancellable sleep**: The built-in `sleep({ seconds })` stores its deadline and waits only the remaining time after recovery

### Breaking Changes

- Use versioned Brotli + Base64 release structures while retaining readable project and entry summaries.
- Use the shared SDK decoder for entries, parameters and models; reject corrupt, oversized or old-format payloads.
  Migration: Rebuild old releases from source and use the shared structure decoder for entries, parameters and models.
- Replace Conversation projects with Core Agent Bots declared through defineBot.
- Standardize input, output and durable sessions, with input preparation, persistent completion receipts and tool policies requiring approval in every mode.
  Migration: Migrate Conversation declarations to defineBot and adopt the Bot input/output and durable-session contracts.
- Remove KV, PersistentValue and local KV APIs. Conversations and run records default to local SQLite with explicit Server storage available.
  Migration: Adopt runtime persistence; old KV/SQLite data is not migrated automatically, so preserve and migrate required records first.
- Move identity, name, version and declarations to `steamharness.json`; stop reading or writing `package.json.id` and `steamHarness`.
- Register aggregate child entries explicitly; each child configuration supplies its icons, declarations and schedules.
- Unregistered configurations stay inactive; uploads and downloads preserve the parent/child structure.
  Migration: Move legacy package.json project fields to steamharness.json and register aggregate child entries explicitly.
- Move projects to root projectId with entries/defaultEntry, allowing multiple same-type entries with isolated configuration and execution.
- Preserve identity and cancellation across entry calls and revalidate permissions.
  Migration: Declare projectId, entries and defaultEntry in the root manifest and target configuration/calls by entry.

### Added

- Added explicit Kanban Web application declarations to structure reports for complete local H5 host integration.
- Added silent Bot memory maintenance: the model saves lasting facts automatically, with an input-based keyword lookup at the start of each turn.
- Added `memory_search` with multiple keywords, relevance ranking and bounded excerpts, returning at most 5 entries by default instead of loading all memory.
- Added default-on Bot project memory, configurable through project settings or `defineBot.memory.enabled`.
- Added guided save/get/update/delete tools with project, Bot-entry, category and item isolation, concurrent revision checks and cross-conversation retrieval.
- Added capture-time activity reads to local run journals.
- Added bounded frame references, activity buckets and selected-moment details while preserving existing pagination and history.
- Added image cropping and min/max pixel dimensions to file parameters, preserving and validating these settings in structure reports and waiting-input forms.
- Added numeric sliders through `control: "range"` and `range: { min, max, step }`, with bounds checked during parameter parsing and resolver evaluation.
- Added structured activity records to project generation guidance for business events, full text and managed attachments.
- Added incremental output journals and page reads to local Workflow history; partial final snapshots preserve earlier output.
- Added complete output journals to history deletion and backups.
- Added nested Kanban clipboard and editing relays with sandbox/session boundaries and pending-copy cleanup on close.
- Added `suggest: false` to custom Kanban references to preserve historical labels while hiding entries from the mention menu.
- Added labeled actions to native Kanban conversation cards. Callbacks receive only card `id` and `requestId`, never URLs or scripts.
- Added bounded plain-text `messageCards` to Kanban Conversation UI, linked to native replies by request ID without script or navigation access.
- Added durable internal status inputs to resume the parent when child work drains, ending related sleep early.
- Added outcome preservation, notification deduplication, cancellation and failure boundaries; ordinary timed waits keep their duration.
- Added cancellable `sleep({ seconds })` with a persisted deadline and remaining-time recovery. Host-disabled built-in and custom tools are excluded from model tool lists.
- Added explicit read-only Workflow operations for local knowledge cards and Kanban previews.
- Added per-operation host validation that rejects writes from previews.
- Added validation and execution of compiled releases with readable entry metadata and separate development/release sessions and configuration.
- Added submission lifecycle events and explicit retries retaining the original identity to embedded Kanban Conversations.
- Added immediate sending feedback and direct merging of authorized receipts to business transcripts.
- Added project-defined @ choices, dynamic UI updates, display slots and submission callbacks to public Kanban Conversation types.
- Added native composer reuse for multi-participant topics.
- Added aggregate Bot entry controls and trusted call provenance that preserve the original user, permissions and cancellation signal.
- Added durable receipts, snapshots, approvals, stop and explicit recovery to aggregate entry controls.
- Added subagent execution spans and usage, plus conversation totals including owned subagents, to durable snapshots.
- Added usage retention for failed, stopped and hidden children without double-counting retries, reopening or independent forks.
- Added Agent storage through `steamharness/runtime-storage`.
- Added PostgreSQL records isolated by account, workspace and session, with takeover leases, idempotent commits and document checkpoints.
- Added explicit adoption of the storage by custom hosts.
- Added explicit `null` for unlimited total or per-role subagent concurrency while preserving default FIFO limits.
- Added business-receipt retries for proven unsent tools; access denials, cancellation and unknown side effects remain replay barriers.
- Added project-configurable subagent attempt limits and backoff.
- Added automatic failed-work continuation in the same task, child conversation and committed checkpoint.
- Added completion-receipt checks, non-retryable barriers, persistent attempt counts and cancellation boundaries against false success and endless retries.
- Added final failure reporting to the parent, including a retry-limit message when the configured limit is exhausted.
- Added one project-configured shared subagent model or a developer-defined default.
- Added reuse of existing model lists, main-model inheritance, separate connections/credentials, capability matching and System AI authorization.
- Added `childConversationId` to delegation tasks in durable snapshots.
- Added child-conversation links for named and anonymous subagents while active, settled or reopened, for conversation and Trace details.
- Added named Agent roles, durable FIFO concurrency queues, unified management commands and safe checkpoint retries.
- Added durable inheritance for dynamic sessions and custom executors, role revalidation on recovery and retained business task history/progress.
- Added skills.directories declarations to Core Agent nodes/projects for runtime skill tools with access checks.
- Added host listing of project/Core skills and read-only full SKILL.md previews by directory ID without running tool factories or tasks.
- Added built-in assistant parameters inherited automatically by defineExecutor with model resolution.
- Added field overrides, hiding, disabling, fixed values and groups, plus coreAgent references from business Workflows.
- Added ExecutorContext support to the input helper, with static structure reports sharing the runtime parameter contract.
- Added user model lists for connection-free Agent nodes and direct calls.
- Added explicit user/legacy-project model sources with inherited, overridable parameters and enforced System AI source/authorization limits.
- Added immutable execution-scoped snapshots through `getUserSettings`, `withUserSettings` and host validation with `parseUserSettings`.
- Added explicit `permissionPolicy: "inherit"` to use the user policy, falling back to `auto` without a host.
- Added unchanged default `workspace` policy, turn-input precedence and one resolved value for tool and path scopes.

### Changed

- Changed project generation guidance to cover Kanban background Workflow controls, output pagination and run images.
- Changed project generation and artifact validation to keep caches, reports and release outputs under dist/steamharness/.
- Changed sleep progress to show the expected end time and results to retain the actual completion time.
- Changed live tool progress delivery to conversation output and durable snapshots, retaining the original deadline after recovery.
- Changed entry builds and static assets to use build/<entryId>/ within each source root’s dist/steamharness namespace.
- Changed build validation to reject entries occupying another entry’s output directory.
- Changed entry validation to reject managed-directory and Windows-device-name collisions, protecting caches and reports during build cleanup.
- Changed rebuildable outputs to use root dist and standalone SDK history to use ~/.steamharness/runtime/<projectId>/<entryId>/ outside the project.
- Changed Conversation state, usage and default Agent sessions to persist locally, with versioned snapshots and fork, isolation and cancellation helpers.
- Changed explicit Server storage to retain lease-loss aborts without automatically migrating legacy KV or SQLite records.
- Changed Agent models to separate Settings and project modes: Studio hides project AI configuration, while standalone CLI Web uses project models.
- Changed empty Settings to avoid fallback, with only System AI and Third-party AI sources retained for project models.
- Changed the development project generation skill name to steamharness-generator and synchronized copies, checks and generator references.
- Changed default Conversation model and effort parameters to independent Quick controls.
- Changed user model snapshots to accept the full host built-in catalog while retaining the 100 custom-model limit and globally unique IDs.
- Changed parameter bindings to accept `userSetting: { key: "agent.permissionPolicy", mode: "fixed" | "default" }`.
- Changed fixed controls to show the system policy and open user settings; default controls keep the three editable permission choices.
- Changed defaults to follow the system value again after reset, save inheritance and overrides separately, and preserve permissions for active work.

### Fixed

- Fixed Kanban bridge errors to include the operation and error code.
- Fixed guidance for known resource and sign-in failures while retaining safe generic messages for unknown host exceptions.
- Fixed default memory tools replacing `agent.extraTools`. Configured tools coexist with per-run `createTools`; both reject reserved Core memory names.
- Fixed Bot memory defaults to follow the exported Bot, fill omitted switch values and inspect the selected release entry.
- Fixed terminal streaming to print the initial content of output items immediately.
- Fixed persisted input promotions that only returned receipts while idle or after a failed turn.
- Fixed promoted input execution to retain identity/images, apply queued context writes first and keep repeated promotions idempotent.
- Fixed unfinished-request reopening after compaction to reuse its summary and committed tool results.
- Fixed reopening to narrow saved tools to current permissions and preserve the system prompt during partial-answer recovery.
- Fixed host disabling for session, native and deferred tools.
- Fixed catalog replacement between turns to release old connections and refresh callbacks while retaining history and definition checks.
- Fixed concurrent runs on one runtime to reject them before active state can be overwritten.
- Fixed request-time compaction to restore prepared system prompts and tools so long tasks can continue calling tools.
- Fixed compaction to preserve current authorization and loaded deferred tools.
- Fixed background reporting to deduplicate business events and coalesce pending progress.
- Fixed failed or stopped parent turns to retain results for explicit continuation, preventing repeated completion notices from restarting model retries.
- Fixed configuration denials to retain their own failure category and wording, with one authorization retry budget per input.
- Fixed child-agent concurrency to default to three, durably queue excess work and fill released slots.
- Fixed authorization recovery to recheck up to ten times and continue the same task as soon as access recovers.
- Fixed the generator to read the exact adjacent CLI version without depending on bundled examples, keeping SDK and CLI versions independent.
- Fixed Agent command receipts to avoid waiting for snapshot delivery.
- Fixed session projections and explicitly safe tools to retry up to three times and continue with the same request identity, authorization and cancellation boundaries.
- Fixed aggregate Workflow calls from Kanban to use a separate 120-second Bridge deadline for durable receipts.
- Fixed durable Agent suspension to interrupt the enclosing project rather than report an unfinished reply as successful.
- Fixed reopening to continue from the original checkpoint.
- Fixed trace timing to retain model request spans, including first-token wait, for reasoning/text and persisted task spans for tools, including after reopening.
- Fixed System AI catalogs to use a 30-second connection-scoped cache and shared refreshes rather than reload on every run.
- Fixed explicit and near-expiry credential refresh while preventing reuse of old tokens after access is denied.
- Fixed managed-file caching to validate access through online conditional requests before reusing bounded cached content.
- Fixed runtime history and Agent checkpoints to default to local SQLite, removing per-operation network waits from the first-response path.
- Fixed local persistence via `createLocalRuntimePersistence` and opt-in background `copyRuntimePersistence`, preserving explicit Server storage and existing data.
- Fixed durable Agents to retain only the latest complete snapshot, coalesce pending views and serialize publishing for slow consumers.
- Fixed stale snapshot buildup that could exhaust memory during long multi-agent runs.
- Fixed stream collection to allow `accumulateChunk` customization while chunk hooks retain every original event.
- Fixed independent conversation copies losing document version changes and replacement identities when JSON stayed equal, preserving checkpoints for later forks.
- Fixed durable Agent turn snapshots to expose persisted execution timestamps for initial subagent views and history recovery.
- Fixed branch export as an independent root conversation with truncated history, historical asOf checkpoints and renewed execution identities.
- Fixed branch isolation to exclude tasks, approvals, queues and usage; stopping or deleting the source does not affect the new conversation.
- Fixed offline forks of committed history to share the atomic fork operation and deduplicated receipts used by live sessions.
- Fixed offline forks to preserve document inheritance without starting models, tools or pending tasks.
- Fixed generator scaffolds to support names beginning with digits and multiline prompts.
- Fixed conversation cancellation to atomically stop and join the target execution tree, preventing dispatch between individual cancellations.
- Fixed explicit host cancellation to stop background batches and owned child tasks as well.
- Fixed existing Agent sessions to discover and persist authorized tool additions through search without invalidating the old catalog when Studio diagnostics are added.
- Fixed catalog updates to keep existing tool descriptions, parameters and replay policies pinned and reject incompatible changes or unauthorized tools.
- Fixed sending to queued, settling or settled subagents to return current status and delivery receipts without restarting work or failing on normal lifecycle changes.
- Fixed concurrent role checks to share lookups and retry transient network/service failures within the original deadline; explicit denials stop immediately.
- Fixed all model request errors to receive up to ten fallback retries without classifying message text or HTTP status.
- Fixed fallback retries for streams, durable sessions, deferred responses and summaries.
- Fixed retry state to retain partial text, committed tool results and per-attempt usage while discarding unfinished calls.
- Fixed failure handling to leave the input queue paused and honor cancellation immediately.
- Fixed multi-agent concurrency waits to release unmatched subscriptions before checking slots again, avoiding buildup in long batches.
- Fixed management actions to ignore model-supplied legacy result fields so listing and querying tasks are not rejected.
- Fixed restricted configuration selection to survive outages, role downgrades, access recovery and reopening.
- Fixed guest fallback to enforce execution limits and explicit Ask selections to remain saved.
- Fixed Core Agent projects and coreAgent wrappers to inherit host recovery automatically.
- Fixed crash recovery to reconnect unfinished work by original runId, preventing stale busy state from blocking later input.
- Fixed transient request-construction, stream-read/result, summary and deferred-response exceptions to retry.
- Fixed retry classification to recognize nested network codes and HTTP 408/409/5xx.
- Fixed manual compaction to retry within bounds, retain text/tool results and each summary’s usage, and exclude host storage/callback failures.
- Fixed temporary upstream unavailability, statusless in-stream upstream_error and connections such as ECONNRESET to trigger automatic retries.
- Fixed consistent retry handling across ordinary requests, durable sessions and automatic compaction.
- Fixed retry handling to retain original causes, partial text and committed tool results within the existing budget.
- Fixed incomplete pagination of skill catalogs and file listings.
- Fixed long child results with JSON byte-bounded continuation and change detection, plus bounded write acknowledgements.
- Fixed large-file tail and read-only long-line reads, plus silent search/list omissions.
- Fixed missing shell truncation/timeout diagnostics and commands starting after cancellation.
- Fixed failed children reported as completed and UTF-8 MCP schema size validation.
- Fixed skill reads with JSON byte-bounded offset/limit/nextOffset pages so durable tool output does not truncate Chinese guides.
- Fixed subagent model overrides to expose only allowed exact values and explain default inheritance.
- Fixed file cards to expose target schemas and actionable errors while ignoring inapplicable preview=false.
- Fixed Core Agent input filtering to exclude disabled fields, enforce fixed settings, retain legacy model/mode options and keep message text out of option parsing.
- Fixed static inheritance to support shorthand and namespace imports, with undefined overrides retaining existing defaults.
- Fixed restricted role checks to allow 30 seconds, avoiding false guest downgrades for developers or owners; failed checks still revoke elevated permissions.
- Fixed automatic user model parameters to retain inheritance and direct calls to load explicitly selected project models.
- Fixed model connections and inherited permissions to share one host snapshot; cached connections retain developer model attributes and system search limits.
- Fixed selection of the model ID `inherit`.

### Removed

- Removed global and account memory, including its tools, skills, authorization, service integration and settings controls.
