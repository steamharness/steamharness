import { afterEach, expect, it, vi } from 'vitest';
import { activityRecord, activityRecordFiles, renderActivityRecord } from '../web/ui/activity-record';
import type { OutputItem } from '../web/workflow-types';
afterEach(() => vi.unstubAllGlobals());
it('recognizes versioned record payloads and rejects malformed data safely', () => {
  const item: OutputItem = { id: 'frame', contentType: 'json', metadata: { kind: 'activity-record' }, content: { version: 1, kind: 'snapshot', title: '画面', timestamp: '2026-11-12T12:00:00Z', fields: [{ label: '窗口', value: 'Doc' }], text: '<script>bad</script>' } };
  expect(activityRecord(item)?.kind).toBe('snapshot');
  expect(activityRecord({ ...item, content: { ...item.content as object, fields: [null] } })).toBeUndefined();
  expect(activityRecord({ ...item, content: { ...item.content as object, text: {} } })).toBeUndefined();
});
it('keeps record text separate from its image and opens the same image in preview', () => {
  class Element extends EventTarget {
    constructor(readonly tagName: string) { super(); }
    className = ''; textContent = ''; dataset = {}; children: Element[] = [];
    classList = { add: (name: string) => { this.className += ` ${name}`; } };
    setAttribute() {} append(...children: Element[]) { this.children.push(...children); }
  }
  vi.stubGlobal('document', { createElement: (tag: string) => new Element(tag), documentElement: { lang: 'en' } });
  vi.stubGlobal('location', { href: 'https://localhost/workflow/' });
  const image = vi.fn();
  const root = renderActivityRecord({ version: 1, kind: 'click', title: 'Click', timestamp: '2026-11-12T12:00:00Z', summary: 'Save button', imageFileId: 'wf_click' }, [{ id: 'wf_click', previewUrl: '/image/click' }] as never, { image, copy() {} }) as unknown as Element;
  const body = root.children[1], [description, media] = body.children;
  expect(body.className).toContain('has-image');
  expect(description.children[0].textContent).toBe('Save button');
  expect(media.tagName).toBe('figure'); expect(media.children[0].tagName).toBe('img');
  media.children[0].dispatchEvent(new Event('click'));
  expect(image).toHaveBeenCalledWith('https://localhost/image/click', 'Click');
});
it('uses only the referenced image for record view invalidation', () => {
  const item: OutputItem = { content: { version: 1, kind: 'snapshot', title: '画面', timestamp: 'now', imageFileId: 'wf_frame' }, metadata: { kind: 'activity-record' } };
  const files = [{ id: 'wf_frame' }, { id: 'wf_other' }] as never;
  expect(activityRecordFiles(item, files).map(file => file.id)).toEqual(['wf_frame']);
});
