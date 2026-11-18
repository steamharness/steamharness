import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function writeReleaseFixture(root, unit, version, { directory = 'guides/releases', enId = 'example' } = {}) {
  const draft = version === 'unreleased';
  const stem = draft ? version : `v${version}`;
  const files = [];
  for (const english of [false, true]) {
    const folder = path.join(root, english ? 'en' : '', directory, unit);
    await mkdir(folder, { recursive: true });
    const file = path.join(folder, `${stem}.mdx`);
    const entry = english ? `#### Fixed\n\n- Fixed a release issue. {/* note: ${enId} */}` : '#### 修复\n\n- 修复了发布问题。 {/* note: example */}';
    await writeFile(file, `---\ntitle: ${unit} ${stem}\n${draft ? 'draft: true\n' : ''}---\n\n# ${unit} ${stem}\n\n${entry}\n`);
    files.push(file);
  }
  return files;
}
