# Changelog

All notable public changes to this release unit are recorded here.

> SteamHarness packages use an independent version line from 0.1.0. Entries marked Legacy belong to the earlier release line and remain for reference.

## Legacy 0.1.1 - 2026-07-29

### Changed

- Changed the Core version to become the sole basis for Workflow runtime compatibility, released independently.

## Legacy 0.1.2 - 2026-07-30

### Added

- Added Kanban static project types, artifact entrypoints, configuration validation, and structure reports, so dashboards are recognized without an executor or Node.js runtime.

## Legacy 0.1.3 - 2026-08-07

### New Features

- **Multi-entrypoint execution**: `defineEntrypoint()` declares independent entrypoints, and contexts, reports, and Structure results carry the actual ID and title.
- **Bilingual runtime output**: `workflow.getRuntimeLocale()` reads the run language, and runtime errors are produced in Simplified Chinese or English with stable fallbacks.
- **Schedule suggestions**: `schedulePresets` declares a time zone, time window, or five-field Cron per entrypoint; Structure validates them but hosts do not enable them.

### Breaking Changes

- Workflow executors no longer accept top-level execution fields such as `workflow`, `params`, or `createInput`.
  Migration: move execution fields into a non-empty `entrypoints` and set a valid `defaultEntrypoint`; Conversation executors stay single-entrypoint.

### Added

- Added `workflow.getRuntimeLocale()` and bilingual runtime errors, with stable fallbacks for a missing locale or translation.
- Added `defineEntrypoint()` for independent entrypoints, whose ID and title travel through runtime contexts, reports, and Structure results.
- Added read-only `workflow-kv` data sources scoped to a project UUID and key prefix, safely re-read through revision subscriptions after the source updates.
- Added schedule suggestions in `package.json.steamHarness.schedulePresets`, covering entrypoint, IANA time zone, time window, and five-field Cron.
- Added Kanban version-level dependency locks and the project-group v1 protocol, separating bundled source from external references without transferring host data.

### Changed

- Changed Structure to resolve cross-file entrypoints from real import and export bindings and to isolate same-named registries per entrypoint.
- Changed Core release notes to be maintained in Chinese and English, with locale-selectable Markdown bodies in the release metadata.

## Legacy 0.1.4 - 2026-08-24

### Breaking Changes

- Electron local runs now use the `desktop` platform, and `workflow.isDesktop()` replaces `workflow.isApp()`.
  Migration: pass `desktop` for local runs; the old `app` value is no longer accepted.

### Fixed

- Fixed the CLI usage shown when standalone structure inspection is missing a project path.
- Fixed runnable projects with a missing, dynamic, or legacy `projectType` config being blocked by static migration checks.

## Legacy 0.1.5 - 2026-08-26

### Fixed

- Fixed dated Alpha Core versions rejecting newer patches in the same minor line that the project's caret range allows.

## Legacy 0.2.0 - 2026-08-26

### Breaking Changes

- Projects must declare `steamHarness.projectInfo.dataStorage.mode`, which constrains where KV, PersistentValue, and knowledge may live.
  Migration: add `dataStorage.mode`; the `server` location requires sign-in and a same-UUID project binding.
- Removed `context.kv` and `context.persistentValue` in favor of `context.storage.<location>.*`.
  Migration: rewrite local access as `context.storage.local.*` and server access as `context.storage.server.*`; the old properties only throw a migration error at runtime.
- Knowledge helpers now require an explicit storage-location context instead of implicitly reusing the current domain.
  Migration: pass `context` or the target storage location explicitly when calling a knowledge helper.

### Changed

- Changed projects to require an exact SemVer in `devDependencies.steamharness`, with hosts comparing only the `major.minor` line.
- Changed any patch or dated Alpha on that line to run directly, while a major or minor change requires a host upgrade before user modules load.

## Legacy 0.2.3 - 2026-09-01

### New Features

- **Related project grants**: `projectInfo.relatedProjects` declares related projects and their manifests, enforced against both sides' current declarations on every call.
- **OpenAI host adapter**: a `conversation.openai` adapter takes typed input through a separate `hostInput`, and AI SDK streams keep the finish reason, usage, and metadata.

### Breaking Changes

- Removed global KV, `kv.workflow`, and `persistentValue.workflow`; legacy scopes are not migrated automatically.
  Migration: `kv.*` and `persistentValue.*` now address the current UUID project directly and keep only the `.conversation` child scope.
- Kanban no longer accepts `dataSources` declarations, and the original bridge is gone.
  Migration: rewrite `dataSources` as `projectInfo.relatedProjects` and reach KV through `relatedProjects.get(alias).kv`.

### Added

- Added `projectInfo.relatedProjects` for declaring related projects and their grants, checked per call against both current declarations.
- Added `context.storage.<location>.relatedProjects.get(alias).kv` for related-project KV, strictly isolating local and server locations.
- Added a `conversation.openai` adapter for Conversation executors, receiving typed OpenAI Responses input through the separate `hostInput` channel.
- Added `system` / `developer` message roles and the `verbosity` response-detail setting to OpenAI Responses `hostInput`.

### Changed

- Changed AI SDK streams to preserve the complete finish reason, usage, errors, and provider metadata.
- Changed AI SDK providers to stop promoting SDK `unsupported` / `compatibility` warnings into run failures.
- Changed downgrade details to remain in `providerMetadata["steamharness"].warnings`, while real call errors still fail.
- Changed KV and PersistentValue to use separate storage domains, with knowledge on project PersistentValue and token totals kept per project and conversation only.
- Changed the generator scaffold to emit an empty `projectInfo.relatedProjects` explicitly, with the API reference following the project and conversation token-accounting contract.
- Changed the local and server data-hierarchy examples to expose separate `store` and `get` entrypoints, where `store` returns a random UUID and `get` needs only that id.

### Removed

- Removed the Kanban `dataSources` bridge in favor of general related-project KV.

## Legacy 0.2.4 - 2026-09-05

### New Features

- **Agent capability layer**: built on the pi agent SDK, adding `workflow.createAgent(...)`, `createAgentNode(...)`, and a conversation executor.
- **Cross-turn conversation recovery**: the pi `AgentMessage[]` is stored under `agent.transcript.<sessionKey>` and seeded back into `initialState.messages` on the next turn.
- **Related project knowledge and entrypoint calls**: `relatedProjects.get(alias)` opens the target's knowledge base and entrypoints, authorized per key.

### Added

- Added `contentType: "video"` to the output protocol, preserving video descriptors and streamed output-item types.
- Added `workflow.createAgent(...)`, a programmatically driven agent runtime.
- Added `workflow.createAgentNode(...)`, an agent node for any workflow.
- Added `workflow.defineAgentConversationExecutor(...)`, which produces a complete conversation executor in one call.
- Added conversation configuration, token usage, tools, params, and OpenAI gateway wiring inside that executor.
- Added the `createAgentConversationProject(...)` and `createAgentProjectParams(...)` split form for projects that must pass structure validation.
- Added `workflow.createAgentProjectParamResolver()` for taking model options from `workflow.getServerLLMCredentials(...)`.
- Added agents reaching the host's system AI by default, opening a loopback bridge per run through `startLLMProxyBridge()` and holding no upstream key.
- Added agent input fields `prompt`, `images`, `workdir`, `provider`, `model`, and `baseUrl`.
- Added agent input fields `effort`, `agent`, `permissionPolicy`, `contextWindow`, `compact`, and the approval resume payloads.
- Added `effort` levels from `off` to `max`, with `ultra` meaning `max`, converging to what the model supports.
- Added `agent` as `build` or `plan`, where a plan turn's text renders as a single Plan row and asks for approval at the end of the turn.
- Added plan approval reusing the `decision` radio plus optional `instructions`, continuing in the same session as a build agent once approved.
- Added `permissionPolicy` as `read-only`, `workspace`, or `auto`, none of which prompts for a built-in tool.
- Added a neutral `metadata.kind` family for output items: `agent-part`, `agent-notice`, `agent-error`, and `agent-answer`.
- Added `contextUsage: { used, total }` to the output payload, which hosts render as the composer's used and total row plus a compaction entry point.
- Added `--context-window` to override the context-usage denominator.
- Added tool approval through `context.toolPermissions` and plan approval through `context.userInput`.
- Added token usage reported once through `context.tokenUsage.report(...)`, with nothing left for the project to implement.
- Added the `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` dependencies, shipped with the host's `steamharness` install.
- Added `AgentNodeOptions.createTools` returning `{ tools, close?() }`, where `close` runs when the turn ends.
- Added `AgentNodeOptions.createTools(context)` assembling tools beyond the seven built-ins, with programmatic runtimes using `AgentRuntimeOptions.extraTools`.
- Added `AgentInput.systemPrompt` supplying the system prompt per run and `AgentInput.images` traveling to the model with the prompt.
- Added `workflow.connectMcpServer(...)` to start and handshake a stdio MCP server and list the tools it exposes.
- Added `workflow.createMcpTools(...)` turning MCP tools into agent tools, keeping the `<serverId>_<toolName>` names.
- Added `workflow.normalizeMcpServers(...)` validating server definitions before anything is spawned.
- Added capability-bearing variables inheritable only by name, with `allowedInheritedEnvKeys` listing them and `inheritEnvironment` requesting them.
- Added `workflow.createProjectCapabilityTools({ context })` rendering a capability as native agent tools.
- Added `workflow.createProjectCapabilityServer(toolId, { context })` rendering the same capability as an MCP server.
- Added `workflow.runProjectCapabilityAction(toolId, context, args)` running one action by tool id for approval resumes.
- Added `workflow.listProjectCapabilityToolIds({ globalMemory? })` listing what a run will offer.
- Added `workflow.isProjectCapabilityAvailable(toolId)` reporting whether a capability can serve in this process.
- Added four built-in workflow capability tools — knowledge documents, KV, cross-session memory, and host configuration — keeping the tool ids of the built-in OpenCode project.
- Added `workflow.createSkillTools({ directories, approve? })` offering skills as a tool the model reads on demand.
- Added `workflow.runSkillAction(directories, args)` rerunning the same action by name for an approval resume.
- Added `deleteValue(key)` to the KV and PersistentValue namespaces, reporting whether an existing entry was actually removed.
- Added the `ask_user` built-in tool for plan-mode agents, letting the model ask mid-turn with choices, multi-select, and free text.
- Added `step` on a parameter definition, splitting a multi-question request into steps that keep one question's fields together.
- Added knowledge helpers on `relatedProjects.get(alias)`, reading and writing the target project's documents.
- Added `listEntrypoints()` and `runEntrypoint(id, args)` to list and invoke the target project's granted entrypoints.
- Added the `knowledge: { read, write }` and `entrypoints` grant fields, where declaring neither grants neither.
- Added system-AI model attributes returned by `getServerLLMCredentials()`, driving the context window, effort levels, and modalities.
- Added `modelAttributes` letting a custom provider declare `contextWindow`, `maxTokens`, `cost`, and `thinkingLevelMap`.
- Added static `group: { id, title, order? }` display metadata on Workflow entrypoints, preserved in structure reports.
- Added `ServerLLMCredential.defaultModelId` exposing the Server's resolved system/user default model.
- Added `type: "file", control: "audio"` to parameter contracts, with duration and byte limits.
- Added video attachments and common video MIME inference to the Conversation default input contract.

### Changed

- Changed an agent conversation to write its text where it was spoken, each run of text becoming its own `agent-part` row.
- Changed host-driven runs to stay unchanged, with the `conversation.openai.outputItemId` item produced only in them.
- Changed a turn's output items to order by where each one finished, putting tools and reasoning first and the answer where it was written.
- Changed tool approval to pause a run only in plan mode, since a build turn executes an already approved plan without asking again.
- Changed run report errors to carry an excerpt of the upstream HTTP response body, so a status phrase no longer hides the real reason.

### Fixed

- Fixed the agent conversation context having never been implemented: every user message was a new process and the model only saw that one sentence.
- Fixed a restored transcript past the model window failing the whole request, by compacting on demand before the model is called.
- Fixed cancelled or interrupted turns leaving unanswered tool calls that providers refuse, trimming the unsettled tail before it is stored.
- Fixed a failed read or write of `agent.transcript.<sessionKey>` failing the whole turn, now reported as a row instead.
- Fixed the OpenAI / Responses adapter for agent projects always ending with "did not produce output item".
- Fixed `createAgentConversationProject({ outputItemId })` deriving the answer item id from the session instead of the declared one.
- Fixed a symlink inside the workspace letting `read`, `write`, `edit`, `grep`, and `find` reach outside it.
- Fixed a `bash` timeout or abort ending only the shell, now ending the whole process tree it started.
- Fixed cancelling a run not really stopping the turn, with `context.abortSignal` now calling pi's `agent.abort()`.
- Fixed `read` loading a whole file into memory, now streaming the requested line range past 8 MiB.
- Fixed `edit` expanding `$&` and `$'` as replacement patterns, now replacing literally.
- Fixed the compaction split point able to hand the whole transcript, current task included, to the summarizer.
- Fixed `/compact` flashing a compaction row when there was nothing to compact.
- Fixed an empty `effort` string being treated as a level, which left `reasoningEffort` unset on OpenAI-style endpoints.
- Fixed context usage estimated at one token per four characters, which undercounted Chinese by about three times.
- Fixed `kv_store` writing the runtime's own `tokenUsage.*`, `conversation.state`, and `agent.*` keys.
- Fixed the declared capability length limits (knowledge and memory `markdown`, `title`, `query`, `cursor`, KV `key`) not being enforced in the implementation.
- Fixed the memory `cursor` meaning different things to `list` and `search` without returned values carrying a `list:` / `search:` prefix.
- Fixed an unusable host bridge URL throwing through the other capabilities, with `isAvailable` now returning `false`.
- Fixed a server-published MCP tool schema that was not an object, too deep, or over 256 KiB taking the process down at registration.
- Fixed the MCP per-server tool cap being checked after a page is merged instead of before.
- Fixed cleanup of the system-AI bridge and caller-supplied tools replacing a `user_input_required` outcome with a failure when it threw.
- Fixed MCP tool listing paging forever against a server that repeats its cursor, now reporting an error instead.
- Fixed host configuration `values` losing its key and value checks, so out-of-range arguments travelled to the host bridge.
- Fixed a skill file listing cut short by the 60-path cap reading as the whole of it.
- Fixed a node's `workdir`, `provider`, `model`, `effort`, and `agent` coming from the runtime options rather than the run's own input.
- Fixed `createAgentInputFromArgs` folding an unrecognised `--flag` and its value into the prompt.
- Fixed a turn that only called tools appending an empty assistant message to the conversation.
- Fixed a run carrying `hostInput` writing the workflow conversation, leaving the host's own record written twice.
- Fixed custom endpoints registering into the process-wide model catalog, where two runs under one id overwrote each other.
- Fixed built-in projects never receiving the Server-configured default model because catalog validation dropped `defaultModelId`.
- Fixed `defaultModelId` validation being case-sensitive and silently losing the configured default over a case difference.
- Fixed `AgentInput.workdir` only affecting the output payload while the built-in tools stayed inside the runtime's workdir.
- Fixed image attachments disappearing before the model, with the host's `imageFiles` now read into base64.
- Fixed an image-only turn ending with `Prompt is required.`.
- Fixed `--images` being swallowed for `defineAgentConversationExecutor` / `createAgentProjectInput` projects.
- Fixed agent model calls carrying no retry budget, so the first 502 or mid-stream drop ended the whole run.
- Fixed a model stream cut off mid-answer failing the turn on `terminated`, now continuing and keeping what was produced.
- Fixed a turn cut off by the model's output limit being finalized as a finished answer, now continuing on a separate 2-attempt budget.
- Fixed a message announcing a tool call but carrying none being finalized as a successful text-only answer.
- Fixed a model stream ending without a verdict leaving the turn hanging forever, now synthesized into a recoverable error.
- Fixed reasoning buffered until the turn ended, leaving high-effort models with nothing to show while they thought.
- Fixed related project knowledge writes bypassing the per-key grant on the mutation route, where the index and documents were written directly.
- Fixed `readEntrypointOutput(...)` returning a failed entrypoint's result as a payload.
- Fixed an unreachable related project knowledge base reporting only "relation unconfirmed" instead of the missing persistent-value handle.

## 0.1.1 - 2026-10-18

### Changed

- Republished under the SteamHarness package names, with an independent version line starting at `steamharness@0.1.0` that is incompatible with the earlier release line.
- Publishing now uses GitHub Releases and npm Trusted Publishing (OIDC), without long-lived tokens.
- Runtime dependencies use the peer range `^0.1.0` to state compatibility during installation.

## 0.1.2 - 2026-10-27

- Fixed runtime reports to retain structured failures in `error`; remote storage failures carry Server, project and related alias context so hosts can guide explicit Server accesses from `both` projects without treating model errors as missing projects.

- Fixed durable Agent SQLite creation, reopening, backup and import in deeply nested Windows data directories, avoiding database and owner lock failures caused by long paths.

- Fixed explicit and restored configuration snapshots to enforce source system-only AI restrictions and published field locks. Waiting runs retain their verified template and values while restores and tool calls still enforce the current role and fixed mode.

- Added source-owned profile role policies and fixed assignments. Restricted local values are scoped by application, Server and account; execution, restores and tool calls recheck authority, with guest-only access offline.

- Improvement: Share local project profiles, custom fields, values and active selection by application UUID across windows and installation directories. Adopt existing values on first use and keep run recovery snapshots scoped to their original directory.

- Fixed system-only source restrictions being overwritten by older templates. Distribution retains policy independently of hidden fields, and historical third-party drafts are validated after publication filtering.

- Added source-declared allowThirdParty: false for AI model fields. Freeze system-only restrictions per run, reject third-party models and direct endpoint overrides, and retain existing values for cleanup.

- [Added] Code-configured Conversation collapseIntermediate presentation defaults; Agent executors enable folding of completed turns by default, keeping the final reply on success or the error on failure, with explicit opt-out and complete output preserved.

- Fixed live local configuration discovery after Agent source changes without reopening the panel; unchanged sources reuse static analysis results.

- Added configured Agent model lists for system subscriptions and third-party APIs. Composers select saved models, execution freezes configuration and validates subscription access, and third-party connections work without system AI sign-in.

- Improved Agent retry outputs with continuation kinds. Host recovery uses `recovery` for silent continuation while connection retries and final failures remain visible.

- Fixed durable Agent suspension on host disconnect while retaining checkpoints. Unexpected provider aborts and interrupted streams use transport retries; follow-up turns and exhausted continuations preserve their failure details.

- Fixed busy admission rejection poisoning durable Agent failures or aborting existing work. Hosts can reconnect with `{ resume: true }` to restore controls and scheduling without resubmitting the initial message.

- Fixed inherited child locks under filtered JSON parents. Unverified source upgrades block configuration reads and writes while preserving personal values and waiting-run snapshots.

- Added versioned configuration sharing, field and JSON Pointer permissions, verified offline template and attachment caches, and allowed personal overlays while preserving run snapshots and upgrade drafts.

- Fixed: project configuration file fields choose and upload files to Server storage, then save references. Type restrictions, replacement and clearing preserve the previous value when uploads fail.

- [Fixed] Retain saved values and shadowed custom definitions across schema changes, persist explicit SDK snapshots per run with durable configuration generations, and exclude prototype members from configuration lookup and required-field checks.

- [Changed] Replace business env with `configuration.json` declarations and project configurations: add run-scoped `context.config`, `getConfig`, local storage and recovery snapshots, custom fields, named profiles, revision checks and complete import/export. Existing env and Kanban profiles are not migrated; host transport variables remain.

- Agents enable native OpenAI / Anthropic web search when the model declares support, with per-run controls, search activities and source links, persisted citations and follow-up context, bounded pause continuations, interruption recovery, and isolated child conversations.

### Changed

- [Fixed] Check context before every model request in ordinary Agents and durable sessions, compacting at 90% by default across tool loops and custom windows. Recover from overflow with bounded retries and summarize oversized history in chunks while retaining tool call pairs, cancellation guarantees and complete usage.

### Changed

- Added the built-in `i-have-adhd` communication skill to Core Agent system prompts, including build mode, plan mode and custom personas. The complete guide and MIT license ship with the package; user language, formatting requests and requests to stop the style take precedence.

- Clarify the `skill` display name, purpose and arguments, including discovery, entry and reference reads, result fields and truncation limits.

### Pi Durable

- [Fixed] Reset retry and continuation budgets after a complete successful model response so later failures restart at Retry 1 / 10. Consecutive failures, interrupted streams and process recovery retain their current budget; retry records with repeated numbers remain separate and preserve their history positions.

- [Fixed] Emit automatic retry records after interrupted content and before its continuation instead of appending them at completion. Durable sessions and reopened history retain their position and collapsed details.

- [Fixed] Project durable model usage per answer turn without mixing independent forks, inherited history or follow-ups, while retaining failed retries and in-turn compaction consumption. Publish current context occupancy per conversation through follow-ups, streaming, compaction and reset; uncalibrated estimates include actual system instructions, prompt sections and tool declarations.

- Fix durable streaming of thinking, text and tool block starts and deltas, preventing sparse content indices, type access failures and repeated text. Runtime exceptions settle unfinished tasks and queues under the same owner, persist the failure and publish current terminal state, so reopening cannot continue failed work. Normal host shutdown still preserves recovery checkpoints.

- [Fixed] Settled durable tasks no longer project a retained abort request as stopping. Completed cancellation and reopened history expose the actual terminal outcome.
- [Added] Atomically promote a queued durable input into the current turn while retaining its request identity, images and receipt. Inputs already consumed are never sent again.

- [Fixed] Scope tool output identities to committed assistant messages so reused call IDs across turns do not suppress events or misidentify historical tools. Bind approvals to durable tasks so later calls cannot reuse a previous decision in ordinary Agent mode. Task snapshots retain submitted arguments for inspecting nested calls.
- [Fixed] Capture durable session commands as JSON before queuing and reject invalid task input before reserving its request identity. Check persisted definitions for predeclared catalogs on reopen, and protect both SQLite backup paths with owner locks to prevent definition drift and destination creation races.
- Added durable Agent registries/hooks, custom tasks and timer checkpoints, authorized tool discovery and deferred MCP. Opt-in QuickJS Code Mode and remote ExecutionEnv retain approval, cancellation and replay checks for nested calls. Add resource diagnostics, custom storage and offline SQLite import/export, with self-contained public extension types.
- Added durable Agent session controls: Harness inbox, steer/withdraw, background compaction, context reset/handoff, independent forks, versioned configuration, and transactional plans. Public snapshots and host leases retain tools and the AI bridge after foreground completion.
- Added project-enabled restricted subagents, durable single-result reporting, and nested tool calls with tool/model allowlists, concurrency limits, caller/approval checks, scoped cancellation, and separate parent/child task and usage projections.
- Fix lost tasks after approval pauses in memory agents and initial transcripts overwriting durable history. After a process interruption during streaming, continue from committed text and discard incomplete tool calls.
- Serialize stale local KV lock recovery after a crash so concurrent reclaimers cannot delete a new owner's lock or break mutual exclusion.
- Upgrade Agent to Pi / Pi Durable 1.2.0 with Harness and SQLite as the sole durable execution backend. Add request deduplication, tool and approval recovery across processes, idempotent usage projections and durable cancellation. Old KV transcripts are no longer read; interrupted writes and commands with unknown results are not automatically replayed.

### Changed

- Remove the Server execution platform and isWeb while retaining local execution and explicit Server data access.
- Clarify in file storage errors and generator guidance that local hosts execute projects and Server stores projects and data.

### New Features

- **Standard Conversation composer**: always uses the standard message input, with attachment capabilities moving to `conversation.attachments`.
- **Conversation resource cards**: agents create, update, pin, or remove cards by stable `cardId`, and browser cards accept `preview` to control the preview area.
- **Agent context ring**: occupancy appears before the first model response and updates during streaming, tool results, and compaction.

### Breaking Changes

- **Product rename**: the SDK global `workflow` is now `steamharness`; `defineWorkflow`, `runWorkflow`, `defineWorkflowExecutor` and `defineWorkflowEntrypoint` are now `defineProject`, `runProject`, `defineProjectExecutor` and `defineProjectEntrypoint`, and the remaining `Workflow*` exports were renamed with them.
- **Field rename**: `workflowId` / `workflowName` are now `projectId` / `projectName`; `WorkflowError` is now `HarnessError`, the `workflow_execution` error type is now `execution`, and the `workflow` metadata key is now `project`.
- Conversation removes its enable setting and custom main fields, and legacy configurations now fail structure validation.
  Migration: declare attachments as `conversation.attachments` and keep parameters in Auxiliary / Quick / Mode / Slash only.
- Executor `params` become ordered action declarations, and the legacy `panel` declaration is no longer accepted.
  Migration: let Auxiliary and Quick define several groups each, declare Conversation Mode explicitly, and keep the display order through `paramLayout.actions` in structure reports.

### Added

- Added a generic `userInput` configuration that hides the composer while awaiting an answer by default, with an explicit override.
- Added `userInput` parameter-effect rules matched by request type, node name, and submitted values, applied after runtime confirmation.
- Added general Conversation execution commands that run project actions or export sessions, with validation for command collisions and static declarations.
- Added selector and boolean toggle controls in the Conversation `/` menu.
- Added plain text, parameter values, and conditional notices below the Conversation composer, with shared declarations for validation and resolution.
- Added Codicon icons on Quick parameters, preserved in structure reports. Default Agent AI and permission menus use sparkle and shield icons.
- Added a top-level `preview` switch on `workflow-ui_present_card`, separate from temporary Kanban parameter preview mode.
- Added the Agent context ring before the first model response, updating during streaming, tool results, and compaction.
- Added `getContextUsage()` / `updateContextUsage()` to query and update context occupancy, discarding obsolete counts after compaction and restoration.
- Added generic ring presentation through `display` on output items, plus pinning to the right of the composer.
- Added Core Agent context occupancy emitted through standard streaming output items, saved and restored per conversation while answers stay inline.
- Added `steamharness-kanban_kanban_methods` shared by agents and MCP, discovering and invoking methods on explicit Desktop Kanban preview instances.
- Added structured JSON results and cancellation to `steamharness-kanban_kanban_methods`, keeping configurations isolated and avoiding repeated view changes after timeouts.
- Added a `preview` parameter on browser resource cards controlling the Desktop preview area.
- Added `workflow-ui_present_card` for agents to upsert, pin, or remove Conversation resource cards by stable `cardId`.

### Changed

- Changed Kanban generator guidance to cover adjustable previews and the presentation API. Map, image, and explicitly read-only cards hide editing controls and block changes.
- Changed Kanban generator guidance to require responsive full-screen, phone, tablet, and Conversation small-card layouts based on the actual iframe dimensions.
- Changed Executor `params` to expose flattened `params` plus `paramLayout.actions`, preserving field ownership and display order.
- Changed Conversation Mode actions to be explicit and repeatable rather than inferred from a parameter name; a Mode without an explicit default uses its first option.

### Fixed

- Fixed explicit context summarization processing existing context immediately and showing running and completed or failed states.
- Fixed only complete, normally ended summaries replacing the transcript; provider failures, truncated responses, and cancellation retain the original.
- Fixed context summaries leaving consumed tokens unreported on failed or cancelled responses.
- Fixed the public compaction helper exposing model usage through an optional `onUsage` callback.
- Fixed agents reporting billed usage incrementally per model response during tool loops without double counting.
- Fixed programmatic agents loading `extraTools`, and ending stream consumption aborting the model and settling usage reporting.
- Fixed context ring output IDs colliding for Agent session keys containing spaces or non-ASCII characters, while existing ASCII IDs stay stable.
- Fixed Conversation Kanban resource cards accepting an exact named configuration ID, so previewing requires no workspace selection change.
- Fixed Remote file storage reading uploaded Server files with authentication through the fixed managed endpoint, avoiding relative-URL failures and credential exposure.
- Fixed every revised plan reusing a previous decline instead of requesting a fresh approval, including revisions with unchanged text.
- Fixed resumed output using shared identifiers, preserving earlier plans, related output, and answer order.
- Fixed Plan-mode questions from `ask_user`, research introductions, and text left by interrupted turns being folded into the plan output.
- Fixed only completed plans producing Plan cards and requesting approval, with conversation history retaining introductions and the final plan.
- Fixed card removal accepting more than `cardId`, and preview switches being silently ignored on cards that do not support them.
- Fixed agent tool results dropping their call arguments, so Conversation resource cards and other tool views lost their target information.

### Removed

- Removed the Conversation input enable setting and its custom main field declarations.
- Removed the legacy `panel` declaration from Executor `params`.

## 0.2.0 - 2026-11-18

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

- Changed local loading to accept missing or non-UUID IDs and derive a stable identity from the canonical directory without editing source.
- Changed only local loading; releases and distribution still validate the authored UUID.

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
