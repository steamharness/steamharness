# Unreleased

- Fixed unconfigured memory service guidance to request administrator setup instead of repeated sign-in. Verified existing account sessions can manage memory while project API keys cannot.

- Fixed lasting response-language and style instructions entering global memory across projects. A missing extraction model no longer creates guaranteed-to-fail jobs; temporary outages preserve turns for retry.

- Added: Add private account memory APIs, separate login credentials, scoped authorization, a durable extraction queue and a standalone memory service without embeddings.

- Breaking: project identity, name, version and declarations now use independent `steamharness.json` files. Removed reads and writes of `package.json.id` and `steamHarness`. Aggregates explicitly register child entries whose configuration defines icons, declarations, database aliases and schedules. Unregistered configurations stay inactive, and transfers preserve the parent and child structure.

- Fixed project database directories to deduplicate current entry references instead of historical grants. Project read access is checked, and metadata visibility does not grant database management rights.

- Changed: database authorization resolves databaseId, projectId and entryId for many-to-many references. Hosts maintain all data permissions. Startup preserves unsupported project rows, snapshots and storage instead of deleting them.

- Fixed forged database request approval metadata exposing other spaces and grants. KV listing intersects host declarations, grants and client key prefixes before counting and pagination.

- Breaking: project and version APIs return aggregate entries with separate configurations. KV, knowledge, attachments and revisions use independent database spaces with creation/sharing requests, approval, narrowed grants, revocation and credential rotation. Every access is authorized; old project databases and related-project APIs are removed. Server remains a static source host.

- The Server assigns UUIDs when creating and cloning projects and rejects client-selected IDs, preventing registration of arbitrary local IDs. Creating a project does not upload source.

- Fixed local Kanban data access and related revision streams to work from registered project declarations without source uploads or configuration templates. Published targets retain immutable bindings; static previews still require uploaded artifacts.

- Fixed: Profile name changes update the authentication account and survive password login, bootstrap administrator login, and session renewal. Email and password changes preserve the saved name.

- Fixed: Release-note links follow the dev, alpha and main environments so local and alpha services open the matching documentation.

- Fixed: deployments include localized Server and Web notes with source identity; health links use the current environment.

- Improved: configure PostgreSQL connection limits per pool and the Server listen address when hosting multiple environments on one machine.

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

- Keep project deployment configuration in root config.json, centralizing database aliases and IDs; package entries declare only the aliases they use. STEAMHARNESS_PROJECT_CONFIG can override deployment values; migration updates one ID, permissions remain host-managed, and distributions retain authored values.
