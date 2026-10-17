const assert = require('node:assert/strict');
const { symlink } = require('node:fs/promises');
const path = require('node:path');

async function main() {
  if (process.argv.includes('--version')) { console.log('10.15.1'); return; }
  assert.equal(process.argv[2], 'install');
  assert.ok(JSON.parse(process.env.STUDIO_START_TEST_PROJECT_DIRECTORIES).includes(process.cwd()));
  console.log(`Installing fixture dependencies in ${process.cwd()}`);
  await new Promise(resolve => setTimeout(resolve, 1_500));
  await symlink(process.env.STUDIO_START_TEST_NODE_MODULES, path.join(process.cwd(), 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  console.log('Fixture dependencies ready');
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
