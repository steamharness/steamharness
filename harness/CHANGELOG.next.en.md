# Unreleased

- Fixed: Re-enabling project memory skips turns completed while disabled. Static defaults resolve variables within their lexical scope so unrelated locals cannot accidentally enable memory.

- Added: Add named agent roles, durable FIFO concurrency, shared management commands and checkpoint retries. Dynamic sessions and wrapped executors inherit durable control; recovery rechecks role access and retains business task history and progress.

- Changed: Project memory defaults off and the built-in Assistant explicitly opts in. A project configuration switch controls authorization, recall, saving and tools without deleting existing memories.

- Fixed: Persistent assistant sessions submit automatic memory after each answer is saved without waiting for process exit. Follow-up turns recall fresh records; durable receipts and the offline outbox prevent duplicate delivery after recovery, and initial activation does not import older conversations.

- [Fixed] Preserve the selected restricted configuration across temporary outages, role changes, and reopening. Guest fallback still enforces execution permissions, and an explicit Ask selection remains saved.

- [Changed] Agent models use separate settings and project modes: Studio hides project AI configuration, standalone CLI Web uses project models, and empty settings never fall back. Project models retain only System AI and Third-party AI sources.

- [Fixed] Core Agent projects and coreAgent wrappers inherit host recovery, reconnecting unfinished work with its original runId after a crash so later input is not blocked by stale busy state.


- Fixed: Retry transient request-construction, stream-iteration/result, summary and deferred-fetch exceptions, including nested transport codes and HTTP 408/409/5xx. Manual compaction uses bounded retries while retaining text, tool results and per-attempt summary usage; host storage and callback failures remain terminal.

- Fixed: Retry temporary upstream unavailability, in-stream upstream_error failures without an HTTP status, and connection failures such as ECONNRESET across ordinary requests, durable sessions and automatic compaction, preserving diagnostics, partial text and committed tool results within the existing retry budget.

- Added: Add host-bound account memory providers, the native memory tool, the built-in steamharness-memory skill, and per-turn recall and durable submission.

- Renamed the development project generation skill to steamharness-generator and synchronized skill copies, validation and generator references.

- Added skills.directories to Core Agent nodes and projects so runtime tools and host previews share one declaration. Hosts can list project and Core built-in guides and read complete SKILL.md files by catalog ID without running tool factories or tasks.

- Fixed paged skill catalogs and file listings, byte-bounded JSON continuation with change detection for knowledge/KV/memory and long child results, and bounded write acknowledgements. Fixed large-file tails and read-only environment long-line reads, silent search/list omissions, missing shell truncation and timeout diagnostics, commands starting after cancellation, failed children reported as completed, and UTF-8 MCP schema size checks.

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
