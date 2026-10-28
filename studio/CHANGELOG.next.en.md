# Unreleased

- Improvement: Start shows one card per aggregate and opens its default entry. Project windows and entry actions use icons with redesigned entry details. Removed split views; all entries, including the current one, can open and restore multiple independent native tabs on the shared host. Closing one tab leaves the others open. Entry icons and colors are independent; entry labels no longer repeat the root version.

- Changed: entry information shows database aliases and IDs. Resource panels resolve host authorization from references, preserve entry isolation for multiple databases, and no longer read manifest permissions or host fields.

- Improved model tables with compact rows, consistent hover backgrounds, inline custom-provider details, and locally bundled brand icons for common models.

- Improved model settings with a three-column table grouping all automatically loaded built-ins above custom models, a built-in refresh action, catalogue names and centered custom-model dialogs. Model and effort now use separate controls; the grouped model menu keeps Add model at the bottom across locales, themes, narrow windows and keyboard navigation.

- Fixed the assistant's empty model control to show Configure model with setup guidance and open Settings → Models directly. Configured models restore the list, with keyboard and English/Chinese support.

- Fixed concurrent user model writes with a cross-window lock and prevented open-source windows from replacing hidden system models. Stale catalogue results no longer change a form after switching sources or reopening the editor.

- Added a user model settings page with add, edit, delete and default actions across workspaces and SecretStorage for third-party keys. Open-source Studio offers third-party models; host extensions may supply a system AI catalogue. The assistant opens available choices before model settings.
- Studio Control is embedded as the Assistant’s `studio-control` Workflow entry alongside the default `main` conversation, sharing one projectId, dependencies and distribution. Assistant calls the entry on demand while preserving tool approval, per-run permissions and authenticated connection revocation. Removed the independent control project and installation.

- Fixed remote entry configuration and upload revision queries using an unavailable Server API path. Requests preserve entry selection, cancellation and configuration conflict codes.

- Breaking: the project tree exposes aggregate entries in separate native tabs sharing one host. The host is released after its last tab closes. Entry resources use independently approved database spaces; host pages manage requests, approval and sharing. Transfers include the complete aggregate.

- Fixed the Assistant permission shortcut to open the Permissions category in user settings, reusing the existing settings tab. Sidebar and standalone tool shortcuts now work independently of the conversation lifecycle.

- Parameter `userSetting` bindings support fixed user policies or user defaults with project overrides. Fixed controls show the actual policy and open user settings; editable controls retain the three original choices. Reset restores inheritance without persisting the displayed value as an override; active work keeps its snapshot.

- Added a Permissions settings category with Read only, Workspace, and Auto approve cards, defaulting to Auto approve. The user-only preference supports search, reset, and English/Chinese labels. Capability-negotiated updates reach open projects and the assistant, including startup and reconnect changes, and take effect after active work finishes and the session is idle.

- Ordinary projects now start with older installed CLIs without the “AI connection requires the assistant surface” error. An optional host protocol preserves system AI for capable CLIs, including account refresh and logout. Older CLIs retain project authentication and local features, while Assistant keeps its independent AI connection.

- Fixed non-versioned Windows background updates by passing extended-length paths to the helper and providing a pinned, checksum-verified compatible updater cache.

- Fixed Windows per-user installation and background updates for deeply nested dependency paths, avoiding installation rollback when Copilot runtime files exceed the legacy path limit.

- New Workflow, Conversation and Kanban projects apply for a Server ID using the current account before generating local files, without uploading source. Failed allocation or account changes create no project files; installation and validation retries do not allocate again. Uploading an unregistered project guides users to reapply first.

- Fixed new projects failing validation after a successful install by matching untouched templates to the installed SDK API. Installation and validation now show separate status and diagnostics, and retries skip successful installation. Workflow, Conversation, and Kanban apply for Server IDs before creating private personal projects without uploading source; installation or validation failure preserves local source. Setup logs persist as files with native tab path and reveal actions. Fixed the Harness version field on Start.

- [Improved] Place the enhanced badge beside the Start page title and remove its refresh button. The bottom-left gear opens Studio Settings directly.

- Fixed Server storage setup guidance for local Kanban, Workflow and Conversation projects, including the Server address, project ID, account settings, upload dialog and read-only rechecks. History, drafts and Stop remain available; no projects are created or uploaded automatically. Missing Kanban endpoints no longer suggest another upload when the project already exists.

- Fixed: The default project Server follows the build channel: local services for dev and the corresponding site for alpha and main. User-configured addresses retain priority.

- [Fixed] Conversation and Assistant file cards now use the active VS Code file icon theme to match Explorer file and named-folder icons, refreshing on theme changes while ignoring stale responses.

- Improvement: File path cards in Conversation and Assistant can be opened with a click. Documents use Studio previews, code uses the editor, and folders open in the system file manager. Cards show icons for common file types and report missing paths.

- [Fixed] Conversation and Assistant file menus now offer native file and folder selection, preserving original paths and sharing the same path cards and Core Agent context as drag and drop.

- [Improved] Use native VS Code tabs and context menus for Steam tool instances, including file previews, pinning, splitting and close actions. Tool categories offer Close, Close Others and Close All. Each tool keeps its own editor groups, content and selection across mode switches and reloads; closing the terminal category retains its sessions.

- [Fixed] Desktop and Web startup now check incremental build inputs after applying kernel patches, rebuilding changed sources even when the upstream commit is unchanged so features such as file drops no longer keep using an old workbench after restart.

- Added native Conversation drag and drop for VS Code files and folders and desktop folders, preserving real paths for CLI Web display and submission.

- Changed Server projects to use effective project and group access. First uploads select an owning group, published downloads require guest access, uploads require developer access and permission errors are localized.

- Fix: Assistant startup retries immediately show progress and a spinner, prevent duplicate clicks, and display the original reason if retry fails before allowing another attempt.


- [Improved] Steam tools initially occupy one third of the window. Manually resized widths are saved per workspace and restored after hiding, mode switches and reloads; temporary window constraints preserve the preferred width.

- Added configuration permission queries, recipient previews and author draft management through Studio Control with read-only enforcement; local RPC uses the current account and publishing checks the draft revision.

- [Fixed] Keep Steam project configurations, field editors, rename and project information dialogs clear of native window and mode controls. Close and configuration save actions remain accessible with menus or tools hidden, and in narrow or short windows.

- [Fixed] Keep the Assistant input and bottom controls accessible in short windows and with long drafts, in both the default tool and additional tabs.

- [Added] A native Editor tool in Steam with file tabs below the tool row and Explorer, Search and Source Control on its right. Resize the sidebar, create and save files, and retain native unsaved-file confirmation and document state across tools and IDE mode.

- [Improved] Remove duplicate Open Tools labels, place New on the left and keep only the tools visibility toggle on the right. Empty areas of project and tool headers drag the application window while controls, tabs and selectable text remain interactive.

- [Added] Rounded Steam tool tabs with truncated labels, add and close controls, and a trailing titlebar toggle for the tool area. Ten tools now include the terminal, browser and other projects on the right; sessions survive hiding tools and mode switches, and reload restores the selected tool editor and the original left-hand runtime.

- [Added] Use dynamic, closable tabs and an add-tool menu in the Steam tool workspace. Accounts, files, settings, diffs, and other editors open on the right while the project and its results stay on the left. Unsaved documents survive returning to IDE, and tool editors restore after reload.

- [Fixed] Recognize patches already included in the pinned upstream revision during startup preparation, avoiding false conflicts from overlapping patches while preserving staged and unstaged local edits.

- [Fixed] Keep IDE / Steam layout changes in the main window, restore maximized panels and editor groups, preserve tool placement preferences, ignore outdated startup failures, and handle skipped transition animations without unhandled errors.

- [Added] Share project configuration panels and local storage with the standalone CLI for all three project types. Studio Control can query, fully manage, import and export local or Server configurations with the panel closed, subject to project scope and read-only permissions.

### Opening Projects


### Project Avatars

- Fixed project creation failing when template dependencies used version ranges by bundling exact compatible versions.

### Pi Durable

- Move all durable Agent Tasks, Plan, Records and Usage capabilities into Trace while retaining its timeline, search and history. Add task details, child/fork navigation, versioned plan updates, compaction/reset and scoped cancellation. Follow the open conversation by default, inspect history independently, retain scroll/expansion/focus and disable offline actions, with bilingual themes and narrow layouts.

- Update the bundled assistant to enable durable recovery, Trace task views, queued input and steering, restricted subagents, plans, and parent/child usage. Studio Control connects lazily; Code Mode remains host opt-in, with the existing VS Code styling.

### New Features

- **Native Start workbench**: empty editor groups and a restorable Start tab share one entry offering new projects, offline examples, and system status.
- **Built-in Studio Analysis**: summarizes imported local projects, live run states, and histories with charts, trends, filtered tables, and CSV export.
- **Assistant slash commands**: `/plan` switches to plan mode, `/export` exports every session record, and `/compact` summarizes context immediately.
- **Projects open a window first**: new projects and examples open in a new Studio window where dependencies are installed.

### Breaking Changes

- Conversation always renders the standard message input and no longer accepts an enable setting or custom main fields, with attachments moved to `conversation.attachments`.
  Migration: drop the enable setting and custom main fields from the project manifest and declare attachments as `conversation.attachments`.

### Added

- Added a generic upload provider hook for optional checkboxes and post-upload actions, retaining successful transfer results when a follow-up action fails to prevent duplicate uploads.
- Added an upload button beside Run to publish local source as a Server project version.
- Added a Versions sidebar with history, release notes, uploader, related versions, and downloads.
- Added downloads into independent version folders under the default project location, with unique names for repeated downloads.

- Added a native Start workbench shared by the empty background and a restorable Start tab.
- Added three project starters and four offline examples to the Start workbench.
- Added install progress, cancellation, logs, retry, and opening a project in a new window.
- Added current and recent projects, system status, and Analysis, Assistant, Account, and Settings entries to the Start workbench.
- Added bilingual UI, theme switching, and narrow split layouts to the Start workbench.
- Added an Analysis dashboard summarizing imported local projects, live run states, and histories.
- Added charts, run trends, filterable detail tables, and CSV export to the Analysis dashboard.
- Added `/export` to the Assistant for exporting every session record.
- Added `/compact` to the Assistant to summarize context immediately and show execution states in the body.

### Changed

- Changed new project templates to declare their static project type explicitly and aligned the bundled Assistant and Studio Control with the project storage contract; Server uploads store source and data.
- Changed Untitled to use the native blank text editor. Double-clicking the editor background or empty tab strip no longer creates files; commands and shortcuts still do.
- Changed project and template pickers to reuse the same type icons while folders and workspaces keep their existing icons.
- Changed new projects and examples to share one creation dialog for type, template, name, and location.
- Changed the default location to `Documents/steamharness-projects` under the home directory.
- Changed creation to offer a new or current window before opening; cancelling generates no files.
- Changed dependencies to install in the target project window after it opens, keeping progress out of the dialog.
- Changed current projects to cards showing name, type, path, and Run.
- Changed reloading after a cancelled or failed install to no longer reinstall dependencies automatically.
- Changed Start workbench icons, labels, action buttons, and status rows to align consistently.
- Changed recent-project removal to appear on hover or keyboard focus while reserving its space to avoid layout shifts.
- Changed manual context summaries to cover all existing context and keep the original transcript on failure, truncation, or cancellation.
- Changed context summaries to report the model usage they consumed.
- Changed the Assistant permission trigger to open Read only, Workspace, and Auto approve in one click and close after selection.
- Changed Quick triggers to show icons and current selections, collapsing text from the right in narrow layouts and keeping full selections on hover.
- Changed the Assistant to default to Build, with a single `/plan` toggle and a Plan mode footer outside the input.
- Changed Conversation attachment capabilities to `conversation.attachments`, aligning the built-in Assistant and generator protocol.

### Fixed

- Fixed recent-project avatars touching their names on Start, with consistent spacing and label alignment for project avatars and folder icons.
- Fix profile image data URLs being discarded in Studio. Refresh avatars and names when returning to the window and periodically, preserving the active connection and ignoring stale refresh results.
- Fixed the Start logo moving above its title in narrow editor groups; the logo stays beside the title and actions wrap based on the editor width.
- Fixed transfers potentially uploading or downloading a prior selection through a new account after switching accounts during project selection, saves, or progress startup.
- Fixed the Versions view retaining the old project after changing its UUID in the same folder, and cancelled requests reporting invalid responses.
- Fixed isolated icons appearing during the first Start load by showing theme-aware skeletons and a loading indicator. Later refreshes keep existing content, and reduced motion disables animations.
- Fixed low-contrast icons in the Start workbench New Project and Run Project buttons by rendering them in white.
- Fixed stale Assistant inspections still opening a previous workspace's session after the active workspace changed.
- Fixed Assistant retries still reusing an invalid cached project after validation failed.
- Fixed analysis queries still returning removed projects when the workspace or imported project scope changed mid-query.
- Fixed rolling time filters in the Analysis dashboard stopping when history was unchanged.
- Fixed record timestamps in the Analysis dashboard missing the date and seconds.
- Fixed insufficient dark theme status text contrast in the Analysis dashboard.
- Fixed incomplete CSV formula prefix escaping in Analysis exports.

### Removed

- Removed the Assistant's Context parameter menu.
- Removed the submenu used by single-parameter Quick triggers.
