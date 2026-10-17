# Unreleased

### Added


### Changed

- Changed project, Settings and Admin Center pages to use dedicated navigation, replacing stacked global and page menus with one sidebar, a return to Project Workbench and only the current page highlighted.
- Changed the console to shadcn Blocks and New York components, unifying navigation, tables, forms, dialogs and themes while removing private styling and notifications.
- Changed the console to remove execution statistics, logs, schedules, environment variables, Webhook and Runner pages while retaining project and data management.
- Changed role descriptions to project and data permissions, removed obsolete execution types and copy, and added bilingual data write and KV descriptions.
- Changed the project information card on the project overview and Settings pages to label the project creator instead of the uploader.
- Removed the Back to project workbench entry from the top of the sidebar; the brand entry returns to the project list instead.

### Fixed

- Fixed Admin Center navigation for accounts limited to role or audit viewing permissions.
- Fixed theme inheritance in knowledge dialogs and dark styles in Markdown previews.
- Fixed version, member, and KV summaries loading when opening project details or switching tabs, while ignoring stale responses after navigation.
