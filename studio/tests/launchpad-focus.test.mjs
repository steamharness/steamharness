import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const kernel = fileURLToPath(new URL('../upstream/vscode/', import.meta.url));
const { outputFiles } = await build({ stdin: { resolveDir: kernel, contents: `
  export { registerWindow } from './src/vs/base/browser/dom.ts';
  export { ensureCodeWindow } from './src/vs/base/browser/window.ts';
  export { LaunchpadPicker } from './src/vs/workbench/browser/studioLaunchpadPicker.ts';
  export { LaunchpadProfile } from './src/vs/workbench/browser/studioLaunchpadProfile.ts';
  export { NativeWindow } from './src/vs/workbench/electron-browser/window.ts';` },
  tsconfig: `${kernel}src/tsconfig.json`, bundle: true, platform: 'browser', format: 'iife', globalName: 'studio', loader: { '.css': 'empty' }, write: false });

function fixture(t, isStudioLaunchpad) {
  const { window } = new JSDOM('', { runScripts: 'outside-only' });
  const { window: chat } = new JSDOM('');
  window.vscode = { process: { platform: 'darwin', type: 'renderer', env: {}, versions: {} } };
  Object.assign(window.performance, { mark() {}, clearMarks() {}, getEntriesByType: () => [] });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const studio = window.eval(`${outputFiles[0].text}\nstudio;`);
  studio.ensureCodeWindow(chat, 2);
  const registration = studio.registerWindow(chat);
  t.after(() => { registration.dispose(); chat.close(); window.close(); });

  let front = window;
  window.document.hasFocus = () => front === window;
  chat.document.hasFocus = () => front === chat;
  const requests = [];
  // The renderer's window.focus can fail to raise an Electron window, so also track the native fallback.
  window.focus = () => requests.push('browser:launchpad');
  chat.focus = () => requests.push('browser:chat');
  const hostService = { focus(target) { front = target; requests.push(target === window ? 'native:launchpad' : 'native:chat'); } };
  const nativeWindow = Object.assign(Object.create(studio.NativeWindow.prototype), {
    hostService, environmentService: {}, nativeEnvironmentService: { window: { isStudioLaunchpad } },
  });
  nativeWindow.enableWindowFocusOnElementFocus(window);
  return { ...studio, window, chat, hostService, requests };
}

test('a recent group chat update restores the row without raising the desktop launchpad', async t => {
  const { window, chat, hostService, requests, LaunchpadPicker, LaunchpadProfile } = fixture(t, true);
  const label = en => en;
  const opened = [];
  const profile = new LaunchpadProfile(label, { inbox(id) { opened.push(id); hostService.focus(chat); } }, () => {}, new LaunchpadPicker(label));
  t.after(() => profile.dispose());
  window.document.body.append(profile.element);
  const row = () => profile.element.querySelector('[data-key="chat:group-demo"]');
  const account = { signedIn: true, scopeKey: 'local-account' };
  const group = { id: 'group-demo', name: 'Team', group: true, preview: 'New message', unread: 1 };
  const update = unread => profile.update(true, true, account, { connection: 'connected', items: [{ ...group, unread }] }, [], false);

  update(1);
  const first = row();
  first.focus();
  first.click();
  await Promise.resolve().then(() => update(0));

  assert.deepEqual(opened, [group.id]);
  assert.notEqual(row(), first);
  assert.equal(window.document.activeElement, row(), 'the row is still the keyboard target when returning');
  assert.deepEqual(requests, ['native:chat']);
  assert.equal(chat.document.hasFocus(), true);

  hostService.focus(window);
  assert.equal(window.document.hasFocus(), true, 'an explicit switch back is still allowed');
  const input = chat.document.body.appendChild(window.document.createElement('input'));
  input.focus();
  assert.deepEqual(requests, ['native:chat', 'native:launchpad', 'browser:chat', 'native:chat']);
});

test('normal desktop workbenches keep cross-window focus transfer', t => {
  const { window, chat, hostService, requests } = fixture(t, false);
  const input = window.document.body.appendChild(window.document.createElement('input'));
  hostService.focus(chat);
  input.focus();
  assert.deepEqual(requests, ['native:chat', 'browser:launchpad', 'native:launchpad']);
});
