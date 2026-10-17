const os = require('node:os');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');

// Release the root npm process before installing upstream's subdirectories.
if (process.platform === 'linux' && process.env.CI === 'true' &&
    process.env.STUDIO_CI_DEFER_POSTINSTALL === '1' && process.env.CI_PROJECT_DIR &&
    process.argv[1] && path.resolve(process.argv[1]) ===
      path.resolve(process.env.CI_PROJECT_DIR, 'upstream/vscode/build/npm/postinstall.ts')) {
  console.log('Deferring VS Code postinstall until root npm ci exits.');
  process.exit(0);
}

// Upstream derives npm install concurrency from os.cpus(), ignoring runner limits.
const cpus = os.cpus;
os.cpus = () => cpus().slice(0, 1);
syncBuiltinESMExports();
