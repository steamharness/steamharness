# Unreleased

- [Fix] Resolve the generator's exact CLI version from the adjacent CLI package without depending on bundled examples, keeping SDK and CLI versions independent.
- Agent command receipts no longer wait for snapshot delivery. Session projections and explicitly safe tools retry up to three times and continue automatically while preserving request identity, authorization, and cancellation.
- Validate and run compiled project releases with readable entry metadata and separate development/release state.

- Added submission lifecycle events and explicit retries to embedded Kanban Conversations, allowing business transcripts to show immediate feedback and merge authorized receipts.
- Public Kanban Conversation types support project-defined @ choices, dynamic UI updates, presentation slots and submission callbacks, allowing multi-participant topics to reuse the native composer.

- Group entry builds and static assets under each source root in dist/steamharness, alongside generated databases; reject entries that occupy generated code or another entry's build.

- Reject entry names and paths that collide with managed artifact directories or Windows device names, protecting generated databases, caches, and reports during builds.

- Rebuildable outputs use the aggregate root dist, with shared database outputs per source root. Standalone SDK history defaults to ~/.steamharness/runtime/<projectId>/<entryId>/ outside the project.

- [Fix] Preserve known public database error codes across node and Workflow reports so hosts can identify missing bindings, contention, and schema mismatches; omit custom codes on arbitrary exceptions.

- Fixed aggregate Workflow calls from Kanban using a separate 120-second Bridge deadline so database authorization and durable receipts can complete.

- Fixed: Suspending a durable Agent interrupts its enclosing project instead of reporting a partial reply as successful; reopening continues from the original checkpoint.

- Add aggregate Conversation entry control and trusted call provenance, preserving user, permissions, and cancellation; support durable receipts, snapshots, approvals, stop, and explicit recovery.

- Fix durable Agent trace timing: reasoning and text items retain the model request span, including time to first token, and tool items use persisted task spans across reopen.

- [Fixed] System AI catalogues use a 30-second, connection-scoped memory cache and shared refreshes. Explicit refresh remains available; expiring credentials refresh online and denied refreshes cannot reuse old tokens. Managed files use conditional requests, and knowledge attachments reuse bounded snapshots after online access checks.

- [Fixed] Runtime history and Agent checkpoints default to local SQLite, removing per-operation network waits from first response. Added `createLocalRuntimePersistence` and explicit background snapshot copying with `copyRuntimePersistence`, preserving opt-in Server storage and existing data.

- [Fixed] Relational transactions wait up to 30 seconds for a pooled connection instead of 5 seconds, and temporary SQL identities renew before expiry to avoid acquisition and commit authorization failures with remote databases. Sent transactions are never automatically replayed.

- [Fixed] Durable Agents retain only the latest complete session snapshot, coalesce pending views and serialize publication for slow consumers, preventing stale snapshots from exhausting memory during long multi-agent runs. Streaming nodes can customize in-memory collection with `accumulateChunk`; chunk hooks still receive every original event.

- [Added] Durable snapshots expose subagent execution spans and usage, plus conversation totals including owned subagents. Failed, stopped and hidden children retain their spend; retries, reopening and independent forks do not double-count it.

- Fixed independent conversation copies losing document version changes and replacement identities when their JSON content stayed equal, preserving checkpoints for later forks.

- Changed: remove KV, PersistentValue, local KV and legacy database-space APIs. Business data uses generated model descriptors, Browser clients use the host table proxy, and conversations and run records default to local SQLite with optional explicit Server storage.

- Added independent knowledgeBases APIs and account bindings. Relational platform tables retain documents, chunks and indexes; private file storage holds attachments, with revision conflicts and revocation-aware retained handles.

- Conversation state, usage and default Agent sessions persist locally. Added versioned session snapshots and fork/isolation/cancellation helpers. Explicit Server storage still aborts execution on lease loss, without automatic legacy KV/SQLite migration.

- Added typed relational queries, aggregation and transactions through `context.databases.connect(descriptor)` for Node entries, with per-operation binding/access/model checks, lease renewal and run cleanup.

- Added public database resource, account grant, migration plan and history types with a shared model engine version.

- Add SteamHarness Database definitions for single or multiple schemas, model metadata, and typed Node/Browser descriptors. Core supplies engine dependencies without application-authored PrismaClient imports.

- Added Agent storage through `steamharness/runtime-storage`, with account/workspace/session isolation in PostgreSQL, execution leases, idempotent commits and document checkpoints, also available to custom hosts.

- Added explicit `null` for unlimited total or per-role subagent concurrency, preserving default FIFO limits. Proven unsent tool failures can retry from business receipts; access denials, cancellation and unknown side effects remain retry barriers.

- Durable Agent turn snapshots now expose persisted execution timestamps so hosts can restore elapsed time when opening subagent conversations and history.

- Removed global and account memory, including tools, skills, authorization, service integration and settings controls.

- Fixed conversation branches to support independent root databases with truncated history and historical asOf document checkpoints. Execution identities are renewed without importing tasks, approvals, queues or usage; source cancellation and deletion do not affect the new conversation.
- Fixed durable conversations to fork committed history offline using the same atomic operation and deduplicated receipts as live sessions. Document inheritance policies are preserved without starting models, tools or pending tasks.

- Fixed generator boards to use the database API and temporary editing mode, prevent overwrites after failed reads, and check configuration and ignore-file conflicts before writing project files. Generator scaffolds also support names beginning with digits and multiline prompts.

- Fixed database attachment handles to reuse their downloaded snapshot instead of transferring the entire file again for its content. Every read still validates the current binding and knowledge grant.

- Fixed conversation cancellation to atomically stop and join the target execution tree, preventing coordinators from dispatching work between cancellations. Explicit host cancellation also stops background batches and owned tasks.

- Fixed: Existing Agent sessions discover and persist authorized catalog additions through tool search, so adding Studio diagnostics no longer invalidates the whole directory. Existing descriptions, parameters and replay policies stay pinned; incompatible changes and unauthorized tools remain rejected.

- Added project-defined subagent work attempt limits and backoff. Failed work continues in its original task and child conversation with committed checkpoints, verified completion receipts, non-retryable barriers, persistent budgets and cancellation. Only the final outcome returns to the parent.

- [Fixed] Return current work and delivery receipts when sending to queued, settling or settled subagents, without failing on normal lifecycle changes or restarting work. Concurrent role checks share in-flight lookups and retry transient network/service failures within the original deadline; explicit denials remain immediate.

- Added: Select one shared subagent model in project configuration or define it in code. Reuse configured models with inheritance, independent connections and credentials, capability clamping and system-AI authorization.

- Durable delegation tasks expose `childConversationId` for anonymous and named subagents while active, settled and reopened, allowing conversation and Trace views to open the corresponding child.

- Fixed: Apply up to 10 fallback retries to every model request error without classifying its text or status, including streams, durable sessions, deferred responses and summaries. Retain partial output, committed tool results and per-attempt usage; discard unfinished calls, keep queued inputs pending on failure, and honor cancellation immediately.

- Added: Add named agent roles, durable FIFO concurrency, shared management commands and checkpoint retries. Dynamic sessions and wrapped executors inherit durable control; recovery rechecks role access and retains business task history and progress.

- Fixed: Release losing task waits before rechecking multi-agent concurrency slots. Explicit management actions ignore model-filled legacy result fields so listing or inspecting work is not incorrectly rejected.

- [Fixed] Preserve the selected restricted configuration across temporary outages, role changes, and reopening. Guest fallback still enforces execution permissions, and an explicit Ask selection remains saved.

- [Changed] Agent models use separate settings and project modes: Studio hides project AI configuration, standalone CLI Web uses project models, and empty settings never fall back. Project models retain only System AI and Third-party AI sources.

- [Fixed] Core Agent projects and coreAgent wrappers inherit host recovery, reconnecting unfinished work with its original runId after a crash so later input is not blocked by stale busy state.

- Fixed: Retry transient request-construction, stream-iteration/result, summary and deferred-fetch exceptions, including nested transport codes and HTTP 408/409/5xx. Manual compaction uses bounded retries while retaining text, tool results and per-attempt summary usage; host storage and callback failures remain terminal.

- Fixed: Retry temporary upstream unavailability, in-stream upstream_error failures without an HTTP status, and connection failures such as ECONNRESET across ordinary requests, durable sessions and automatic compaction, preserving diagnostics, partial text and committed tool results within the existing retry budget.

- Renamed the development project generation skill to steamharness-generator and synchronized skill copies, validation and generator references.

- Added skills.directories to Core Agent nodes and projects so runtime tools and host previews share one declaration. Hosts can list project and Core built-in guides and read complete SKILL.md files by catalog ID without running tool factories or tasks.

- Fixed paged skill catalogs and file listings, byte-bounded JSON continuation with change detection for knowledge/KV and long child results, and bounded write acknowledgements. Fixed large-file tails and read-only environment long-line reads, silent search/list omissions, missing shell truncation and timeout diagnostics, commands starting after cancellation, failed children reported as completed, and UTF-8 MCP schema size checks.

- Fixed skill reads with JSON byte-bounded pages and offset/limit/nextOffset continuation, preventing durable output truncation. Subagents advertise only allowed exact model overrides and explain inheritance. File cards expose target fields, actionable errors and ignore inapplicable preview=false.

- Breaking: project identity, name, version and declarations now use independent `steamharness.json` files. Removed reads and writes of `package.json.id` and `steamHarness`. Aggregates explicitly register child entries whose configuration defines icons, declarations, database aliases and schedules. Unregistered configurations stay inactive, and transfers preserve the parent and child structure.

- Fixed Core Agent input to exclude disabled fields, enforce fixed user-setting bindings, preserve legacy model and mode flags, and keep message text out of parameter parsing. Static inheritance supports shorthand references and namespace imports; undefined field overrides retain existing defaults.

- Added: Native database host contexts manage retained local data independently of consumer grants; data operations distinguish null from missing entries and create keys transactionally.

- Added built-in assistant parameters for Core Agent projects, inherited automatically by defineExecutor with model resolution. Fields support overrides, visibility, disabling, fixed values and grouping; business workflows can select a coreAgent contract. The input helper accepts ExecutorContext, and static reports share the runtime contract.

- Allow up to 30 seconds for restricted project role checks so slow remote database access does not incorrectly downgrade developers or owners. Failed checks still revoke elevated access.

- Breaking: package entries now list database alias strings, with alias-to-ID mappings in root config.json. Core resolves aliases across multiple databases and shared consumers; hosts maintain permissions, distributions preserve ID references, and legacy fields are rejected.

- Default Conversation parameters now separate model and effort into independent Quick controls. User snapshots accept full host built-in catalogues while retaining the 100 custom-model limit and globally unique model IDs.

- Fixed automatic user model parameters to retain inheritance and direct calls to load explicitly selected project models. Connections and inherited permissions share one host snapshot, cached connections preserve developer model attributes and system search restrictions, and `inherit` remains a valid model ID.

- Added user model lists for connection-free Agent nodes and direct calls, explicit user/project sources, overridable model defaults, and enforced system AI authorization and source restrictions.
- Fixed concurrent database bindings overwriting other entry bindings or manifest fields. Database requests ignore forged approval metadata and binding references to protect other spaces and grants.

- Breaking: projects register entries/defaultEntry under one projectId, including multiple entries of the same type. Configuration and execution are isolated by entry; calls preserve identity and cancellation and recheck permissions.

- Parameter `userSetting` bindings support fixed user policies or user defaults with project overrides. Fixed controls show the actual policy and open user settings; editable controls retain the three original choices. Reset restores inheritance without persisting the displayed value as an override; active work keeps its snapshot.

- Added immutable, execution-scoped user settings through `getUserSettings`, `withUserSettings`, and host validation with `parseUserSettings`. Explicit `permissionPolicy: "inherit"` uses the user policy, falling back to `auto` without a host. Omitted policies still default to `workspace`; turn input takes precedence and tools share the resolved scope.

- Keep project deployment configuration in root config.json, centralizing database aliases and IDs; package entries declare only the aliases they use. STEAMHARNESS_PROJECT_CONFIG can override deployment values; migration updates one ID, permissions remain host-managed, and distributions retain authored values.
