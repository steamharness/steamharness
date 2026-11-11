import { afterEach, expect, it, vi } from 'vitest';
import { WorkflowOutputPager } from '../web/ui/workflow-output-pager';
const views: WorkflowOutputPager[] = [];
afterEach(() => { for (const view of views.splice(0)) view.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function fixture() {
  vi.useFakeTimers();
  class Element {
    textContent = ''; hidden = false; disabled = false; type = ''; onclick?: () => void;
    children: Element[] = []; classList = { add() {} }; setAttribute() {} append(...values: Element[]) { this.children.push(...values); }
  }
  vi.stubGlobal('document', { createElement: () => new Element() });
  const root = new Element(), request = vi.fn(), render = vi.fn();
  const pager = new WorkflowOutputPager(root as unknown as HTMLElement, { request, render }); views.push(pager);
  const receive = (total: number, page: number, id = request.mock.calls.at(-1)![0].requestId, runId = 'run') => pager.receive({ runId, requestId: id, total, page, pageSize: 100, revision: total, items: [], files: [] });
  return { pager, root, request, render, receive };
}
it('follows new pages, keeps an older page while output arrives and ignores obsolete replies', async () => {
  const f = fixture();
  f.pager.update('run', 100, 100); await vi.advanceTimersByTimeAsync(100); f.receive(100, 1);
  f.pager.update('run', 101, 101); await vi.advanceTimersByTimeAsync(100); expect(f.request.mock.calls.at(-1)![0].page).toBeUndefined(); f.receive(101, 2);
  f.root.children[0].onclick!(); await vi.advanceTimersByTimeAsync(100); expect(f.request.mock.calls.at(-1)![0].page).toBe(1);
  const stale = f.request.mock.calls.at(-1)![0].requestId; f.receive(101, 1);
  f.pager.update('run', 201, 201); await vi.advanceTimersByTimeAsync(100);
  expect(f.request.mock.calls.at(-1)![0].page).toBe(1); expect(f.root.children[3].textContent).toContain('100');
  const count = f.render.mock.calls.length; f.receive(101, 1, stale); expect(f.render).toHaveBeenCalledTimes(count);
  f.receive(201, 1); f.root.children[3].onclick!(); await vi.advanceTimersByTimeAsync(100); expect(f.request.mock.calls.at(-1)![0].page).toBeUndefined();
  const oldRequest = f.request.mock.calls.at(-1)![0].requestId;
  f.pager.update('other', 201, 201); await vi.advanceTimersByTimeAsync(100); f.receive(201, 3, oldRequest); expect(f.render).toHaveBeenCalledTimes(count + 1);
});
it('preserves displayed content when a page read fails and allows retry', async () => {
  const f = fixture(); f.pager.update('run', 201, 1); await vi.advanceTimersByTimeAsync(100);
  f.pager.receive({ runId: 'run', requestId: f.request.mock.calls.at(-1)![0].requestId, error: 'Read failed' } as never);
  expect(f.root.children[4].textContent).toBe('Read failed'); expect(f.root.children[5].hidden).toBe(false); expect(f.render).not.toHaveBeenCalled();
  f.root.children[5].onclick!(); await vi.advanceTimersByTimeAsync(100); f.receive(201, 3); expect(f.render).toHaveBeenCalledOnce();
});

it('times out a lost transport response and ignores late replies until an explicit retry', async () => {
  const f = fixture(); f.pager.update('run', 1, 1); await vi.advanceTimersByTimeAsync(100);
  const requestId = f.request.mock.calls.at(-1)![0].requestId;
  await vi.advanceTimersByTimeAsync(15000);
  expect(f.root.hidden).toBe(false); expect(f.root.children[5].hidden).toBe(false);
  f.receive(1, 1, requestId); expect(f.render).not.toHaveBeenCalled();
  f.root.children[5].onclick!(); await vi.advanceTimersByTimeAsync(100); f.receive(1, 1);
  expect(f.render).toHaveBeenCalledOnce();
});
