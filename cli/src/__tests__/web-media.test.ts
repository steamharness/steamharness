import { expect, it } from 'vitest';
import { mediaUrl } from '../web/ui/ui';
import type { Attachment } from '../web/workflow-types';

const file: Attachment = {
  id: `wf_${'a'.repeat(32)}`, name: 'generated.wav', mimeType: 'audio/wav', kind: 'file', storage: 'local',
  size: 1644, createdAt: '', path: '/storage/generated.wav', previewUrl: `/api/file/wf_${'a'.repeat(32)}?session=capability`,
};

it('resolves managed audio and video previews against the CLI page without losing the session', () => {
  const expected = `http://127.0.0.1:5000${file.previewUrl}`;
  expect(mediaUrl(file.path!, 'audio', [file], 'http://127.0.0.1:5000/')).toBe(expected);
  expect(mediaUrl(file.id, 'video', [file], 'http://127.0.0.1:5000/')).toBe(expected);
});

it('preserves public media URLs and matching data media while refusing active schemes and unresolved paths', () => {
  expect(mediaUrl('https://media.test/song.wav', 'audio', [], 'http://localhost/')).toBe('https://media.test/song.wav');
  expect(mediaUrl('data:audio/wav;base64,AAAA', 'audio', [], 'http://localhost/')).toBe('data:audio/wav;base64,AAAA');
  for (const source of ['/storage/local.wav', 'file:///storage/local.wav', 'javascript:alert(1)', 'data:text/html;base64,AAAA', 'data:video/mp4;base64,AAAA']) {
    expect(mediaUrl(source, 'audio', [], 'http://localhost/')).toBeUndefined();
  }
});
