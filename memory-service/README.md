# SteamHarness Memory Service

Private account memory using TencentDB-Agent-Memory L0/L1 prompts, jieba and SQLite FTS5/BM25.
No embedding service is required. See `vendor/tencent/UPSTREAM.md` for the pinned revision,
MIT license, exact reused files and replayable patch. L2/L3 and the upstream private service mode are not enabled.

Requires Node 22.13+ with SQLite/FTS5 (the image uses Node 24). From the monorepo root:

```sh
pnpm --filter @steamharness/memory-service build
pnpm --filter @steamharness/memory-service start
```

Configure `STEAMHARNESS_MEMORY_SERVICE_TOKEN` (at least 32 random characters),
`STEAMHARNESS_MEMORY_DATA_DIR`, and optionally the administrator's dedicated
`STEAMHARNESS_MEMORY_MODEL_BASE_URL` (OpenAI-compatible `/v1` base),
`STEAMHARNESS_MEMORY_MODEL_API_KEY`, `STEAMHARNESS_MEMORY_MODEL`.
Only the service stores the extraction model credential. Tools are disabled for extraction.
Without a model manual memory and BM25 recall work; automatic extraction reports unconfigured.

Server needs `STEAMHARNESS_SERVER_MEMORY_URL=http://127.0.0.1:7141` and the matching
`STEAMHARNESS_SERVER_MEMORY_TOKEN`. Set `STEAMHARNESS_SERVER_MEMORY_DISABLED=1` to
stop all memory reads, writes and extraction without disabling normal conversations.

`docker compose -f memory-service/compose.yaml up -d --build` creates a loopback-only service
and a durable volume. Keep the internal HTTP credential and volume inaccessible to project workers.
`/health` requires the internal credential and checks FTS5; the service never accepts user tokens.

## Backup, recovery and rollback

Pause Server memory traffic and stop Server workers before a coordinated snapshot. Run
`pg_dump --format=custom` against the Server account/project database (credential from a protected
environment, never command-line literals). Preserve `memory_instance`, `memory_credentials`,
`memory_preferences`, `memory_scopes`, `memory_jobs` and `memory_operation_receipts` together with
account/auth/project records. Run `node memory-service/scripts/snapshot.mjs DATA_DIR NEW_BACKUP_DIR`
for consistent per-account SQLite backups; do not copy an active SQLite file without its WAL.

For recovery keep Server stopped, restore PostgreSQL and the corresponding account directories,
check each SQLite with `PRAGMA integrity_check`, then restart the memory service followed by Server.
The persisted instance ID is part of every account namespace: never regenerate it during restore.
Pending L0 turns live only in the account SQLite; PostgreSQL jobs store references, authorization and extraction snapshots. Completed L0 text is removed. Pending/expired worker leases resume automatically; atomic SQLite receipts make replay idempotent.
Test a restore on an isolated database and volume before changing live data.

Rollback code independently of data. Schema changes are additive. Disable memory and roll back the
Server/Core/CLI build if necessary; keep the new tables, source-suppression records and volume.
Deleting a conversation does not delete memories. Tombstones/receipts contain no remembered content
and remain to prevent resurrection. A lost HTTP acknowledgement reuses the atomic receipt without repeating the write.

## Limits

Recall is scoped before BM25 sorting and LIMIT, at most eight records; Core budgets at most 2,000
estimated tokens and two seconds. Lists use cursor pagination (20 by default, at most 100). Content
is plain text, at most 16,000 characters. Automatic jobs retry at most three times and never overwrite
manual content. A manual change invalidates older extraction snapshots for that scope. Forgotten
sources and cleared generations suppress older jobs. New explicit manual requests may remember again.
Each extraction produces at most 20 candidates across all scenes. Source references are deduplicated,
and the total UTF-8 result stays below 220 KB so multibyte content fits the internal apply request limit.

The first release isolates every account, project and host-registered directory; no team sharing,
implicit directory merging, dual writes, old database migration or embedding fallback is provided.
