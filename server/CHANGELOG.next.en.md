# Unreleased

### Changes

- Changed publication to check version and source hash against concurrent draft changes.
- Make Server a project and data storage service: remove project execution and Runner while retaining safe uploads, immutable source versions, Knowledge, KV and files; authorize writer data access separately from source downloads.
- Remove obsolete execution errors and permission descriptions; data access errors describe server storage authorization only.

### New Features

- **Kanban page method injection**: injection supports method registration and disposal, catalogs, JSON results, and cancellation.
- **Kanban presentation bridge**: the bridge exposes `getPresentation()` and presentation change events for full screen, phone, tablet, and conversation cards.

### Added

- Added method registration and disposal, catalogs, JSON results, and cancellation to the Kanban injection API.
- Added `getPresentation()` and presentation change events to server Kanban pages, covering full screen, phone, tablet, and conversation cards.
- Added project-bound file create, read, and delete on the Kanban bridge, up to 50 MiB, rejecting other projects and conversation attachments.

### Fixed
