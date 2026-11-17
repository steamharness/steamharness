# Unreleased

### New Features

- **Bot project memory**: Bots keep project memory on by default, save lasting facts and look them up on each turn
- **Local runtime persistence**: Run history and Agent checkpoints default to local SQLite, keeping remote reads off the reply path
- **Cancellable sleep**: The built-in `sleep({ seconds })` stores its deadline and waits only the remaining time after recovery

### Breaking Changes

- Read versioned Brotli + Base64 release structures through the shared decoder, keeping project and entry summaries in plain text.
- Reject corrupt, oversized, or previous-format payloads before using entry, parameter, or model metadata.
  Migration: previous-format release structures are rejected; rebuild releases with the current SDK.
- Replaced Conversation projects with Core Agent Bots declared through defineBot.
- Standardized input, output and durable sessions, with input preparation, persistent completion receipts and tool policies that can require approval in every mode.
  Migration: switch Conversation projects to `defineBot` with Core Agent; the session protocol stays compatible.
- Project identity, name, version and declarations now use independent `steamharness.json` files, and reads and writes of `package.json.id` and `steamHarness` are removed.
- Aggregates explicitly register child entries whose configuration defines icons, declarations and schedules.
- Unregistered configurations stay inactive, and transfers preserve the parent and child structure.
  Migration: move identity, name, version and declarations into `steamharness.json`; register aggregate child entries explicitly.
- Projects register entries/defaultEntry under one projectId, including multiple entries of the same type.
- Configuration and execution are isolated by entry; calls preserve identity and cancellation and recheck permissions.
  Migration: register entries/defaultEntry under the root projectId; cross-entry calls recheck permissions.

### Added

- Added Kanban structure reports preserve explicit Web application declarations for complete local H5 applications.
- Added Bot memory is maintained silently: the model judges and saves lasting facts automatically, and each turn starts with a keyword lookup.
- Added `memory_search` with multiple keywords, relevance ranking and bounded excerpts, defaulting to at most 5 entries.
- Added project memory is enabled by default for Bots, configurable through project settings or `defineBot.memory.enabled`.
- Added built-in save, get, update and delete tools include guidance, project/entry/category isolation, revision checks and retrieval across conversations.
- Added local run journals can read activity by capture time, returning bounded frame references, activity buckets and the selected moment while keeping existing pages and history.
- Added File parameters support image cropping options and minimum/maximum pixel dimensions, preserved in structure reports and waiting-input forms with validated bounds.
- Added Numeric parameters support `control: "range"` with `range: { min, max, step }` for sliders. Parameter parsing and resolver values validate the bounds.
- Added The project generator documents structured activity records for business events, complete text, and managed attachments.
- Added local Workflow history now supports an incremental output journal and page reads; partial final snapshots preserve earlier output.
- Added deletion and backup of that history include the complete journal.
- Added Complete clipboard and editing relays for nested Kanban conversations while retaining sandbox and session boundaries and cleaning pending copies on close.
- Added Custom Kanban references accept suggest: false to retain historical display labels while hiding items from the mention menu.
- Added Native Kanban conversation cards support a labeled click callback that receives current card and turn IDs, without URLs or scripts.
- Added Kanban Conversation UI accepts bounded plain-text messageCards linked to native replies by request ID, without script or navigation access.
- Added a durable internal status input resumes the parent when child work drains, ending related sleep early.
- Added the input retains outcome counts, notification identity, cancellation and failure boundaries, while ordinary timed waits keep their duration.
- Added cancellable `sleep({ seconds })` with a persisted deadline so recovery waits only the remaining time. Remove host-disabled built-in and custom tools from model tool lists.
- Added Explicitly declared read-only Workflow operations are readable by local knowledge cards and Kanban previews, and the host validates each operation and rejects preview writes.
- Added Validate and run compiled project releases with readable entry metadata and separate development/release state.
- Added submission lifecycle events and explicit retries to embedded Kanban Conversations, allowing business transcripts to show immediate feedback and merge authorized receipts.
- Added public Kanban Conversation types support project-defined @ choices, dynamic UI updates, presentation slots and submission callbacks.
- Added multi-participant topics can reuse the native composer.
- Added aggregate Conversation entry control and trusted call provenance, preserving user, permissions and cancellation.
- Added the control supports durable receipts, snapshots, approvals, stop and explicit recovery.
- Added Durable snapshots expose subagent execution spans and usage, plus conversation totals including owned subagents.
- Added Failed, stopped and hidden children retain their spend; retries, reopening and independent forks do not double-count it.
- Added Agent storage through `steamharness/runtime-storage` isolates PostgreSQL records by account, workspace and session.
- Added execution leases, idempotent commits and document checkpoints are included, and custom hosts can adopt the storage explicitly.
- Added explicit `null` for unlimited total or per-role subagent concurrency, preserving default FIFO limits.
- Added Proven unsent tool failures can retry from business receipts; access denials, cancellation and unknown side effects remain retry barriers.
- Added project-defined subagent work attempt limits and backoff continue failed work in its original task and child conversation with committed checkpoints.
- Added verified completion receipts, non-retryable barriers, persistent budgets and cancellation keep retries bounded, and only the final outcome returns to the parent.
- Added Select one shared subagent model in project configuration or define it in code.
- Added Reuse configured models with inheritance, independent connections and credentials, capability clamping and system-AI authorization.
- Added durable delegation tasks expose `childConversationId`.
- Added anonymous and named subagents can locate their child conversation while active, settled and reopened, and conversation and Trace views can open it.
- Added named agent roles, durable FIFO concurrency, shared management commands and checkpoint retries.
- Added Dynamic sessions and wrapped executors inherit durable control; recovery rechecks role access and retains business task history and progress.
- Added skills.directories to Core Agent nodes and projects so runtime tools and host previews share one declaration.
- Added Hosts can list project and Core built-in guides and read complete SKILL.md files by catalog ID without running tool factories or tasks.
- Added built-in assistant parameters for Core Agent projects, inherited automatically by defineExecutor with model resolution.
- Added Fields support overrides, visibility, disabling, fixed values and grouping; business workflows can select a coreAgent contract.
- Added The input helper accepts ExecutorContext, and static reports share the runtime contract.
- Added user model lists let connection-free Agent nodes and direct calls run without extra setup.
- Added calls choose the user or legacy project source explicitly; model parameters follow by default and can be overridden, and System AI source limits always apply.
- Added immutable, execution-scoped user settings through `getUserSettings`, `withUserSettings`, and host validation with `parseUserSettings`.
- Added Explicit `permissionPolicy: "inherit"` uses the user policy, falling back to `auto` without a host.
- Added Omitted policies still default to `workspace`; turn input takes precedence and tools share the resolved scope.

### Changed

- Changed The project generator documents Kanban background Workflow controls, output pages and run images.
- Changed Update project generation and artifact validation to keep caches, reports and release output under dist/steamharness/.
- Changed Show the expected sleep end time while waiting and retain the actual completion time in results.
- Changed Include live tool progress in conversation output and durable snapshots, retaining the original deadline after recovery.
- Changed Group entry builds and static assets under each source root in dist/steamharness; reject entries that occupy another entry's build.
- Changed Reject entry names and paths that collide with managed artifact directories or Windows device names, protecting caches and reports during builds.
- Changed Rebuildable outputs use the aggregate root dist. Standalone SDK history defaults to ~/.steamharness/runtime/<projectId>/<entryId>/ outside the project.
- Changed KV, PersistentValue and local KV APIs are removed; conversations and run records default to local SQLite with optional explicit Server storage.
- Changed Conversation state, usage and default Agent sessions persist locally. Added versioned session snapshots and fork/isolation/cancellation helpers.
- Changed Explicit Server storage still aborts execution on lease loss, without automatic legacy KV/SQLite migration.
- Changed Agent models use separate settings and project modes: Studio hides project AI configuration, standalone CLI Web uses project models, and empty settings never fall back.
- Changed Project models retain only System AI and Third-party AI sources.
- Changed Renamed the development project generation skill to steamharness-generator and synchronized skill copies, validation and generator references.
- Changed Default Conversation parameters now separate model and effort into independent Quick controls.
- Changed User snapshots accept full host built-in catalogues while retaining the 100 custom-model limit and globally unique model IDs.
- Changed parameter `userSetting` bindings support fixed user policies or user defaults with project overrides.
- Changed fixed controls show the actual policy and open user settings; editable controls retain the three original choices.
- Changed reset restores inheritance without persisting the displayed value as an override, and active work keeps its snapshot.

### Fixed

- Fixed Kanban bridge errors include the operation and error code.
- Fixed Known resource setup and sign-in failures show specific guidance, while unknown host exceptions retain a safe generic message.
- Fixed default memory tools replacing `agent.extraTools`. Configured tools now coexist with per-run `createTools`, and both reject reserved Core memory tool names.
- Fixed inconsistent Bot memory defaults by following the exported Bot, filling omitted switch defaults, and inspecting the selected release entry.
- Fixed Terminal streaming now prints the initial content carried by output items.
- Fixed promoted persisted inputs remaining queued when idle or after a failed turn.
- Fixed Start a new turn with the original identity and images after applying queued context writes, and keep repeated promotions idempotent.
- Fixed reopening an unfinished request after compaction reuses its summary and committed tool results, narrowing saved tool declarations to current authorization.
- Fixed partial-answer recovery preserves the system prompt.
- Fixed Host tool disabling also applies to session, native and deferred tools.
- Fixed Replacing catalogs between turns releases old connections and refreshes callbacks while retaining history and definition checks.
- Fixed Concurrent runs on one runtime are rejected before they can overwrite active state.
- Fixed restore the prepared system prompt and tool declarations after request-time context compaction, so long tasks can continue calling tools.
- Fixed the restore preserves current authorization and loaded deferred tools.
- Fixed background reports to deduplicate business events and coalesce pending progress.
- Fixed Failed or stopped parents retain results for explicit continuation, preventing repeated completion notices from restarting model retries.
- Fixed Configuration denials retain their own failure category and wording, with one authorization retry budget per input.
- Fixed Default child-agent concurrency to three, durably queue excess work and fill released slots.
- Fixed Retry run configuration authorization up to ten times before continuing the same task.
- Fixed Resolve the generator's exact CLI version from the adjacent CLI package without depending on bundled examples, keeping SDK and CLI versions independent.
- Fixed Agent command receipts no longer wait for snapshot delivery.
- Fixed Session projections and explicitly safe tools retry up to three times and continue automatically while preserving request identity, authorization, and cancellation.
- Fixed aggregate Workflow calls from Kanban using a separate 120-second Bridge deadline so durable receipts can complete.
- Fixed Suspending a durable Agent interrupts its enclosing project instead of reporting a partial reply as successful; reopening continues from the original checkpoint.
- Fixed durable Agent trace timing: reasoning and text items retain the model request span, including time to first token, and tool items use persisted task spans across reopen.
- Fixed System AI catalogues use a 30-second, connection-scoped memory cache and shared refreshes.
- Fixed Explicit refresh remains available; expiring credentials refresh online and denied refreshes cannot reuse old tokens. Managed files use conditional requests.
- Fixed Runtime history and Agent checkpoints default to local SQLite, removing per-operation network waits from first response.
- Fixed `createLocalRuntimePersistence` and explicit background snapshot copying with `copyRuntimePersistence`, preserving opt-in Server storage and existing data.
- Fixed durable Agents retain only the latest complete session snapshot, coalesce pending views and serialize publication for slow consumers.
- Fixed this keeps stale snapshots from exhausting memory during long multi-agent runs.
- Fixed streaming nodes can customize in-memory collection with `accumulateChunk`; chunk hooks still receive every original event.
- Fixed independent conversation copies losing document version changes and replacement identities when their JSON content stayed equal, preserving checkpoints for later forks.
- Fixed Durable Agent turn snapshots now expose persisted execution timestamps so hosts can restore elapsed time when opening subagent conversations and history.
- Fixed conversation branches to support independent root sessions with truncated history and historical asOf document checkpoints.
- Fixed Execution identities are renewed without importing tasks, approvals, queues or usage; source cancellation and deletion do not affect the new conversation.
- Fixed durable conversations fork committed history offline using the same atomic operation and deduplicated receipts as live sessions.
- Fixed document inheritance policies are preserved without starting models, tools or pending tasks.
- Fixed generator scaffolds to support names beginning with digits and multiline prompts.
- Fixed conversation cancellation to atomically stop and join the target execution tree, preventing coordinators from dispatching work between cancellations.
- Fixed Explicit host cancellation also stops background batches and owned tasks.
- Fixed Existing Agent sessions discover and persist authorized catalog additions through tool search, so adding Studio diagnostics no longer invalidates the whole directory.
- Fixed Existing descriptions, parameters and replay policies stay pinned; incompatible changes and unauthorized tools remain rejected.
- Fixed Return current work and delivery receipts when sending to queued, settling or settled subagents, without failing on normal lifecycle changes or restarting work.
- Fixed Concurrent role checks share in-flight lookups and retry transient network/service failures within the original deadline; explicit denials remain immediate.
- Fixed apply up to 10 fallback retries to every model request error without classifying its text or status, including streams, durable sessions, deferred responses and summaries.
- Fixed retries keep partial output, committed tool results and per-attempt usage; unfinished calls are discarded, failures keep the message queue, and cancellation applies at once.
- Fixed Release losing task waits before rechecking multi-agent concurrency slots.
- Fixed Explicit management actions ignore model-filled legacy result fields so listing or inspecting work is not incorrectly rejected.
- Fixed built-in assistant parameters for Core Agent projects are inherited automatically by defineExecutor with model resolution.
- Fixed field overrides, visibility, disabling, fixed values and grouping are supported, and business workflows can select a coreAgent contract.
- Fixed ExecutorContext input helpers and static reports share the same runtime contract.
- Fixed Core Agent projects and coreAgent wrappers inherit host recovery.
- Fixed reconnecting unfinished work with its original runId after a crash so later input is not blocked by stale busy state.
- Fixed Retry transient request-construction, stream-iteration/result, summary and deferred-fetch exceptions, including nested transport codes and HTTP 408/409/5xx.
- Fixed Manual compaction uses bounded retries while retaining text, tool results and per-attempt summary usage; host storage and callback failures remain terminal.
- Fixed Retry temporary upstream unavailability, in-stream upstream_error failures without an HTTP status, and connection failures such as ECONNRESET across ordinary requests.
- Fixed durable sessions and automatic compaction, preserving diagnostics, partial text and committed tool results within the existing retry budget.
- Fixed paged skill catalogs and file listings, byte-bounded JSON continuation with change detection for long child results, and bounded write acknowledgements.
- Fixed large-file tails and read-only environment long-line reads, silent search/list omissions, missing shell truncation and timeout diagnostics.
- Fixed commands starting after cancellation, failed children reported as completed, and UTF-8 MCP schema size checks.
- Fixed skill reads with JSON byte-bounded pages and offset/limit/nextOffset continuation, preventing durable output truncation.
- Fixed Subagents advertise only allowed exact model overrides and explain inheritance. File cards expose target fields, actionable errors and ignore inapplicable preview=false.
- Fixed Core Agent input to exclude disabled fields, enforce fixed user-setting bindings, preserve legacy model and mode flags, and keep message text out of parameter parsing.
- Fixed Static inheritance supports shorthand references and namespace imports; undefined field overrides retain existing defaults.
- Fixed Allow up to 30 seconds for restricted project role checks so slow queries do not incorrectly downgrade developers or owners. Failed checks still revoke elevated access.
- Fixed automatic user model parameters retain inheritance, and direct calls load explicitly selected project models.
- Fixed connections and inherited permissions share one host snapshot; cached connections keep developer model attributes and search limits, and `inherit` stays a valid model ID.

### Removed

- Removed global and account memory, including tools, skills, authorization, service integration and settings controls.
