# Unreleased

- Fixed default personal configurations for developers to use published templates instead of filtered drafts; unpublished role-controlled configurations explain that publication is required.

- Added authoritative project and inherited group role checks for configuration use and management. Responses, exports and attachments are filtered; version 3 templates freeze role policies and fixed assignments.

- Fixed publication drafts, previews and distributed templates honoring source system-only restrictions. Drafts cannot relax policy, and excluded historical third-party values do not block publication.

- Project configuration APIs honor source-declared system-only AI rules, atomically reject third-party saves and imports, and preserve source restrictions in published model fields.

- Added static discovery of Core Agent model configuration fields with account isolation, import/export and publication permissions. Model secrets are excluded from publication by default.

- Fixed invitation lists to expose only guest and developer invitations to maintainers, preventing project and group privilege escalation through higher-role tokens.
- Fixed admin-key request approval to retain system administrator identity. Guest requests use a separate membership-request table without migrating retired source grants or depending on their constraints.
- Fixed published personal configuration reads, saves and exports to work without a draft; draft publication checks are returned only for the selected draft.

- Fixed startup initialization of administrator and group columns on existing account and project tables, preventing login and project-query failures while preserving data across repeated initialization.
- Changed business authorization to fixed guest, developer, maintainer and owner roles per project and nested group, with inheritance sources, invitations, guest requests, ownership transfers and last-owner protection. Accounts retain only system administrator identity; the new API and schema do not migrate old role data.

- Fixed publication filtering to retain inherited editing and value inclusion rules beneath omitted JSON parents, preventing whole-object replacement or imports from changing locked values.

- Added author publication drafts and immutable version templates with filtered fields, values, defaults and attachments; maintainer access, source hashes and draft revisions are checked, personal data stays account isolated, and denied edits/imports are atomic.

- Fixed: project configuration file fields choose and upload files to Server storage, then save references. Type restrictions, replacement and clearing preserve the previous value when uploads fail.

- [Fixed] Retain newer field values and shadowed custom definitions when reading or editing configurations for older source versions in file and PostgreSQL storage.

- [Added] Generic project configuration APIs and new project/account-scoped storage replace the Kanban-only endpoints, with revision checks, atomic import/export, custom fields and shared static-preview values. Existing configuration data is not migrated.

### Project Avatars

- New projects without avatar metadata save their type icon with random foreground and background colors at a contrast ratio of at least 4.5:1; reconnecting existing projects preserves their avatar.

### Breaking Changes

- Project endpoints moved from `/api/workflows` to `/api/projects`; `workflowId` / `workflowName` are now `projectId` / `projectName`, and `X-Workflow-Locale` is now `X-SteamHarness-Locale`.
- Database tables `workflows` / `workflow_*` are now `projects` / `project_*`, and account tables dropped the `workflow_` prefix. Run `docker-internal/deploy/migrate-project-tables.sql` before deploying.
- Audit event types `workflow.*` are now `project.*`; the object-storage prefix and on-disk data directory are `projects/`.

### Changes

- Changed publication to check version and source hash against concurrent draft changes.
- Make Server a project and data storage service: remove project execution and Runner while retaining safe uploads, immutable source versions, Knowledge, KV and files; authorize data writes and source downloads through the fixed roles.
- Remove obsolete execution errors and permission descriptions; data access errors describe server storage authorization only.

### New Features

- **Kanban page method injection**: injection supports method registration and disposal, catalogs, JSON results, and cancellation.
- **Kanban presentation bridge**: the bridge exposes `getPresentation()` and presentation change events for full screen, phone, tablet, and conversation cards.

### Added

- Added method registration and disposal, catalogs, JSON results, and cancellation to the Kanban injection API.
- Added `getPresentation()` and presentation change events to server Kanban pages, covering full screen, phone, tablet, and conversation cards.
- Added project-bound file create, read, and delete on the Kanban bridge, up to 50 MiB, rejecting other projects and conversation attachments.

### Fixed

- Fix direct navigation and refresh of the Server Web `/projects` page returning a JSON 404 from the removed API route guard.
