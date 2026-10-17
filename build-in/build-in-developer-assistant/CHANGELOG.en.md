# Changelog

All notable public changes of this release unit are recorded here.

## 0.1.0 - 2026-07-22

### New Features

- **Built-in developer assistant**: a built-in assistant for local projects, shipped with Desktop.

### Added

- Added the built-in developer assistant for local projects.

## 0.1.1 - 2026-07-30

### New Features

- **Kanban host configuration**: the assistant can update Kanban host configuration while reusing the OpenCode runtime.

### Added

- Added Kanban host configuration updates for the assistant, reusing the OpenCode runtime.

## 0.1.2 - 2026-08-21

### New Features

- **Multilingual built-in project**: shows as 小助手 in Chinese and `Project Assistant` in English, with the README following the interface language.
- **Generator project metadata reference**: the generator reference covers default names, localized names, manual declarations, and display platforms.

### Breaking Changes

- Built-in project compatibility now uses `minDesktopVersion`; `minAppVersion` is no longer accepted and Desktop 0.1.20 is the minimum.
  Migration: rename `minAppVersion` to `minDesktopVersion` in the project manifest and set 0.1.20 or later.

### Added

- Added multilingual declarations to the built-in project so its names and README follow the Desktop interface language.
- Added generator guidance for default names, localized names, manual declarations, and display platforms, leaving multilingual and multiplatform declarations unset for new projects.

### Removed

- Removed the `minAppVersion` field from built-in project manifests; compatibility reads `minDesktopVersion` only.

## 0.1.3 - 2026-08-24

### New Features

- **V2 workspace manifest**: Workflow projects and ordinary folders can both be the primary target, with linked folders authorized through typed roots.
- **Multi-project coordinated edits**: changes span the primary project and recursively linked projects, while unavailable branches only warn.

### Added

- Added the V2 workspace manifest with Workflow projects or ordinary folders as primary targets and typed linked roots.
- Added reading of Desktop-validated multi-project manifests to coordinate edits across primary and linked projects.
- Added continued reading of legacy V1 project manifests.

### Changed

- Changed multi-workspace authorization to require OpenCode 0.1.8 or later, which installing the assistant now enforces.

## 0.1.4 - 2026-08-26

### New Features

- **Exact Core/CLI pins**: the generator requires projects to pin component versions exactly, and the host compares only the Core `major.minor` line.
- **Explicit storage context**: projects must declare `dataStorage.mode`, and knowledge helpers run with an explicit storage context.

### Added

- Added atomic recording of each project's exact Core/CLI pins in release indexes and compatibility manifests for pre-download filtering and verification.

### Changed

- Changed the assistant to Core/CLI `0.2.0` with `dataStorage.mode: "both"`, passing storage context into OpenCode; Desktop `0.1.22` is the minimum host.
- Changed the generator to reach storage and knowledge through `context.storage.local.*` / `context.storage.server.*`.
- Changed the generator to stop emitting `context.kv` and `context.persistentValue` calls.

## 0.1.5 - 2026-09-01

### New Features

- **Desktop Control standard MCP**: the assistant permanently mounts that MCP to operate themes, language, updates, projects, and KV.
- **OpenAI Responses support**: reuses OpenCode's multi-turn text, images, model validation, and streaming output, emitted as `opencode-answer`.
- **OpenCode Permission quick parameter**: quick parameters switch between `read-only`, `workspace`, and the default `auto`.

### Breaking Changes

- The generator stops emitting global KV, `.workflow` storage scopes, and Kanban `dataSources` in favor of current-project, conversation, and related-project APIs.
  Migration: rewrite existing `context.kv`, `persistentValue`, and `dataSources` calls to the current-project, conversation, or `projectInfo.relatedProjects` APIs.
- Assistant workspace manifests accept only schema v2 and general related-resource types; legacy manifests and older Desktops without one are dropped.
  Migration: convert legacy project manifests to schema v2 and upgrade the host to a Desktop declaring `minDesktopVersion`.

### Added

- Added an OpenCode Permission quick parameter switching between `read-only`, `workspace`, and `auto`, forwarded to every run.
- Added OpenAI Responses support reusing multi-turn text, images, model validation, and streaming output into `opencode-answer`.
- Added a permanent Desktop Control MCP mount covering theme, language, launch at login, updates, local projects, project info, and KV.
- Added Dock opening tools for the Home, local project, or ordinary folder bound to the run, on the right or bottom.
- Added batch KV reads and writes of up to 100 project entries plus knowledge queries and mutations, returning per-item results.
- Added refreshing reasoning levels through the OpenCode resolver on model changes, with extra `max` / `ultra` levels for `gpt-5.6-*`.

### Changed

- Changed the minimum host to Desktop `0.1.23` now that the Desktop Control MCP is permanently mounted.
- Changed OpenAI reasoning levels to display as `Effort` in quick parameters and combine with the model in the composer summary.
- Changed the project manifest to adopt the general `projectInfo.relatedProjects` relationship contract.
- Changed OpenCode to reach Desktop Control only through the parent Workflow's controlled proxy, with consequential writes approved by default.

### Fixed

- Fixed continued editing and completion misreported from stale CLI results when a Skill or reference cannot be read completely.
- Fixed ordinary folders degraded by obsolete manifests or structural validation now being migrated in authorized stages.
- Fixed source migration, host recognition, code-root authorization, and KV authorization being reported as one completion state.

### Removed

- Removed global KV, `.workflow` storage scope, and Kanban `dataSources` output from the generator.
- Removed conversion of legacy project manifests and support for older Desktops without a manifest.

## 0.1.6 - 2026-09-13

### New Features

- **Dock tab management**: the assistant reads, refreshes, and closes Dock tabs, and runs the Run or side-project inside them.

### Added

- Added reading and managing existing Dock tabs, updating their content, closing them, and running Runs or side projects.
- Added known URL, file, run, conversation, data-source, and side-project context to the same Dock open call.

### Changed

- Changed the assistant to select arguments by every Desktop MCP action contract and reuse IDs returned by state reads.

### Fixed

- Fixed initial loading ignoring the AI configuration's default model, which an earlier automatic fallback could override.
- Fixed launching from the Home sidebar aborting on an invalid `primaryTarget.kind`; the Desktop Home workspace target is now accepted.
- Fixed cloning falling back to `import_project`; create, clone, import, and new-project requests are now routed by intent.
- Fixed local tool-approval resume not being deduplicated by project, run, and input request, so repeated clicks join the same execution.

## 0.1.7 - 2026-09-13

### New Features

- **Generator contract alignment**: the generator skill regains entrypoint groups, audio and video, the Conversation gateway, and eight `workflow.WorkflowError` types.
- **Scaffold release metadata**: generated `package.json` files carry `steamHarness.projectCard` and `steamHarness.release`.

### Added

- Added generator coverage of `entrypoint.group`, audio input, video attachments and output, and `context.hostInput` for Conversation.
- Added generator coverage of eight `workflow.WorkflowError` types and `createLLMNode`.
- Added generator coverage of `getLLMProvider` and `tokenUsage.getRunUsage()`.
- Added `steamHarness.projectCard` and `steamHarness.release` to generated manifests, defaulting per project type.

### Changed

- Changed the release gate to fail `workflow-generator-contract` when Core drifts from what the generator skill documents.
- Changed generator dependency resolution to identify the repository layout by package name and accept dated prereleases.

### Fixed

- Fixed the generator skill claiming `steamHarness.release` must stay out of source and describing removed Kanban `dataSources` as usable.
- Fixed artifacts filtering by file basename, so the skill's `scripts/create_workflow.py` now ships with the release.

## 0.1.8 - 2026-09-13

### Changed

- Changed the pre-release `workflow-generator-contract` check to scan for removed App identity markers and block failing skill text.

### Fixed

- Fixed the runtime platform note reproducing a removed App identity marker that failed Desktop's identity check after syncing.

## 0.1.9 - 2026-09-15

### Changed

- Changed the minimum OpenCode dependency to `0.1.10` so the AI configuration default model fix ships with installs.

### Fixed

- Fixed installs of the assistant missing the AI configuration default model because the OpenCode dependency floor was too low.
