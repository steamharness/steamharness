# Unreleased

- [Added] Conversation collapseIntermediate presentation defaults; Agent executors enable folding of successful turns by default, with explicit opt-out and complete output preserved.

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

### Context compaction

- [Fixed] Check context before every model request in ordinary Agents and durable sessions, compacting at 90% by default across tool loops and custom windows. Recover from overflow with bounded retries and summarize oversized history in chunks while retaining tool call pairs, cancellation guarantees and complete usage.

### Skill tools

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

### Changes

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
