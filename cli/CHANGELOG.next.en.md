# Unreleased

- Added host user models, available-model choices and a Manage models action while retaining project configuration APIs. Updates apply at idle boundaries; keys stay out of page state, ordinary history and exports and are rehydrated only for matching model endpoints.

- Parameter `userSetting` bindings support fixed user policies or user defaults with project overrides. Fixed controls show the actual policy and open user settings; editable controls retain the three original choices. Reset restores inheritance without persisting the displayed value as an override; active work keeps its snapshot.

- Added initial host user permission snapshots and capability-negotiated updates to CLI Web. Durable sessions keep startup settings for active and background work, adopting updates at a safe idle boundary while preserving inheritance parameters, history, pending input, and request identities across remounts and recovery. Standalone CLI does not persist this setting yet.
