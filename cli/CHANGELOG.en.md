# Changelog

All notable public changes of this release unit are recorded here.

## 0.1.1 - 2026-07-29

### Changed

- Changed the CLI to an independent version and tag, declaring its compatible Core range through a peer dependency.

## 0.1.2 - 2026-07-30

### Breaking Changes

- Project packaging reads only the root `.workflowignore`; other ignore files no longer apply.
  Migration: explicitly exclude credentials, dependency directories, and temporary files in `.workflowignore`.

### Added

- Added static Kanban project support to `workspace pack`, `upload`, `publish`, and `download`, preserving binary assets.

## 0.1.3 - 2026-08-07

### New Features

- **Global `--locale` switch**: changes local and Workspace output and propagates to Server and the Workflow runtime.
- **`--entrypoint` argument**: local and remote commands can pick an entrypoint and fall back to the default. See [CLI](../docs/cli/steamharness.mdx).

### Breaking Changes

- Project-group packaging and downloads exclude PersistentValue data and CLI credentials and verify every package with SHA-256.
  Migration: self-references, lock mismatches, and modified responses are rejected, so regenerate dependency locks.

### Added

- Added a global `--locale <zh-CN|en>` switch, with projects reading it through `workflow.getRuntimeLocale()`.
- Added `--entrypoint <id>` to local `run`, `json`, `resolve-params` and remote `run`, `debug-node`.
- Added `structure` validating and reporting schedule suggestions by entrypoint, time zone, window, or Cron.
- Added Workspace commands delivering and restoring Kanban project groups by exact dependency lock, without host data.

### Changed

- Changed release notes to be maintained in Chinese and English, with Docs showing the matching version per language.

## 0.1.4 - 2026-08-24

### New Features

- **Platform-aware downloads**: `workspace download` sends the current platform and resolves `latest` to that system's newest compatible version.
- **Per-version release targets**: `workspace upload/publish` select a Server runtime and Desktop download target per immutable version.

### Breaking Changes

- The Desktop local runtime event variable is now `STEAMHARNESS_DESKTOP_RUNTIME_EVENTS`.
  Migration: the former `STEAMHARNESS_APP_RUNTIME_EVENTS` variable is no longer accepted.

## 0.1.5 - 2026-08-26

### Fixed

- Fixed dated Alpha Core versions accepting newer patches in the same minor line when they satisfy the project's caret range.

## 0.2.0 - 2026-08-26

### Breaking Changes

- The CLI is now 0.2.0 and pins Core 0.2 exactly, validating both exact declarations before execution.
  Migration: only the same `major.minor` line is accepted, and every patch on that line runs directly.
- Local execution passes explicit storage contexts from the project's `dataStorage.mode`.
  Migration: missing declarations and forbidden cross-location access now fail immediately.

## 0.2.3 - 2026-09-01

### New Features

- **Local MCP endpoint**: `steamharness mcp <workflow-dir>` exposes every entrypoint as a standard stdio MCP tool.
- **Related project access**: `--related-project` explicitly enables mutually confirmed related-project KV access.
- **MCP lifecycle reporting**: hosted by the headless Desktop launcher, the CLI reports complete snapshots over dedicated IPC. See [CLI](../docs/cli/steamharness.mdx).

### Breaking Changes

- The `--grant-data-access` and Kanban `dataSources` grant flows are removed.
  Migration: project-group dependencies now come from mutually confirmed `steamHarness.projectInfo.relatedProjects`.
- `workspace upload --create` requires a predeclared top-level UUID and `dataStorage.mode`.
  Migration: Server no longer assigns or writes back project IDs.

### Added

- Added `steamharness mcp <workflow-dir>`, exposing every entrypoint as a standard stdio MCP tool.
- Added a repeatable `--related-project <alias>=<absolute-project-dir>` option for local runs.

### Changed

- Changed local `kv.*` and `persistentValue.*` to bind directly to the current project instead of a global scope.
- Changed headless Desktop-hosted MCP runs to report full lifecycle snapshots for one runId over dedicated IPC.
- Changed stdio stdout to carry only JSON-RPC, keeping input, args, report, stdout, and stderr in the snapshot.

### Fixed

- Fixed MCP form elicitation terminating the waiting run and recording a diagnostic on invalid or failed responses.
- Fixed the OpenAI Responses internal runner no longer writing AI SDK compatibility warnings to `stderr`.
- Fixed `steamharness structure` validating the complete `projectInfo` contract before analysis, exiting `1` on unsupported fields.

## 0.2.4 - 2026-09-05

### New Features

- **Related project knowledge and entrypoints**: `--related-project` now reads a target's knowledge base and calls its granted entrypoints.
- **Symlinked invocation fixed**: `steamharness structure .` no longer prints nothing and exits 0 as a false pass under pnpm-style installs.
- **Status shows the real server**: `workspace status` gains an `effective` field naming the server a command will actually use.

### Breaking Changes

- The CLI no longer has `--web-runtime` / `--no-web-runtime`; the `web` target went with the relay and Web entry point.
  Migration: browser runs are now the Desktop home Web build, and passing either option reports that it was removed.
- A server-located related project target hands over KV only; knowledge and entrypoint calls fail with a clear error.
  Migration: move the target to a `local` location, or put the needed capability in a locally runnable entrypoint.
- A local related project opens its knowledge base only with a persistent-value directory, shared with the child run.
  Migration: pass `--persistent-value-store-dir` or set `STEAMHARNESS_PERSISTENT_VALUE_STORE_DIR`.

### Added

- Added video output item recognition, keeping readable links in text output and the structured descriptor in JSON output.
- Added `--videos` reading video file references of the default conversation, with MIME inference for common paths.
- Added runtime support for file parameters using the audio control and audio file references.
- Added `effective` to `workspace status`, reporting the server, credential source, and precedence actually used.
- Added related projects reading a target's knowledge base, authorized per key by `grantToRelatedProject`.
- Added related projects calling granted entrypoints, taking the arguments that entrypoint's `createInput` parses.
- Added `structure` preserving optional Workflow entrypoint `group` display metadata.

### Changed

- Changed project-group `workspace upload` to return `202` with a `jobId` and poll deployment status instead of waiting.
- Changed the pinned `steamharness` to the dev channel, with system-AI model attributes coming from the Server catalog.
- Changed model effort levels to converge on what the model declares, with the usage denominator taken from its real window.
- Changed host image references to be resolved through the workflow file store before reaching the model, failing loudly.
- Changed remote runs to use the Runner artifact and image digests captured at enqueue time, unaffected by later uploads.

### Fixed

- Fixed the CLI no longer running as a silent no-op through a symlink, comparing `process.argv[1]` in both forms.
- Fixed a related project's storage root and its child run always landing on the same directory.
- Fixed a failed related-entrypoint call raising that entrypoint's own error instead of reading as an empty result.
- Fixed related-entrypoint calls no longer requiring a locally-stored target, so `server` entrypoints reach the server.
