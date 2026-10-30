# Dependency patches

`@earendil-works__pi-durable@1.2.0.patch` adds an opt-in `retry.allErrors`
policy. Core enables it so generation and compaction errors use the same durable
retry checkpoints, backoff and attempt limit without relying on provider error
text. The dependency's default policy remains unchanged.

Overflow compaction still runs before fallback. Its following model request
consumes a retry, and compaction cannot start another request after the budget is
exhausted. Cancellation and host failures retain their existing terminal paths.
An `afterResponse` hook can return `{ retry: false }` to enforce a shared budget
that also includes process recovery and output continuations.

Keep this patch registered in the root pnpm configuration and lockfile. Remove
it only after the pinned upstream version supplies the same behavior. Core's
agent session, compaction and process recovery tests exercise the patched paths.
