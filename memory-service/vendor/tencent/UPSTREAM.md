# TencentDB-Agent-Memory

Source: https://github.com/TencentCloud/TencentDB-Agent-Memory
Revision: `ecc01a545da0b2ac6cae2f0f0af0d39d41469793` (MIT, see LICENSE).

Vendored: MemoryCore/src/core/prompts/{l1-extraction,l1-dedup}.ts and core/store/tokenize.ts.
Replay: copy those files to this directory, then `git apply patches/0001-host-neutral-types.patch`.
`types.ts` is SteamHarness's type-only host bridge. No OpenClaw service/private integration is used.

The adapter reuses L0 formatting, L1 extraction/conflict prompts and jieba tokenization.
SQLite storage is a dedicated FTS5/BM25 adapter using Node's sqlite, with SQL scope filtering
BEFORE LIMIT, atomic operation receipts, source suppression and scope generations. Upstream's
JSONL writes, random message IDs, in-memory task backend, embedding and L2/L3 are intentionally
not used. Automatic conflict handling only skips duplicates; it never overwrites manual edits.
