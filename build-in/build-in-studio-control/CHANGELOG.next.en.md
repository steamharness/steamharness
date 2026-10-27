# Unreleased

- Breaking: get_entries replaces related-project queries with the aggregate entry registry. Configuration operations carry entryId explicitly.

- Updated configuration tools to describe collection and profile capabilities, fixed modes and online role checks, including when the panel is closed.

- Added publication drafts, recipient previews and field permissions to configuration tools while preserving project scope, revision checks and read-only restrictions.

- [Added] Expose configuration query, management, import/export and panel tools with explicit project, storage, profile and revision targets. Configuration access works with the panel closed; read-only mode rejects mutations.

### Changes

- Declare the static Workflow project type for Server source validation.

### New Features

- **Runs as an ordinary Workflow**: Studio Control runs every entrypoint as an ordinary Workflow project in Studio and connects to the host automatically.
- **Standard VS Code MCP control plane**: exposes workspace state, file navigation, diagnostics, themes, terminals, and views, and surfaces standard MCP tools to the Assistant.

### Added

- Added support for nested workspace projects, using the project directory as the default path.
- Added host connection revocation when the run page closes.

### Changed

- Changed path access to follow the run's Permission, allowing external local directories in auto mode and reporting the effective policy and scope in the state query.
- Changed controls to follow workspace trust and tool permissions, keep Build/Plan approvals for editor actions, and revoke loopback capabilities when the session closes.

### Fixed

- Fixed explicitly selected themes not using manual mode or updating workspace overrides, which reported success without a visible change.
- Fixed theme color-kind changes not being verified against a real host.
- Fixed invalid optional paths being silently ignored by MCP.
- Fixed the Studio Assistant losing control tools or template permission defaults.
- Fixed diagnostic queries not resolving symlinked paths.
- Fixed host availability not being rechecked after asynchronously opening a file.
