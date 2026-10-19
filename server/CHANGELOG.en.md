# Changelog

All notable public changes of this release unit are recorded here.

## 0.1.1 - 2026-07-29

### New Features

- **Health check exposes versions**: `/health` returns Server, bundled Core, the current update summary, and a Docs entry.
- **Runs record the Core version**: hosted versions and run records keep the required, built, and actually executed Core and Server versions.

### Added

- Added `/health` returning the Server version, bundled Core version, current update summary, and Docs entry.
- Added Core and Server versions to hosted versions and run records for the required, built, and actually executed runtimes.

### Changed

- Changed upload, edit, copy, preview, and run to check compatibility against each project's exact Core dependency.

### Fixed

- Fixed hosted versions with an unknown Core version running on a guessed range; they are now marked unknown and taken down.
- Fixed `/health` reporting the wrong Server or Core version when release metadata lags or a deployment rolls back.
- Fixed transient object storage failures permanently taking down versions during legacy Workflow Core metadata migration.

## 0.1.2 - 2026-07-29

### Fixed

- Fixed the production build shipping uncompiled runtime-compatibility TypeScript sources, which stopped Server from starting.

## 0.1.3 - 2026-07-30

### New Features

- **Kanban hosting and preview**: drafts, versions, static asset hosting, and Studio/Embed previews with user-isolated named configs.
- **Local deployment releases**: Server and Docs release on the deploy host itself instead of SSH-ing back into it.

### Added

- Added Kanban drafts, versions, static asset hosting, and Studio/Embed previews with user-isolated named configs.
- Added scoped KV and knowledge base bridges authorized per project by the host.

### Changed

- Changed Kanban upload preparation to validate only built static assets, without installing dependencies or starting a Workflow runtime.
- Changed published versions to keep the complete Kanban static assets.
- Changed upload, archive copy, and run to validate project compatibility with the host Core version.

## 0.1.4 - 2026-08-07

### New Features

- **Request-scoped runtime language**: first-party APIs read `X-SteamHarness-Locale` and inject the run language into the console, Embed, Webhooks, and parameter parsing.
- **Version-scoped read-only KV sources**: Kanban Studio and Embed refresh over authenticated revision SSE and drop the source as soon as access is revoked.
- **Workflow schedules**: fixed-version, fixed-entrypoint plans, common time rules, run-now, and fire history.

### Added

- Added first-party API errors, health summaries, and a standalone Server release log in the requested language.
- Added entrypoint selection and stored entrypoint snapshots for the console, Embed, External, streaming, parameter, and Webhook APIs.
- Added rejection of invalid entrypoints before enqueueing or sending streaming response headers.
- Added read-only Workflow KV sources authorized by exact version and key prefix for Kanban Studio and Embed.
- Added exact dependency locks, resumable deployment, partial source download, source requests, and prefix-scoped data grants for Kanban project groups.
- Added refusal to transfer KV, plans, run history, environment variables, or client credentials to project groups.

### Changed

- Changed the scheduler to prevent duplicate multi-instance runs through unique fires, leases, permission rechecks, and graceful shutdown.
- Changed plans to reject edits and deletion while a fire is active.
- Changed the Kanban revision stream to merge bursts, keep PostgreSQL reconnect order, and close cleanly when the source is unavailable.
- Changed Server to exit normally after the revision stream signals completion.

### Fixed

- Fixed cloud Kanban subresources returning 401 or 500, which blanked the screen; short-lived capabilities now scope to project and expiry.
- Fixed remote run streams occasionally corrupting Chinese and other multi-byte characters at segment boundaries.
- Fixed `source` mode Kanban being reported missing in public Embeds.
- Fixed default config initialization failing the first time a PostgreSQL user opened an Embed.
- Fixed Workflow runtimes writing dev tooling and pnpm symlinks into archives, which made published versions unloadable from object storage.

## 0.1.8 - 2026-08-26

### New Features

- **Standalone Alpha deployment**: shares PostgreSQL and the OSS bucket with stable while isolating code, processes, logs, and caches, running on port `7140`. See [Deployment](../docs/guides/server/deployment.mdx).
- **Version resolution by release target**: every version pins Server, macOS, and Windows targets, and runs and schedules only resolve online versions with a compatible runtime.
- **Project display metadata**: default name, localized name, manual declaration, and display platform. See [Project management](../docs/guides/server/project-management.mdx).

### Breaking Changes

- Server only runs projects and serves server data when `dataStorage.mode` is `server` or `both`.
  Migration: `local` and undeclared projects must become `server` or `both`, otherwise every entry point returns a structured `409`.
- Core and CLI move to exact `0.2.0` dependencies and PersistentValue APIs must carry `projectId`.
  Migration: non-global namespaces, entries, and sources must set `projectName` to the project ID.
- Server removes Supabase entirely; accounts, sessions, and invitations move to native PostgreSQL.
  Migration: account data has to be migrated once into Server's own PostgreSQL database.
- Desktop login and run sources standardize on `desktop`, and the old `app` source is no longer accepted.
  Migration: change the caller's source identifier to `desktop`.

### Added

- Added atomic cloud project creation receiving the UUID and full `projectInfo`, letting Desktop bind or restore by the same UUID.
- Added default name, localized name, manual declaration, and display platform, served through the project list and `PUT /api/projects/{id}/project-info`.
- Added Server, macOS, and Windows release targets pinned per version, with local-only versions skipping dependency install and runtime builds.
- Added source and project group downloads validated per macOS/Windows target and resolving `latest` per platform.
- Added an Alpha deployment path sharing the database and bucket with stable while isolating code, processes, logs, and local caches.

### Changed

- Changed Desktop installers, the update feed, and bundled project resources to Aliyun OSS.
- Changed Alpha Server to disable schedule polling by default; plan management and run-now still work.
- Changed compatibility checks to require an exact Core declaration and compare only the `major.minor` line.
- Changed production credentials to come from protected GitLab CI/CD variables, keeping development `.env` files local only.

### Fixed

- Fixed recovery falling back to `/var/run/docker.sock` when no Docker socket path is configured, so Alpha can start PostgreSQL.
- Fixed bundled project indexes not forcing client revalidation, with versioned bundles now on long-lived immutable caches.

### Removed

- Removed the local download service that Server used to start, recover, and configure.

## 0.1.9 - 2026-09-01

### New Features

- **Standard Workflow MCP endpoint**: Streamable HTTP exposes entrypoints as tools and reuses the existing run queue, persistence, and audit stack. See [MCP](../docs/guides/server/mcp.mdx).
- **Conversation OpenAI gateway**: a bearer-only `/v1` serving Responses, Conversations, and Models subsets with per-project keys. See [OpenAI Responses](../docs/guides/openai-responses.mdx).
- **Related project KV grants**: mutual or one-sided confirmation with read/write or prefix-scoped grants that take effect as soon as they are revoked.

### Breaking Changes

- Global KV, the old `workflow` scope, `kv.workflow`, `persistentValue.workflow`, and standalone data grants are removed.
  Migration: KV and PersistentValue keep only project and conversation scopes, isolated per storage type.

### Added

- Added a standard Streamable HTTP MCP endpoint for Workflow projects, authenticated with account or admin keys.
- Added a bearer-only OpenAI Responses gateway and project key management for Conversation, isolating resources per user and project.
- Added `wfpk_*` full keys shown only once on creation or rotation, with old keys invalidated immediately.
- Added run records written when an OpenAI Responses call starts and updated in place on completion, failure, cancellation, or restart.
- Added KV read, write, and compare-and-set APIs for the current and related projects, authorized against both latest declarations.
- Added dedicated project storage, revision, and related-project dependency tables, leaving legacy tables, functions, and views untouched.

### Changed

- Changed Kanban bridges, project group locks, downloads, and releases to resolve only confirmed related projects.
- Changed the OpenAI Responses gateway to report output limits and content filter end states as `incomplete` while keeping partial output.
- Changed Conversation deletion to keep its Items, with transactional locks around image reuse, deletion, and expiry cleanup.
- Changed persisted `incomplete` responses to be resumable through `previous_response_id`.

### Fixed

- Fixed production builds inlining the OpenAI Responses Shared runtime instead of leaving TypeScript-only packages in deploy dependencies.
- Fixed MCP elicitation returning invalid content or failing transport or recovery no longer leaving `waiting_for_input` runs behind.
- Fixed OpenAI call metadata trusting only `STEAMHARNESS_API_PUBLIC_BASE_URL` or forwarded headers from a trusted proxy.
- Fixed partial image upload failures now returning explicit validation errors and reclaiming the partial files.
- Fixed the gateway accepting `system` and `developer` messages, `text.verbosity`, and the compatibility `include` parameter.

## 0.1.10 - 2026-09-05

### New Features

- **Local execution mode**: `pnpm dev` and `pnpm start:local` run cloud Workflows on the host without a Runner or container build. See [Deployment](../docs/guides/server/deployment.mdx).
- **Cross-service related project calls**: run containers read a target project's knowledge base and invoke its entrypoints as the calling user. See [Project management](../docs/guides/server/project-management.mdx).
- **Project KV entry deletion**: `DELETE /api/projects/:name/kv/entry` removes a single project KV entry by scope and key.

### Breaking Changes

- The public Embed HTTP endpoints and the `server-live` relay unit are removed, along with the `embed.manage` permission.
  Migration: browser runs move to the Desktop home Web build, and the console only manages cloud projects.
- The Server execution surface drops local dependency install, builds, Node subprocesses, and local fallback.
  Migration: project versions must be built and run by a remote Runner against a fixed Core, runtime protocol, architecture, and OCI digest.
- `listWorkflows` no longer accepts `origin`, and project summaries no longer return `embedEnabled` or `embedPublicUrl`.
  Migration: callers rely on the default project list fields instead of an Embed toggle.
- Anonymous `/web` visits redirect to login and back, and `?next=` only accepts route names rather than arbitrary paths.
  Migration: never put an absolute path in `next`, which is rejected to avoid an open redirect.

### Added

- Added a persistent Runner pool with nodes, leases, task ordering events, artifacts, and a runtime capability control plane.
- Added nodes registering, renewing, and claiming tasks over outbound HTTPS, so project containers never get database or admin credentials.
- Added runtime KV, PersistentValue, related project, and file APIs whose tokens bind to project, user, task, and expiry.
- Added renaming and deletion for run records, restricted to project admins and the run's initiator.
- Added display names and stable `cardId` values for run records so embedded cards stop being recreated on scroll.
- Added an optional local object storage driver writing artifacts and avatars to disk via `STEAMHARNESS_STORAGE_DRIVER=local`.
- Added startup without any OSS credentials, with avatars served read-only from `/storage/avatars`.
- Added the wflive relay on ECS, with Stable and Alpha listening on 7150 and 7151 respectively.
- Added a `delete` operation to `POST /api/project-storage` returning `{ removed: false }` for missing entries.
- Added the `kv.manage` permission, granted to the Developer role while Operator and Viewer stay read-only.
- Added optional grouping metadata on the Workflow entrypoint structure for partitioned public Embeds.

### Changed

- Changed `server:start` to keep source mode and dev ports while disabling backend listening and Web hot reload.
- Changed related project knowledge base and entrypoint calls to require explicit grants from the target project, checked per key.
- Changed entrypoint calls to run once as the initiating user, with the called project gaining no related access itself.
- Changed `STEAMHARNESS_OSS_ENDPOINT` to accept a same-region internal endpoint while signing URLs with the public endpoint.

### Fixed

- Fixed Runner artifact uploads being cut off by the OSS client's 60 second timeout, now budgeted at 5 minutes.
- Fixed local execution accessing Server as the initiating user by issuing a run-scoped key valid for 6 hours.
- Fixed the local execution subprocess environment to be allowlisted, keeping database, OSS, and LLM secrets away from project code.
- Fixed nested runs of related projects being unable to reach further, returning `503` when the originating run cannot be verified.
- Fixed related project knowledge base writes being validated per document key instead of per whole modification.
- Fixed `/related/run` returning nested failures with their status and error codes instead of collapsing them into request errors.
- Fixed related project entrypoint lists sampling `latest` to match what `runEntrypoint` actually executes.

### Removed

- Removed `GET/PUT /api/projects/{projectId}/embed` and every `/embed/**` route.
- Removed the `wfembed` host and `STEAMHARNESS_EMBED_PUBLIC_BASE_URL`; `workflow_embed_configs` stays expand-only.
- Removed the Server Web `/web` entry page with its runnable version list and `next=web` redirect.
- Removed the `server-live` release unit, the `/api/desktop/v1/*` and `/api/web-runs/*` routes, and the `web` release target.
