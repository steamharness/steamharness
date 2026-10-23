import { afterEach, expect, it, vi } from 'vitest';
import { ConversationController } from '../web/conversation-controller';
import { ConversationState } from '../web/conversation-state';
import { conversationModelName, type ConversationQueuedInput, type Project, type Runtime } from '../web/workflow-types';

const controllers: ConversationController[] = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose(); });

function fixture() {
  const project: Project = { id: 'model-names', uri: '', folderPath: '/fixture', name: 'Agent', projectType: 'conversation', entrypoints: [],
    fields: [{ name: 'model', flag: '--model', type: 'string', options: [{ value: 'configuration-id', label: 'Original model' }] }] };
  const runtime = { run: vi.fn(async () => ({ status: 'success' })), cancel: vi.fn() } as unknown as Runtime;
  const options = { save: vi.fn(async () => {}), changed: vi.fn(), log: vi.fn() };
  const controller = new ConversationController(project, runtime, {}, options); controllers.push(controller);
  return { controller, runtime, options };
}

function input(name = 'System model'): Omit<ConversationQueuedInput, 'id' | 'createdAt'> {
  return { text: 'Hello', params: { model: 'configuration-id' }, attachments: [],
    states: { model: { resolvedOptions: [{ value: 'configuration-id', label: name, description: 'actual-model-id' }] } } };
}

it('captures the resolved display name while passing the selection ID to execution, then preserves each turn across changes and reopening', async () => {
  const { controller, runtime, options } = fixture();
  const firstInput = input();
  await controller.send(firstInput); await controller.idle();
  const first = controller.current.messages[1];
  expect(first.model).toBe('System model');
  expect(runtime.run).toHaveBeenCalledWith(expect.objectContaining({ args: ['--model', 'configuration-id', '--message', 'Hello'] }), expect.any(Function));
  await controller.send(input('Third-party model')); await controller.idle();
  expect(controller.current.messages[3].model).toBe('Third-party model');
  expect(first.model).toBe('System model');
  controller.project.fields[0].options = [{ value: 'configuration-id', label: 'Renamed model' }];
  firstInput.states!.model.resolvedOptions![0].label = 'Changed later';
  const restored = new ConversationController(controller.project, runtime, JSON.parse(JSON.stringify({ sessions: controller.sessions })), options);
  controllers.push(restored);
  expect(restored.current.messages.filter(message => message.role === 'assistant').map(message => message.model)).toEqual(['System model', 'Third-party model']);
});

it('repairs historical selection IDs and missing follow-up names using only that turn’s saved options', () => {
  const { controller, runtime, options } = fixture();
  const session = controller.current;
  session.messages = [
    { role: 'user', content: 'First', input: input('Historical name') },
    { role: 'assistant', content: 'First answer', model: 'configuration-id' },
    { role: 'user', content: 'Next', input: input('Other historical name') },
    { role: 'assistant', content: 'Next answer' },
    { role: 'user', content: 'Legacy', input: { ...input(), states: undefined, params: { model: 'legacy-model' } } },
    { role: 'assistant', content: 'Legacy answer', model: 'legacy-model' },
  ];
  const restored = new ConversationController(controller.project, runtime, { sessions: [session] }, options); controllers.push(restored);
  const stored = JSON.stringify(restored.current);
  const projection = new ConversationState();
  for (const source of [restored.current, JSON.parse(stored)]) {
    expect(projection.sessions([source])[0].messages.filter(message => message.role === 'assistant').map(message => message.model)).toEqual(['Historical name', 'Other historical name', 'legacy-model']);
  }
  expect(JSON.stringify(restored.current)).toBe(stored);
  expect(runtime.run).not.toHaveBeenCalled();
});

it('uses entrypoint options and static defaults without requiring a resolver, retaining raw names for free text models', async () => {
  const { controller } = fixture();
  controller.project.entrypoints = [{ id: 'other', fields: [{ name: 'model', flag: '--model', type: 'string', defaultValue: 'entry-model',
    options: [{ value: 'entry-model', label: 'Entrypoint model' }] }] }];
  await controller.send({ text: 'Hello', entrypointId: 'other', params: {}, attachments: [] }); await controller.idle();
  expect(controller.current.messages[1].model).toBe('Entrypoint model');
  expect(conversationModelName({ params: { model: 'custom-model' } })).toBe('custom-model');
  expect(conversationModelName({ params: {} })).toBeUndefined();
});
