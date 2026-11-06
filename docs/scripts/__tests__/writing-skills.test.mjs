import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('writing skills retain their pinned upstream payloads and dependencies', async () => {
  const root = path.resolve(import.meta.dirname, '../../.agents/skills');
  const manifest = JSON.parse(await readFile(path.join(root, 'UPSTREAM.json'), 'utf8'));
  const names = new Set(manifest.skills.map(skill => skill.name));
  assert.equal(names.size, 4);
  for (const skill of manifest.skills) {
    assert.match(skill.revision, /^[a-f0-9]{40}$/u);
    await access(path.join(root, skill.licenseFile));
    assert.ok(skill.files.some(file => file.path === 'SKILL.md'));
    for (const dependency of skill.dependencies ?? []) assert.ok(names.has(dependency), `Missing ${dependency}`);
    for (const file of skill.files) {
      const bytes = await readFile(path.join(root, skill.name, file.path));
      const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      assert.equal(blob, file.gitBlob, `${skill.name}/${file.path} differs from pinned upstream`);
    }
  }
  assert.equal(manifest.skills.find(skill => skill.name === 'humanize-chinese').revision, '18516887e788fc9e03e10ff330c61fae4be0f676');
});
