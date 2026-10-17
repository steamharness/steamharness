import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import path from "node:path";

const [root, channel] = process.argv.slice(2);
const readJson = async (file) => JSON.parse(await readFile(path.join(root, file), "utf8"));
const metadata = await readJson("runtime.json");
const manifest = await readJson("package.json");
const web = await readJson("web/package.json");
const build = await readJson("dist/build-info.json");
assert.equal(metadata.channel, channel);
if (metadata.platform) assert.equal(metadata.platform, "linux");
if (metadata.architecture) assert.equal(metadata.architecture, "x64");
assert.match(metadata.commitSha, /^[0-9a-f]{40}$/u);
assert.equal(metadata.version, manifest.version);
assert.equal(metadata.version, web.version);
assert.equal(metadata.version, build.productVersion);
assert.equal(metadata.commitSha, build.commitSha);
await access(path.join(root, "dist/index.js"));
await access(path.join(root, "public/index.html"));
// `public/embed.html` used to be asserted here; the public Embed is gone, so
// the release no longer contains it. Server Web's admin SPA is all that ships
// under `public/`.
await access(path.join(root, "node_modules/pg/package.json"));
