# Unreleased

- Breaking: project identity, name, version and declarations now use independent `steamharness.json` files. Removed reads and writes of `package.json.id` and `steamHarness`. Aggregates explicitly register child entries whose configuration defines icons, declarations, database aliases and schedules. Unregistered configurations stay inactive, and transfers preserve the parent and child structure.

- Static analysis runs per registered entry, validating Workflow and Conversation executors and Kanban artifacts independently. Single-type project declarations are removed.

- [Changed] Declare analysis dashboard fields in `configuration.json` and manage actual values through project configurations.

### New Features

- **Local analytics dashboard**: charts, run trends, activity lists, and filterable exportable detail tables built from real project and run data.

### Added

- Added a local Studio analytics dashboard aggregating real project and run data.
- Added charts and run trends to the analytics dashboard.
- Added activity lists to the analytics dashboard.
- Added detail tables exportable to CSV by filter.

### Fixed

- Fixed rolling time filters stopping when history was unchanged.
- Fixed record timestamps missing the date and seconds.
- Fixed insufficient dark theme status text contrast.
- Fixed touch targets being too small.
- Fixed incomplete CSV formula prefix escaping.
