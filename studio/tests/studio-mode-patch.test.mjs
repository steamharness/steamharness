import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ROOT, applyPatches } from '../scripts/distribution.mjs';
import { kernelLock } from './helpers/kernel-lock.mjs';

test('the workspace-mode series and the current launchpad replay twice without changing the index', async t => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'studio-mode-patch-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const names = ['0035-studio-workspace-modes.patch', '0036-studio-webview-focus.patch', '0037-studio-steam-workspace-tabs.patch', '0038-studio-steam-group-lifecycle.patch', '0039-studio-steam-tools.patch', '0040-studio-steam-window-chrome.patch', '0041-studio-steam-tool-instances.patch', '0042-studio-steam-header-drag.patch', '0043-studio-steam-tab-navigation.patch', '0044-studio-steam-tab-actions.patch', '0045-studio-steam-editor.patch', '0046-studio-steam-tools-width.patch', '0047-studio-steam-tab-hierarchy.patch', '0048-studio-mode-motion.patch', '0049-studio-mode-transition-cancellation.patch', '0050-studio-conversation-file-drop.patch', '0051-studio-steam-native-tool-tabs.patch', '0053-studio-mode-panel-state.patch', '0054-studio-settings.patch', '0055-studio-account-onboarding.patch', '0056-studio-settings-display-language.patch', '0057-studio-language-command-service-lifetime.patch', '0058-studio-source-native-localization.patch', '0059-studio-login-tab.patch', '0066-studio-database-workspace.patch'];
  const upstream = await kernelLock();
  names.push('0072-studio-project-release.patch', '0074-studio-release-window.patch', '0075-studio-steam-header-alignment.patch', '0076-studio-release-startup.patch', '0077-studio-mode-render-lifecycle.patch', '0079-studio-narrow-titlebar.patch');
  const original = '11b3b07389b574d902939189a115cd91f6f69b2b'; // 0079, before independent fork edits to the host files.
  const fromFork = args => execFileSync('git', args, { cwd: upstream.directory, stdio: ['ignore', 'pipe', 'pipe'] });
  let historical = true;
  try { fromFork(['cat-file', '-e', `${original}^{tree}`]); } catch { historical = false; }
  const launchpad = ['0093-studio-agent-library.patch', '0094-studio-launchpad-social-and-chat.patch', '0095-studio-library-project-details.patch', '0096-studio-launchpad-library-actions.patch', '0097-studio-launchpad-friends-profile.patch', '0098-studio-launchpad-command-center.patch', '0099-studio-store-listing-details.patch', '0100-studio-launchpad-refresh-social.patch', '0101-studio-launchpad-icon-contrast.patch', '0103-studio-launchpad-back-icon-alignment.patch'];
  for (const [group, series, commit] of [['mode-files', names, undefined], ...(historical ? [['modes', names, original]] : []), ['launchpad', launchpad, upstream.commit]]) {
    const root = path.join(fixture, group), kernel = path.join(root, 'vscode'), patches = [], paths = new Set();
    await mkdir(kernel, { recursive: true }); await mkdir(path.join(root, 'patches'));
    const git = args => execFileSync('git', args, { cwd: kernel, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git(['init', '-q']);
    for (const name of series) {
      let patch = await readFile(path.join(ROOT, 'patches', name), 'utf8');
      if (!commit) {
        // Depth-one installs can still replay the full lifetime of files created in this series from an empty tree.
        patch = patch.split(/(?=^diff --git )/m).filter(part => {
          const file = /^diff --git a\/(\S+) b\//.exec(part)?.[1];
          if (file && part.includes('\nnew file mode ')) paths.add(file);
          return paths.has(file);
        }).join('');
      }
      if (!patch) continue;
      const dest = path.join(root, 'patches', name);
      await writeFile(dest, patch); patches.push(dest);
      for (const line of git(['apply', '--numstat', dest]).trim().split('\n')) paths.add(line.split('\t')[2]);
    }
    assert.ok(paths.size > 0);
    const bytes = () => Promise.all([...paths].map(file => readFile(path.join(kernel, file))));
    let expected;
    if (commit) {
      for (const file of paths) {
        await mkdir(path.dirname(path.join(kernel, file)), { recursive: true });
        await writeFile(path.join(kernel, file), fromFork(['show', `${commit}:${file}`]));
      }
      expected = await bytes();
      for (const patch of [...patches].reverse()) git(['apply', '--reverse', patch]);
    }
    git(['add', '--all']);
    git(['-c', 'user.name=Studio Test', '-c', 'user.email=studio@example.invalid', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(root, 'hooks')}`, 'commit', '--allow-empty', '-qm', 'fixture']);
    const index = git(['write-tree']);
    for (let n = 0; n < 2; ++n) {
      await applyPatches(root, kernel);
      const actual = await bytes();
      expected ??= actual;
      assert.deepEqual(actual, expected);
      assert.equal(git(['write-tree']), index);
    }
  }
});
