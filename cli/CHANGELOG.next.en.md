# Unreleased

- User model menus group built-in and custom models with direct choices and an Add model action at the bottom of standalone model controls. Model and effort can be selected independently while preserving custom project grouping, reset and source restrictions.

- Fixed empty user model controls to show Configure model with setup guidance and open model settings directly. Adding a model restores the selection list.

- Fixed grouped model menus to keep user model management available during loading and active work, preserved `inherit` as a model ID, and kept unrelated project output named `userSettings` intact during credential redaction. Kanban refreshes recheck current related imports so valid setup guidance survives a preview refresh and resolved errors stay hidden.

- Added host user models, available-model choices and a Manage models action while retaining project configuration APIs. Updates apply at idle boundaries; keys stay out of page state, ordinary history and exports and are rehydrated only for matching model endpoints.
- Fixed concurrent entry database bindings overwriting each other and database requests accepting another consumer's binding metadata. Corrected Kanban database API examples.

- Breaking: check, run, Web and MCP select registered entries. Web windows retain independent drafts and background tasks. Database access requires host requests, approval and binding. Removed related projects, dependency locks and combined publishing commands.

- Parameter `userSetting` bindings support fixed user policies or user defaults with project overrides. Fixed controls show the actual policy and open user settings; editable controls retain the three original choices. Reset restores inheritance without persisting the displayed value as an override; active work keeps its snapshot.

- Added initial host user permission snapshots and capability-negotiated updates to CLI Web. Durable sessions keep startup settings for active and background work, adopting updates at a safe idle boundary while preserving inheritance parameters, history, pending input, and request identities across remounts and recovery. Standalone CLI does not persist this setting yet.
