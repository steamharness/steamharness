# Changelog

All notable public changes to this release unit are recorded here.

## 0.1.1 - 2026-07-29

### New Features

- **Release announcement**: a new Server version shows its update summary once, with a link to the complete Docs record.

## 0.1.2 - 2026-07-29

### Fixed

- Fixed formal releases stopping during strict TypeScript validation before completing their build and deployment.

## 0.1.3 - 2026-07-30

### New Features

- **Kanban preview and named configs**: project lists and public Embed support Kanban preview, named configuration, static assets, and restricted bridges.
- **Local releases**: Server Web releases complete on the deployment host itself instead of SSH-ing back into it.

### Added

- Added Kanban preview, named configuration, static assets, and restricted KV and knowledge base bridges to project lists and public Embeds.

### Changed

- Changed Server Web releases to complete locally on the deployment host, without an SSH connection back to the same host.

## 0.1.4 - 2026-08-07

### New Features

- **Interface language follows the system**: the console and public Embed offer three language settings, and summaries and log links follow the active one.
- **Collapsible entrypoint lists**: Webhook settings load and validate the target catalog, and results, history, and replay show the actual entrypoint.
- **Schedule workspace**: manage exact-version and entrypoint plans, preview triggers, run now, and inspect fire history.

### Added

- Added Follow system, Simplified Chinese, and English settings to the console and public Embed, with summaries and log links following the active language.
- Added collapsible Workflow entrypoint lists to the console and public Embed, with Webhook settings loading and validating the target catalog.
- Added the Kanban Bridge reading authorized Workflow KV sources by static alias and subscribing to revisions, without exposing source identifiers or write access.
- Added a Workflow schedule workspace for exact-version and entrypoint plans, trigger previews, run now, fire history, and scheduled-source filtering.
- Added dependency and permission workspaces with data-grant editing, short-lived source requests, consumer search, and approval or revocation.

### Changed

- Changed the project workspace to sort by update time with the most recently updated projects first.
- Changed run replay and public Embed to redesign reasoning, tools, tasks, files, retries, and errors, following streams reliably at the bottom.
- Changed multi-entrypoint views to use compact headers and aligned forms, retaining Form or Raw mode and current input during updates.

### Fixed

- Fixed manually collapsed default entrypoints reopening, host rerenders resetting input, and late errors from an old target appearing on the current one.
- Fixed Kanban refreshing twice after the initial snapshot, entrypoint failures hiding every schedule, and schedule actions accepting rapid duplicates.

## 0.1.8 - 2026-08-26

### New Features

- **Server data only**: `server` and `both` projects stay runnable, while `local` or undeclared projects show one blocked state.
- **Standalone Alpha endpoint**: deployed with each Server Alpha version, sharing accounts and data while isolating code and assets.
- **Runnable status is visible**: project lists, details, and versions show the current-locale name, declarations, platforms, and runnable status.

### Breaking Changes

- Server Web accesses server data only; `local` and undeclared projects are blocked everywhere outside Settings.
  Migration: declare `server` or `both`, and remove server data access from the other locations.
- Run, overview, and version sources now use the Desktop identity and the `desktop` filter value.
  Migration: change the caller's source identifier to `desktop`.

### Added

- Added a dedicated initial-password page for account invitation links that establishes a signed-in session when accepted.
- Added read-only storage declaration, allowed locations, server-access state, and block reason to Project Settings.
- Added blocked projects no longer exposing writable run-queue, access-policy, or data-entry controls.
- Added current-locale name, manual declarations, display platforms, and runnable status to project lists, details, and versions.
- Added Run, Embed, Webhooks, schedules, and version selectors offering only Server-runnable versions.
- Added deployment of Server Web to a standalone Alpha endpoint per Server Alpha version, isolating code and static assets.

### Changed

- Changed run replays and detailed logs to open stdout, stderr, runner diagnostics, and `report.json` by default at full available width.
- Changed long log content to scroll in dedicated regions, so manually collapsed reports leave no blank space.
- Changed run, account, schedule, usage, audit, and release timestamps to use `YYYY-MM-DD HH:mm:ss`.

### Fixed

- Fixed project type names now following the interface language, so the Chinese interface consistently shows 工作流, 对话, and 看板.

## 0.1.9 - 2026-09-01

### New Features

- **Related Projects workspace**: create, edit, and remove reciprocal relationships with per-project grants and confirmed or pending state.
- **MCP connection page**: select a draft, latest, or exact target and copy the Streamable HTTP URL and client JSON.
- **Primary answers stay in the transcript**: finish reasons, token usage, and Provider metadata no longer misclassify them as details.

### Breaking Changes

- The Global KV navigation and page are removed; the KV inspector shows only the current project's KV domain.
  Migration: use the `project` and `conversation` scopes instead of global KV.

### Added

- Added a general Related Projects workspace with per-project read/write rules and confirmed or pending declarations.
- Added an MCP connection page for Workflow projects to pick a version target and copy the URL, Bearer template, and client JSON.

### Changed

- Changed registered but never published projects to hide Embed entries, with their Embed URL returning to Project Overview.
- Changed public Embed composers to combine quick parameters into one summary trigger that prioritizes “Model · Effort”.
- Changed narrow screens to drill down into quick options, with a one-click reset to defaults.
- Changed Kanban and project-group dependency views to use confirmed related projects only.

### Fixed

- Fixed Conversation projects rendering the assistant's primary answer directly in the transcript, with tools and reasoning still in details.
- Fixed public Embed history rails and diagnostics panels stalling, losing the pointer, or leaving resize state behind.

## 0.1.10 - 2026-09-05

### New Features

- **Run records can be renamed and deleted**: project managers or the run's initiator may act, and active runs can still be renamed.
- **KV entries can be deleted**: the detail dialog confirms and calls `DELETE /api/projects/:name/kv/entry` for one entry.

### Breaking Changes

- Server Web no longer hosts the public Embed; its project entries, list status, `/embed/**` pages, and hostname are gone.
  Migration: browser runs move to the Desktop home Web build, and the console only manages cloud projects.
- Server Web no longer has a `/web` entry page, and sign-in no longer accepts a `next=web` return trip.
  Migration: send users straight to sign-in and land them on the project list afterwards.

### Added

- Added grouped, collapsible Workflow entrypoints in public Embeds, scoped to the site's stable Workflow ID.
- Added an admin Runner page showing node status, protocol and architecture, capacity, and heartbeat, with drain and resume.
- Added Runner pool, CPU, memory, and timeout settings, with Core and image digests on the versions page.
- Added Rename and Delete to execution-log rows, restricted to project managers and the run's initiator.
- Added a confirmation naming the record before deletion, after which the row leaves the list.
- Added a Delete entry action in the KV detail dialog that calls the delete endpoint and refreshes the page.
- Added failed deletes keeping the dialog open with the reason in place, hidden entirely without permission.
- Added a raw JSON escape hatch validating keys and types before applying, with parse errors shown in place.

### Changed

- Changed public Embed to preview video attachments while preserving their media types.
- Changed run-related views to offer only remote Server-runnable versions, reading task state from the Runner control plane.
- Changed the execution-log, schedule, MCP, and webhook tabs to Server Web's own compact replay and parameter forms.
- Changed the Knowledge tab document list to pagination, so scrolling to the end no longer loads more.

### Fixed

- Fixed anonymous `/web` visits going to sign-in first and returning afterwards, with `?next=` accepting route names only.
