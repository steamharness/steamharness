# Unreleased

- Improvement: Aggregate entry lists display each entry’s declared icon and foreground/background colors. Entries do not own independent versions.

- Breaking: project management displays registered entries, the default entry and separate configurations. Database pages manage requests, approval, sharing, bindings, grant recovery and space data. Related-project and project-owned database pages are removed.

- Improved avatar previews in user management and profile dialogs: click to view a larger image that fits the viewport, then return keyboard focus to the avatar on close. Existing upload, profile, menu and project navigation actions are preserved.

- Fixed avatar crop previews to fit the dialog proportionally, keeping small images usable and portrait images within the preview height. Show a loading placeholder while reading images.

- Added fixed 1:1 avatar cropping in profile settings and user management, with movable, resizable, resettable selections and automatic compression before upload, without restricting source file size. Account menus, user lists, memberships, audit entries and profile details use consistent rounded square avatars, centering existing images without stretching.

- New projects use the ID assigned by the Server; the browser no longer generates or submits a client-selected ID.

- Fixed: Standalone Web proxies follow the service channel and use localhost:7126 in dev instead of the PostgreSQL port.

- Fixed: deployments include localized Server and Web notes with source identity; health links use the current environment.

- Added mode capability and minimum-role labels to configuration lists. Guests see accessible base profiles, with collection and field management hidden and fixed modes read-only.

- [Improved] Highlight the configuration in use with a clear badge and provide Use this configuration buttons for other profiles. Keep list and detail usage in sync, preserve selection on failure, and retain drafts during external switches.

- AI configuration honors source-declared allowThirdParty restrictions, hides source switching for system-only projects, and marks existing third-party entries unavailable for cleanup.

- Improved model editing with a separate dialog and segmented source selection. System AI only needs Provider and model selections and generates names automatically. Fields and model lists have clearer borders, and the lone Configuration values tab is hidden without publication management.

- Added system and third-party model management in configuration details, with exclusive source forms, on-demand subscription catalogues, model CRUD, default ordering, draft protection and read-only permissions.

- Added group and subgroup navigation, ownership selection and direct/inherited member management. Effective capabilities control upload, publication, configurations, data and settings. Removed global role editing and added guest requests from private share links.

- Improved: project configurations open with a profile list and separate detail views for values and publication rules. Browsing preserves execution selection, and back navigation protects unsaved drafts.

- Improved: project configurations use responsive columns and inline boolean controls without stretched checkboxes. Publication permissions use aligned table columns, a compact profile/action toolbar, and expandable JSON paths.

- Added a publication and permissions tab with profile/default selection, recipient previews, JSON child editors and lock reasons; conflicts preserve edited drafts.

- [Improved] Edit project configuration fields directly without a Set value checkbox. Reset icons restore defaults or clear overrides; boolean and multiple-choice controls retain their checkboxes.

- Fixed: project configuration file fields choose and upload files to Server storage, then save references. Type restrictions, replacement and clearing preserve the previous value when uploads fail.

- [Improved] Separate configuration management, fields and saving. Group secondary actions in icon menus, show export details with those actions, and use labeled icons for custom field editing and draft refresh.

- [Fixed] Ignore save responses from a previous project visit to preserve current drafts, and allow repairing previous non-array values after a field changes to multiple options.

- [Added] Add project configurations to all project detail pages, with field/value editing, profile management, import/export and recovery for conflicts, failed saves and empty states.

### Project Avatars

- Project list avatars open their projects; standalone avatars support previews. User avatars open the displayed profile, and personal profile avatars select an upload, with keyboard focus restored on close.
- Project lists, detail headers, overviews, and settings consistently display avatars from the projectCard icon and colors.

### Added


### Changed

- Changed Settings and Admin Center to expand submenus in the main sidebar, retaining Project Workbench and other entries while switching pages and filtering admin entries by permission; project details keep dedicated navigation.
- Changed the console to shadcn Blocks and New York components, unifying navigation, tables, forms, dialogs and themes while removing private styling and notifications.
- Removed the invitations block from the project members page; invitations are created, listed and revoked from the dedicated Invitations section.
- Changed the console to remove execution statistics, logs, schedules, environment variables, Webhook and Runner pages while retaining project and data management.
- Changed role descriptions to project and data permissions, removed obsolete execution types and copy, and added bilingual data write and KV descriptions.
- Changed the project information card on the project overview and Settings pages to label the project creator instead of the uploader.
- Removed the Back to project workbench entry from the top of the sidebar; the brand entry returns to the project list instead.

### Fixed

- Fixed Admin Center navigation for accounts limited to role or audit viewing permissions.
- Fixed theme inheritance in knowledge dialogs and dark styles in Markdown previews.
- Fixed version, member, and KV summaries loading when opening project details or switching tabs, while ignoring stale responses after navigation.
