# Unreleased

- Validate v2 encoded release structures statically. Compact JSON and renew the integrity inventory after publishing configuration and attachments, preserving encoded internals and readable project and entry summaries in downloads.

- Fixed release uploads failing integrity checks after Server applies project metadata, while continuing to reject tampered archives.

- Update project artifact validation to exclude caches, reports and release staging under dist/steamharness/ from source distribution.

- Breaking: registered entry types are workflow, bot and kanban; old conversation declarations are rejected, and uploads and distribution use the new static contract.

- Reduced database round trips when acquiring uncontended relational binding and authorization locks, while preserving bounded waits, revocation, and migration isolation.
- Validate, preview and distribute compiled releases; constrain published configurations to release fields and profiles.

- Fixed Studio database management links to reuse the current account through a short-lived, single-use browser handoff that preserves key permissions and revocation.

- Static validation and previews group entry builds alongside generated databases and accept only the entry's own build directory.

- Static project validation rejects entry names and paths that collide with managed artifact directories or Windows device names.

- Static Kanban previews resolve entry from the aggregate root and validate database artifacts under dist/steamharness by source root. Old generated paths are no longer supported.

- Updated the Kanban Workflow Bridge with a separate 120-second deadline. Static previews continue to reject execution operations.

- Fixed concurrent native workers opening temporary database connections for one entry without competing for exclusive binding locks. Rebinding, migrations and revocation still fence old connections.

- Fixed asynchronous PostgreSQL disconnects on checked-out and standalone clients crashing the Server. Failed operations still report errors, and pooled requests can establish fresh connections.

- Static Kanban explicitly rejects Workflow execution and Conversation control with guidance to use local CLI Web or Studio.

- Fixed native database authorization using shared read locks so concurrent queries do not fail on binding contention. Rebinding, migrations and revocation retain exclusive locks.

- Fixed concurrent table requests and Browser binding resolution by waiting for database locks before execution. Authorization and models are revalidated after waiting, and stale row edits remain rejected.
- Fixed aggregate publication accepting JSON numeric configuration revisions for each entry, including the initial revision 0, restoring CLI and Studio upload/publication flows.

- Fixed table data consistency for UTC dates, mapped enums and lists. Database privileges and per-step authorization protect migration history, and usage statistics preserve metadata containing special Unicode.

- Changed: remove legacy KV, database-space and project KV endpoints. Browser table queries validate the account, binding, access revision and model fingerprint on every call; rebinding and revocation invalidate existing clients.

- Added relational knowledge storage, account grants, versioned bindings, document CAS, Unicode substring search and private attachment collection. Restricted model/row management preserves BigInt/Decimal precision and rejects stale row edits.

- Added platform history, ordered message/queue records, run usage and versioned Agent snapshots with account/entry isolation, revision conflicts, deletion tombstones, project identity resolution and active-session snapshot reads.

- Added entry-scoped relational bindings, account API key-only SQL leases and per-operation authorization. Rebinding, access changes and cancellation revoke SQL identities and prevent stale clients from switching resources.

- Added an account-authenticated independent PostgreSQL database catalog, recoverable provisioning, read/write roles and connection revocation, with shadow validation, transactional migrations, immutable history and restart recovery.

- Added static inventory, source fingerprint, and hash verification for SteamHarness Database generated assets in uploads and snapshots. Other local runtime data stays excluded; Server does not execute database definitions.

- Added relational Agent storage and account-authenticated APIs for unpublished local workspaces, exclusive leases and safe retries, plus an isolated PostgreSQL 17 Docker development environment.

- Removed global and account memory, including tools, skills, authorization, service integration and settings controls.

- Fixed Kanban database reads contending for a space-wide exclusive lock and delaying annotations and revision checks behind large attachments. Images and other attachments now use private file storage with metadata and a digest in PostgreSQL; legacy attachments move on first read while retaining references and revisions.

- Added: Project configuration accepts agent-model single selectors storing a configured model ID or empty inheritance, with existing permissions and publication rules.

- Fixed file and PostgreSQL project configuration reads overwriting the account's selected profile during a temporary role fallback. Access recovery restores the saved selection; explicit changes and guest isolation remain enforced.

- Fixed project pagination to exclude retained records without aggregate entry declarations consistently with detail reads, preserving their versions and stored data.

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
