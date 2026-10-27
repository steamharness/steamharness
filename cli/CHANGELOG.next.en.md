# Unreleased

- Fixed concurrent entry database bindings overwriting each other and database requests accepting another consumer's binding metadata. Corrected Kanban database API examples.

- Breaking: check, run, Web and MCP select registered entries. Web windows retain independent drafts and background tasks. Database access requires host requests, approval and binding. Removed related projects, dependency locks and combined publishing commands.

- Parameter `userSetting` bindings support fixed user policies or user defaults with project overrides. Fixed controls show the actual policy and open user settings; editable controls retain the three original choices. Reset restores inheritance without persisting the displayed value as an override; active work keeps its snapshot.

- Added initial host user permission snapshots and capability-negotiated updates to CLI Web. Durable sessions keep startup settings for active and background work, adopting updates at a safe idle boundary while preserving inheritance parameters, history, pending input, and request identities across remounts and recovery. Standalone CLI does not persist this setting yet.
