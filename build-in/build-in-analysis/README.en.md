# Studio Analysis

A built-in Kanban project that reads real local projects and run records through a read-only Studio connection. It does not connect to Server.

Run `Workflow: Open Studio Analysis` from Studio's command palette, or open this repository as a normal Kanban project. Runnable HTML and bundled assets are included. After changing source files, run `pnpm install` and `pnpm build`.

The project scope includes the current workspace and previously imported local Studio projects, deduplicated by real path. Unimported disk folders are not scanned. Projects declaring server storage are excluded. The dashboard includes project types, run statuses, a 14-day trend, and active or waiting runs. Project and run tables support filters, pagination, and CSV export. Optional automatic refresh runs every five seconds.

Data comes from Studio's CLI histories and activity records from running services, selecting history by the current project type. Success, failure, cancellation, timeout, and interruption remain distinct. Expired heartbeats without a confirmed process exit, and unverified runs from older CLIs, display an unknown status. Merging windows deduplicates queued inputs and does not restore deleted terminal runs. Unreadable projects are marked unavailable; no demonstration data is used. Standalone browsers and ordinary CLIs display an unavailable connection state.

`pnpm test` checks aggregation and export. `pnpm test:ui` checks both languages, themes, and responsive layouts in a headless browser.
