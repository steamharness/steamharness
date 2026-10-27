# Unreleased

- Parameter `userSetting` bindings support fixed user policies or user defaults with project overrides. Fixed controls show the actual policy and open user settings; editable controls retain the three original choices. Reset restores inheritance without persisting the displayed value as an override; active work keeps its snapshot.

- Added immutable, execution-scoped user settings through `getUserSettings`, `withUserSettings`, and host validation with `parseUserSettings`. Explicit `permissionPolicy: "inherit"` uses the user policy, falling back to `auto` without a host. Omitted policies still default to `workspace`; turn input takes precedence and tools share the resolved scope.
