# Workflow Code Shared

Private source packages shared by the Workflow Code repositories.

Sibling repositories link this checkout during local development so edits are hot-reloaded. CI and isolated checkouts consume the generated `vendor/shared` snapshot. A successful `main` pipeline builds `dist/source` and synchronizes that snapshot to the downstream repositories listed in `WORKFLOW_SHARED_SYNC_TARGETS`.
