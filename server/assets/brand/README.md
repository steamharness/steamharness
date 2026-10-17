# SteamHarness Icon

This folder contains the canonical application icon for SteamHarness.

- `steamharness-icon.svg` is the canonical full-color app icon source.
- `steamharness-icon-mark.svg` is the transparent full-color mark for surfaces that already provide a container.
- `steamharness-icon-template.svg` is the single-color template mark for macOS menu bar, Windows tray, compact controls, and monochrome contexts.

Design intent for v5:

- Remove code brackets, terminal cues, and developer-only symbols.
- Express workflow as a soft continuous flow shape that reads like a friendly app icon.
- Use teal as the main consumer-facing brand color without a separate triangle marker.
- Keep the mark simple enough for favicon, dock, docs, and tray contexts.

Platform copies are derived from these files:

- Electron Desktop: `../desktop/build/` and `../desktop/src/renderer/public/brand/`.
- Server Web: `web/public/brand/`.
- Docs: `../docs/images/brand/`, including a wider wordmark logo for the Mintlify header.

When changing the icon, update this folder first and regenerate/copy the derived platform assets from the same source.
