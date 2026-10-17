import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../distribution.mjs';

const assistant = JSON.parse(await readFile(path.join(ROOT, 'vendor/developer-assistant/package.json'), 'utf8'));
const example = JSON.parse(await readFile(path.join(ROOT, 'examples/conversation/package.json'), 'utf8'));
const downloads = JSON.parse(await readFile(path.join(ROOT, 'config/downloads.json'), 'utf8'));
const directory = path.join(ROOT, '.studio/test-source/open-soucres/build-in/build-in-developer-assistant');
await mkdir(directory, { recursive: true });
// The vendored development manifest links to sibling repositories absent from a Studio CI checkout.
await writeFile(path.join(directory, 'package.json'), JSON.stringify({
  ...assistant,
  devDependencies: {
    ...assistant.devDependencies,
    'steamharness': example.devDependencies['steamharness'],
    '@steamharness/cli': example.devDependencies['@steamharness/cli'],
  },
}, null, 2) + '\n');
await writeFile(path.join(directory, '.npmrc'), [
  `registry=${process.env.STUDIO_TEST_REGISTRY ?? downloads.ciNpmMirror}`,
  '@steamharness:registry=https://registry.npmjs.org/',
].join('\n') + '\n');
