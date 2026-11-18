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

Consumer assets are derived from these files:

- Docs: [`docs/images/brand/`](../../images/brand/).
- Server Web assets are maintained with the private Server implementation.

When changing the icon, update this folder first and coordinate the derived asset updates in each affected repository.
