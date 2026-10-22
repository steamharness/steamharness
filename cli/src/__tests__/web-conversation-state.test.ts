import { describe, expect, it } from 'vitest';
import { ConversationState } from '../web/conversation-state';
import type { ConversationSession } from '../web/workflow-types';

describe('live conversation state', () => {
  const session = (events: Record<string, unknown>[]): ConversationSession => ({ id: 'session', title: 'Conversation', messages: [{ role: 'assistant', content: 'Answer', items: [{ id: 'item', content: 'Answer' }], events }] });

  it('preserves first start and latest end timings without replaying output or usage deltas', () => {
    const events: Record<string, unknown>[] = [
      { type: 'node_chunk', timestamp: 10, chunk: { type: 'output_item_start', item: { id: 'item', content: 'large output' } } },
      { type: 'node_chunk', timestamp: 20, chunk: { type: 'output_item_delta', itemId: 'item', delta: 'large output' } },
      { type: 'token_usage_updated', usage: { total: 5 } },
      { type: 'node_chunk', timestamp: 30, chunk: { type: 'output_item_end', itemId: 'item', result: 'large output' } },
    ];
    const source = session(events), projection = new ConversationState();
    const original = JSON.stringify(source);
    expect(projection.sessions([source])[0].messages[0].events).toEqual([
      { type: 'node_chunk', timestamp: 10, chunk: { type: 'output_item_start', itemId: 'item' } },
      { type: 'node_chunk', timestamp: 30, chunk: { type: 'output_item_end', itemId: 'item' } },
    ]);
    expect(JSON.stringify(source)).toBe(original);
    for (let time = 40; time < 100; ++time) events.push({ type: 'node_chunk', timestamp: time, chunk: { type: time % 2 ? 'output_item_end' : 'output_item_start', itemId: 'item' } });
    expect(projection.sessions([source])[0].messages[0].events).toEqual([
      { type: 'node_chunk', timestamp: 10, chunk: { type: 'output_item_start', itemId: 'item' } },
      { type: 'node_chunk', timestamp: 99, chunk: { type: 'output_item_end', itemId: 'item' } },
    ]);
    events.length = 0;
    events.push({ type: 'runtime_log', text: 'Resumed' });
    expect(projection.sessions([source])[0].messages[0].events).toEqual(events);
  });

  it('retains node details, logs and legacy output while removing duplicate report payloads', () => {
    const source = session([{ type: 'node_finished', executionId: 'node', input: 'Input only in event', output: 'node output', status: 'success' },
      { type: 'node_finished', executionId: 'unreported', output: 'unreported output' }]);
    const message = source.messages[0];
    message.report = { status: 'success', nodes: [{ executionId: 'node', output: 'node output' }], logs: 'Run log',
      result: { data: 'duplicate result' }, outputs: ['duplicate output'], output: { items: [{ content: 'legacy output' }] } };
    const projection = new ConversationState(), view = projection.sessions([source])[0].messages[0];
    expect(view.report).toMatchObject({ nodes: message.report.nodes, logs: 'Run log' });
    expect(view.report?.result).toBeUndefined(); expect(view.report?.outputs).toBeUndefined(); expect(view.report?.output).toBeUndefined();
    expect(view.events).toEqual([{ type: 'node_finished', executionId: 'node', input: 'Input only in event', status: 'success' },
      { type: 'node_finished', executionId: 'unreported', output: 'unreported output' }]);
    message.items = undefined;
    expect(projection.sessions([source])[0].messages[0].report?.output).toEqual(message.report.output);
    expect(message.report.result?.data).toBe('duplicate result');
  });

  it('keeps durable scheduling, controls and context outputs while sending turn output through messages once', () => {
    const source = session([]);
    source.agent = { version: 1, ownerId: 'owner', revision: 1, conversationId: 1, foreground: true, backgroundCount: 0, epoch: 0,
      configuration: { version: 1, model: 'test', provider: 'test', effort: '' }, prompt: { hash: 'prompt', version: 1 }, plan: { version: 1, items: [] },
      turns: [{ requestId: 'turn', conversationId: 1, prompt: 'Input', mode: 'followUp', status: 'placed', epoch: 0, items: [{ title: 'Answer', content: 'Answer' }] }],
      conversations: [{ id: 1, title: 'Conversation', background: false }], tasks: [], history: [], contexts: [], receipts: [], records: [], usage: [] };
    const view = new ConversationState().sessions([source])[0];
    expect(view.agent?.turns[0]).toMatchObject({ requestId: 'turn', status: 'placed', items: [] });
    expect(view.agent?.conversations).toEqual(source.agent.conversations);
    expect(view.messages[0].items).toEqual(source.messages[0].items);
    expect(source.agent.turns[0].items).toEqual([{ title: 'Answer', content: 'Answer' }]);
  });
});
