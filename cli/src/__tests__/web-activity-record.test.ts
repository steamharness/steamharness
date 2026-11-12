import { expect, it } from 'vitest';
import { activityRecord, activityRecordFiles } from '../web/ui/activity-record';
import type { OutputItem } from '../web/workflow-types';
it('recognizes versioned record payloads and rejects malformed data safely', () => {
  const item: OutputItem = { id: 'frame', contentType: 'json', metadata: { kind: 'activity-record' }, content: { version: 1, kind: 'snapshot', title: '画面', timestamp: '2026-11-12T12:00:00Z', fields: [{ label: '窗口', value: 'Doc' }], text: '<script>bad</script>' } };
  expect(activityRecord(item)?.kind).toBe('snapshot');
  expect(activityRecord({ ...item, content: { ...item.content as object, fields: [null] } })).toBeUndefined();
  expect(activityRecord({ ...item, content: { ...item.content as object, text: {} } })).toBeUndefined();
});
it('uses only the referenced image for record view invalidation', () => {
  const item: OutputItem = { content: { version: 1, kind: 'snapshot', title: '画面', timestamp: 'now', imageFileId: 'wf_frame' }, metadata: { kind: 'activity-record' } };
  const files = [{ id: 'wf_frame' }, { id: 'wf_other' }] as never;
  expect(activityRecordFiles(item, files).map(file => file.id)).toEqual(['wf_frame']);
});
