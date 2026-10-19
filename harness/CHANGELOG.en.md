# Changelog

All notable public changes to this release unit are recorded here.

## 0.1.1 - 2026-07-29

### Changed

- Changed the Core version to become the sole basis for Workflow runtime compatibility, released independently.

## 0.1.2 - 2026-07-30

### Added

- Added Kanban static project types, artifact entrypoints, configuration validation, and structure reports, so dashboards are recognized without an executor or Node.js runtime.

## 0.1.3 - 2026-08-07

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

## 0.1.4 - 2026-08-24

### Breaking Changes

- Electron local runs now use the `desktop` platform, and `workflow.isDesktop()` replaces `workflow.isApp()`.
  Migration: pass `desktop` for local runs; the old `app` value is no longer accepted.

### Fixed

- Fixed the CLI usage shown when standalone structure inspection is missing a project path.
- Fixed runnable projects with a missing, dynamic, or legacy `projectType` config being blocked by static migration checks.

## 0.1.5 - 2026-08-26

### Fixed

- Fixed dated Alpha Core versions rejecting newer patches in the same minor line that the project's caret range allows.

## 0.2.0 - 2026-08-26

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

## 0.2.3 - 2026-09-01

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

## 0.2.4 - 2026-09-05

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
- Added the `createAgentConversationWorkflow(...)` and `createAgentProjectParams(...)` split form for projects that must pass structure validation.
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
- Added `workflow.createWorkflowCapabilityTools({ context })` rendering a capability as native agent tools.
- Added `workflow.createWorkflowCapabilityServer(toolId, { context })` rendering the same capability as an MCP server.
- Added `workflow.runWorkflowCapabilityAction(toolId, context, args)` running one action by tool id for approval resumes.
- Added `workflow.listWorkflowCapabilityToolIds({ globalMemory? })` listing what a run will offer.
- Added `workflow.isWorkflowCapabilityAvailable(toolId)` reporting whether a capability can serve in this process.
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
- Fixed `createAgentConversationWorkflow({ outputItemId })` deriving the answer item id from the session instead of the declared one.
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
