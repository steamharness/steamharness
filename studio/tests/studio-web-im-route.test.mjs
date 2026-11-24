import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readStudioWebImRoute, studioWebImTarget, studioWebImUrl } from '../upstream/vscode/src/vs/workbench/common/studioWebImRoute.ts';

test('IM addresses retain the current origin and contain only a durable target', () => {
  const launchpad = new URL('https://studio.example.test/workbench?launchpad=1&token=stale#existing');
  const targets = [studioWebImTarget('group_群&chat'), studioWebImTarget(undefined, 'bot.a-b'), studioWebImTarget(undefined, undefined, 'create-group')];
  const urls = targets.map(target => studioWebImUrl(launchpad, target));
  assert.deepEqual(urls.map(url => url.href), [
    'https://studio.example.test/workbench?im=chat&conversation_id=group_%E7%BE%A4%26chat',
    'https://studio.example.test/workbench?im=chat&user_id=bot.a-b',
    'https://studio.example.test/workbench?im=create-group',
  ]);
  assert.deepEqual(urls.map(url => readStudioWebImRoute(url.searchParams)), targets);
});

test('missing, mixed and malformed IM targets cannot open a conversation', () => {
  const parse = query => readStudioWebImRoute(new URLSearchParams(query));
  assert.equal(parse('folder=/project'), undefined);
  for (const query of ['im=chat', 'im=chat&user_id=a&conversation_id=b', 'im=chat&user_id=a&user_id=b',
    'im=chat&im=chat&conversation_id=a', 'im=chat&conversation_id=group_%00', 'im=chat&conversation_id=action:create-group',
    'im=chat&user_id=a/b', 'im=unknown', 'im=add-contact&conversation_id=b']) {
    assert.equal(parse(query), 'invalid', query);
  }
});
