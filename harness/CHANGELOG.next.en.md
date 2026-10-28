# Unreleased

- Breaking: project identity, name, version and declarations now use independent `steamharness.json` files. Removed reads and writes of `package.json.id` and `steamHarness`. Aggregates explicitly register child entries whose configuration defines icons, declarations, database aliases and schedules. Unregistered configurations stay inactive, and transfers preserve the parent and child structure.

- Breaking: package entries now list database alias strings, with alias-to-ID mappings in root config.json. Core resolves aliases across multiple databases and shared consumers; hosts maintain permissions, distributions preserve ID references, and legacy fields are rejected.

- Default Conversation parameters now separate model and effort into independent Quick controls. User snapshots accept full host built-in catalogues while retaining the 100 custom-model limit and globally unique model IDs.

- Fixed automatic user model parameters to retain inheritance and direct calls to load explicitly selected project models. Connections and inherited permissions share one host snapshot, cached connections preserve developer model attributes and system search restrictions, and `inherit` remains a valid model ID.

- Added user model lists for connection-free Agent nodes and direct calls, explicit user/project sources, overridable model defaults, and enforced system AI authorization and source restrictions.
- Fixed concurrent database bindings overwriting other entry bindings or manifest fields. Database requests ignore forged approval metadata and binding references to protect other spaces and grants.

- Breaking: projects register entries/defaultEntry under one projectId, including multiple entries of the same type. Configuration and execution are isolated by entry; calls preserve identity and cancellation and recheck permissions.

- Parameter `userSetting` bindings support fixed user policies or user defaults with project overrides. Fixed controls show the actual policy and open user settings; editable controls retain the three original choices. Reset restores inheritance without persisting the displayed value as an override; active work keeps its snapshot.

- Added immutable, execution-scoped user settings through `getUserSettings`, `withUserSettings`, and host validation with `parseUserSettings`. Explicit `permissionPolicy: "inherit"` uses the user policy, falling back to `auto` without a host. Omitted policies still default to `workspace`; turn input takes precedence and tools share the resolved scope.

- Keep project deployment configuration in root config.json, centralizing database aliases and IDs; package entries declare only the aliases they use. STEAMHARNESS_PROJECT_CONFIG can override deployment values; migration updates one ID, permissions remain host-managed, and distributions retain authored values.
