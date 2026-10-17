require('./desktop-localization-preload.cjs');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

import(pathToFileURL(path.join(process.env.STUDIO_TEST_VSCODE_ROOT, 'out/main.js')).href);
