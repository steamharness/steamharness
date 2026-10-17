# Project Templates

The CLI owns `src/project-templates.ts` and `src/project-templates/`.
This snapshot makes standalone Studio builds independent of an adjacent source checkout.
After changing the CLI templates, run `node scripts/sync-project-templates.mjs` in Studio.
The extension build bundles this module and its assets into `dist/`.
