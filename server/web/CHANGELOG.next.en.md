# Unreleased

- [Fixed] Ignore save responses from a previous project visit to preserve current drafts, and allow repairing previous non-array values after a field changes to multiple options.

- [Added] Add project configurations to all project detail pages, with field/value editing, profile management, import/export and recovery for conflicts, failed saves and empty states.

### Project Avatars

- Project list avatars open their projects; standalone avatars support previews. User avatars open the displayed profile, and personal profile avatars select an upload, with keyboard focus restored on close.
- Project lists, detail headers, overviews, and settings consistently display avatars from the projectCard icon and colors.

### Added


### Changed

- Changed Settings and Admin Center to expand submenus in the main sidebar, retaining Project Workbench and other entries while switching pages and filtering admin entries by permission; project details keep dedicated navigation.
- Changed the console to shadcn Blocks and New York components, unifying navigation, tables, forms, dialogs and themes while removing private styling and notifications.
- Changed the console to remove execution statistics, logs, schedules, environment variables, Webhook and Runner pages while retaining project and data management.
- Changed role descriptions to project and data permissions, removed obsolete execution types and copy, and added bilingual data write and KV descriptions.
- Changed the project information card on the project overview and Settings pages to label the project creator instead of the uploader.
- Removed the Back to project workbench entry from the top of the sidebar; the brand entry returns to the project list instead.

### Fixed

- Fixed Admin Center navigation for accounts limited to role or audit viewing permissions.
- Fixed theme inheritance in knowledge dialogs and dark styles in Markdown previews.
- Fixed version, member, and KV summaries loading when opening project details or switching tabs, while ignoring stale responses after navigation.
