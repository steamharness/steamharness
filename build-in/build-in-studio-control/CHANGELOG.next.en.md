# Unreleased

### Changes

- Declare the static Workflow project type for Server source validation.

### New Features

- **Runs as an ordinary Workflow**: Studio Control runs every entrypoint as an ordinary Workflow project in Studio and connects to the host automatically.
- **Standard VS Code MCP control plane**: exposes workspace state, file navigation, diagnostics, themes, terminals, and views, and surfaces standard MCP tools to the Assistant.
- **Related project lookup**: `get_related_projects` returns relation declarations, names, UUIDs, Studio import status, and directories.

### Added

- Added revalidation of imported project identities on every `get_related_projects` call.
- Added support for nested workspace projects, using the project directory as the default path.
- Added host connection revocation when the run page closes.

### Changed

- Changed path access to follow the run's Permission, allowing external local directories in auto mode and reporting the effective policy and scope in the state query.
- Changed controls to follow workspace trust and tool permissions, keep Build/Plan approvals for editor actions, and revoke loopback capabilities when the session closes.

### Fixed

- Fixed explicitly selected themes not using manual mode or updating workspace overrides, which reported success without a visible change.
- Fixed theme color-kind changes not being verified against a real host.
- Fixed MCP calls not falling back to the working directory when the related-project directory is omitted.
- Fixed invalid optional paths being silently ignored by MCP.
- Fixed the Studio Assistant losing control tools or template permission defaults.
- Fixed diagnostic queries not resolving symlinked paths.
- Fixed host availability not being rechecked after asynchronously opening a file.
