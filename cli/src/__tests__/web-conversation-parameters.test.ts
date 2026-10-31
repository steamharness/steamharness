// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { ConversationSession, ParamState, Project } from '../web/workflow-types';
import { AGENT_MODELS_CONFIGURATION_FIELD, AGENT_MODELS_CONFIGURATION_KEY, createConfigurationState, applyConfigurationAction, type ProjectConfigurationState } from '@steamharness/project-configuration';

const host = vi.hoisted(() => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }));
vi.mock('../web/ui/host', () => ({ acquireProjectHost: () => host }));
const listeners: { target: EventTarget; type: string; listener: EventListenerOrEventListenerObject; options?: boolean | AddEventListenerOptions }[] = [];

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  for (const { target, type, listener, options } of listeners.splice(0)) target.removeEventListener(type, listener, options);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); document.body.replaceChildren();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
});

async function fixture({ dynamic = true, resolveOnInput = false, running = false, requiredModel = false, savedState }: {
  dynamic?: boolean; resolveOnInput?: boolean; running?: boolean; requiredModel?: boolean; savedState?: object;
} = {}) {
  vi.resetModules(); vi.useFakeTimers(); host.postMessage.mockReset(); host.getState.mockReturnValue(savedState); host.setState.mockReset();
  for (const target of [window, document]) {
    const add = target.addEventListener.bind(target);
    vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
      if (listener) listeners.push({ target, type, listener, options });
      add(type, listener, options);
    });
  }
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new Event('close')); } });
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector) {
    return selector === ':popover-open' ? false : matches.call(this, selector);
  });
  const frames = new Map<number, FrameRequestCallback>(); let frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const frame = () => { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(0); };
  document.body.innerHTML = '<div id="app"></div>';
  await import('../web/ui/main');
  const project: Project = {entryId:"main",aggregateName:"Test aggregate",defaultEntry:"main",entryRoot:'/parameters',databases:[],entries:[{entryId:"main",name:"Main",type:'conversation',root:".",entry:"index.ts",databases:[]}], id: 'parameters', uri: 'file:///parameters', folderPath: '/parameters', name: 'Parameters', projectType: 'conversation',
    fields: [
      { name: 'model', type: 'string', control: 'select', panel: 'auxiliary', resolveOnInput, required: requiredModel,
        options: requiredModel ? [] : [{ value: 'alpha', label: 'Alpha' }, { value: 'beta', label: 'Beta' }], defaultValue: requiredModel ? undefined : 'alpha' },
      { name: 'note', type: 'string', panel: 'auxiliary' },
      { name: 'mode', type: 'string', panel: 'mode', options: [{ value: 'build' }, { value: 'plan' }], defaultValue: 'build' },
    ],
    paramResolver: dynamic ? { enabled: true } : undefined,
    paramLayout: { actions: [
      { kind: 'quick', id: 'ai', label: 'Model', params: ['model'], summary: ['model'] },
      { kind: 'auxiliary', id: 'advanced', label: 'Advanced', params: ['note'] },
      { kind: 'mode', name: 'mode' }, { kind: 'slash', name: 'mode' },
    ] }, entrypoints: [], conversation: { inputQueue: { enabled: true } },
  };
  const sessions: ConversationSession[] = ['first', 'second'].map(id => ({ id, title: id, messages: [], createdAt: 1, updatedAt: 1 }));
  let state = { type: 'state', project, sessions, activeId: 'first', running, authenticationRevision: 1, parameterRevision: 1, serverInstanceId: 'instance', configurations: undefined as ProjectConfigurationState | undefined };
  const emit = (message: object) => window.dispatchEvent(new MessageEvent('message', { data: message }));
  host.postMessage.mockImplementation(message => {
    if (message.type === 'navigate') queueMicrotask(() => emit({ ...message, type: 'navigated', activeId: message.id }));
  });
  const receive = (patch: Partial<typeof state> = {}) => {
    state = { ...state, ...patch };
    if (patch.running !== undefined || running) {
      const session = state.sessions.find(session => session.id === state.activeId)!;
      session.activeRunId = state.running ? 'run' : undefined;
      session.messages = state.running ? [{ id: 'run', role: 'assistant', content: 'Working', status: 'running' }]
        : session.messages.map(message => message.status === 'running' ? { ...message, status: 'success' } : message);
    }
    emit(state); frame();
  };
  const requests = () => host.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === 'resolve');
  const reply = (params: Record<string, ParamState> = {}, request = requests().at(-1)!) => emit({ ...request, type: 'params', params });
  const input = document.querySelector<HTMLTextAreaElement>('#message')!;
  const type = (text: string) => { input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); };
  const loading = () => !document.querySelector<HTMLElement>('#parameter-status')!.hidden;
  const action = (id: string) => document.querySelector<HTMLButtonElement>(`[data-action-id="${id}"]`)!;
  receive();
  return { project, sessions, emit, receive, requests, reply, input, type, loading, action };
}

it('renders static parameters without a worker or loading state while typing and receiving run updates', async () => {
  const f = await fixture({ dynamic: false });
  expect(f.requests()).toHaveLength(0); expect(f.loading()).toBe(false);
  f.type('hello'); await vi.advanceTimersByTimeAsync(1000);
  f.receive({ running: true }); f.type('next turn'); await vi.advanceTimersByTimeAsync(1000);
  f.receive({ running: false });
  expect(f.requests()).toHaveLength(0); expect(f.loading()).toBe(false);
  expect(f.input.value).toBe('next turn');
});

it('keeps file selection and response retry available while typing saves the current draft', async () => {
  const f = await fixture(); f.reply();
  f.sessions[0].messages = [{ id: 'answer', role: 'assistant', content: 'Finished answer', status: 'success' }];
  f.receive(); f.input.focus();
  host.postMessage.mockImplementation(() => undefined);
  const attach = document.querySelector<HTMLButtonElement>('#attach')!;
  const retry = document.querySelector<HTMLButtonElement>('.retry-message')!;
  const icons = [attach.firstElementChild, retry.firstElementChild];
  for (const text of ['h', 'hello', 'hello 中文']) {
    f.type(text); await vi.advanceTimersByTimeAsync(300);
    const request = host.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === 'navigate').at(-1)!;
    expect(request.updates[0].draft.text).toBe(text);
    expect([attach.disabled, retry.disabled]).toEqual([false, false]);
    expect([attach.firstElementChild, retry.firstElementChild]).toEqual(icons);
    expect(document.activeElement).toBe(f.input); expect(f.input.value).toBe(text);
    f.emit({ type: 'navigated', requestId: request.requestId, activeId: request.id });
    expect([attach.disabled, retry.disabled]).toEqual([false, false]);
  }
  expect(f.requests()).toHaveLength(1); expect(f.loading()).toBe(false);
});

it('keeps waiting for an in-flight conversation switch when returning to the server conversation', async () => {
  const f = await fixture({ dynamic: false });
  for (const session of f.sessions) session.messages = [{ id: `answer-${session.id}`, role: 'assistant', content: 'Finished answer', status: 'success' }];
  f.receive(); host.postMessage.mockImplementation(() => undefined);
  const controls = () => [document.querySelector<HTMLButtonElement>('#attach')!.disabled,
    document.querySelector<HTMLButtonElement>('.retry-message')!.disabled];
  const navigation = () => host.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === 'navigate').at(-1)!;
  document.querySelector<HTMLButtonElement>('[data-session-id="second"]')!.click();
  const second = navigation(); expect(controls()).toEqual([true, true]);
  document.querySelector<HTMLButtonElement>('[data-session-id="first"]')!.click();
  expect(controls()).toEqual([true, true]);
  f.emit({ type: 'navigated', requestId: second.requestId, activeId: second.id });
  const first = navigation(); expect(first.id).toBe('first'); expect(controls()).toEqual([true, true]);
  f.emit({ type: 'navigated', requestId: first.requestId, activeId: first.id });
  expect(controls()).toEqual([false, false]);
});

it('sends consecutive inputs immediately while earlier submissions are still unconfirmed', async () => {
  const f = await fixture({ dynamic: false });
  const send = document.querySelector<HTMLButtonElement>('#send')!;
  for (const text of ['First request', 'Second request', 'Third request']) {
    f.type(text);
    expect(send.disabled).toBe(false); expect(send.querySelector('.codicon-loading')).toBeNull();
    expect(f.action('ai').disabled).toBe(false);
    send.click(); expect(f.input.value).toBe('');
  }
  const sent = host.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === 'send');
  expect(sent.map(message => message.text)).toEqual(['First request', 'Second request', 'Third request']);
  expect(new Set(sent.map(message => message.requestId)).size).toBe(3);
  expect(document.querySelectorAll('#input-queue .queued-input')).toHaveLength(2);
  expect(document.querySelector('#input-queue .codicon-loading')).toBeNull();
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector<HTMLButtonElement>('#attach')!.disabled).toBe(false);
});

it('sends a new stopped-conversation input directly and leaves the old paused queue intact', async () => {
  const f = await fixture({ dynamic: false });
  f.sessions[0].queuePaused = true;
  f.sessions[0].messages = [{ id: 'stopped', role: 'assistant', content: '', status: 'aborted' }];
  f.sessions[0].queuedInputs = [{ id: 'old', text: 'Wait for success', params: {}, attachments: [], createdAt: 1 }];
  f.receive(); f.type('New request'); document.querySelector<HTMLButtonElement>('#send')!.click();
  const calls = host.postMessage.mock.calls.map(([message]) => message);
  expect(calls.filter(message => message.type === 'send').map(message => message.text)).toEqual(['New request']);
  expect(calls.some(message => message.type === 'queue-run' || message.type === 'queue-promote')).toBe(false);
  expect(Array.from(document.querySelectorAll('#input-queue .queued-input')).map(row => (row as HTMLElement).dataset.id)).toEqual(['old']);
  expect(document.querySelector('#transcript .message.user')?.textContent).toContain('New request');
});

it.each(['queue-promote', 'queue-remove'] as const)('responds immediately to %s, restores errors and retries the same identity', async type => {
  const f = await fixture({ dynamic: false });
  f.sessions[0].queuePaused = true;
  f.sessions[0].queuedInputs = [{ id: 'queued', text: 'Queued input', params: {}, attachments: [], createdAt: 1 }];
  f.receive();
  const selector = type === 'queue-promote' ? '[aria-label="Send now"]' : '[aria-label="Withdraw input"]';
  document.querySelector<HTMLButtonElement>(`#input-queue ${selector}`)!.click();
  expect(document.querySelector('#input-queue .queued-input')).toBeNull();
  const request = host.postMessage.mock.calls.map(([message]) => message).find(message => message.type === type);
  expect(request).toMatchObject({ id: 'queued', sessionId: 'first' });
  f.receive(); expect(document.querySelector('#input-queue .queued-input')).toBeNull();
  f.emit({ ...request, type: 'error', requestType: type, message: 'Temporary failure' });
  expect(document.querySelector('#input-queue .queued-input-error')?.textContent).toBe('Temporary failure');
  document.querySelector<HTMLButtonElement>('#input-queue [aria-label="Retry"]')!.click();
  expect(document.querySelector('#input-queue .queued-input')).toBeNull();
  expect(host.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === type)).toEqual([request, request]);
});

it.each(['queue-promote', 'queue-remove'] as const)('handles unsent local %s while a new conversation is being created', async type => {
  const f = await fixture({ dynamic: false });
  f.project.conversation!.durable = { enabled: true };
  for (const session of f.sessions) session.messages = [{ role: 'user', content: 'Previous request' }];
  f.receive(); host.postMessage.mockImplementation(() => undefined);
  document.querySelector<HTMLButtonElement>('#new')!.click();
  const navigation = host.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === 'navigate').at(-1)!;
  f.type('First local'); document.querySelector<HTMLButtonElement>('#send')!.click();
  f.type('Second local'); document.querySelector<HTMLButtonElement>('#send')!.click();
  const row = document.querySelector<HTMLElement>('#input-queue .queued-input')!;
  expect(row).not.toBeNull();
  row.querySelector<HTMLButtonElement>(type === 'queue-promote' ? '[aria-label="Send now"]' : '[aria-label="Withdraw input"]')!.click();
  expect(document.querySelector('#input-queue .queued-input')).toBeNull();
  await Promise.resolve();
  f.emit({ type: 'navigated', requestId: navigation.requestId, activeId: navigation.id });
  const sends = host.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === 'send');
  expect(sends.map(message => message.text)).toEqual(type === 'queue-remove' ? ['First local'] : ['First local', 'Second local']);
  if (type === 'queue-promote') expect(sends[1].mode).toBe('steer');
  expect(host.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === type)).toEqual([]);
});

it('keeps ordinary Send now intent until admission so the host can interrupt the current run', async () => {
  const f = await fixture({ dynamic: false, running: true });
  f.type('Interrupt with this'); document.querySelector<HTMLButtonElement>('#send')!.click();
  const send = host.postMessage.mock.calls.map(([message]) => message).find(message => message.type === 'send');
  document.querySelector<HTMLButtonElement>('#input-queue [aria-label="Send now"]')!.click();
  expect(document.querySelector('#input-queue .queued-input')).toBeNull();
  expect(host.postMessage.mock.calls.some(([message]) => message.type === 'queue-promote')).toBe(false);
  f.emit({ type: 'sent', requestId: send.requestId, sessionId: 'first', projectUri: f.project.uri });
  expect(host.postMessage.mock.calls.map(([message]) => message).find(message => message.type === 'queue-promote')).toMatchObject({ id: send.requestId });
  expect(send.mode).toBe('followUp');
});

it('restores an optimistically withdrawn row when the host rejects message transport', async () => {
  const f = await fixture({ dynamic: false });
  f.sessions[0].queuedInputs = [{ id: 'retained', text: 'Retain this', params: {}, attachments: [], createdAt: 1 }];
  f.receive(); host.postMessage.mockImplementation(message => message.type === 'queue-remove' ? false : undefined);
  document.querySelector<HTMLButtonElement>('#input-queue [aria-label="Withdraw input"]')!.click();
  expect(document.querySelector('#input-queue .queued-input')).toBeNull();
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('#input-queue .queued-input-label')?.textContent).toBe('Retain this');
  expect(document.querySelector('#input-queue .queued-input-error')?.textContent).toContain('Message delivery was not confirmed');
});

it('shows the configured model name in the immediate reply and the persisted answer without reloading options', async () => {
  const f = await fixture();
  const id = '11111111-2222-4333-8444-555555555555';
  f.reply({ model: { value: id, resolvedOptions: [{ value: id, label: 'Configured AI model' }] } });
  f.type('Hello');
  document.querySelector<HTMLButtonElement>('#send')!.click();
  const sent = host.postMessage.mock.calls.map(([message]) => message).find(message => message.type === 'send');
  expect(sent.params.model).toBe(id);
  expect(document.querySelector('.message.assistant .message-metadata')?.textContent).toContain('Configured AI model');
  expect(document.querySelector('.message.assistant .message-metadata')?.textContent).not.toContain(id);
  f.sessions[0].messages = [
    { role: 'user', content: 'Hello' },
    { id: sent.requestId, role: 'assistant', content: 'Hi', status: 'success', model: 'Configured AI model' },
  ];
  f.receive({ sessions: [...f.sessions] });
  expect(document.querySelector('.message.assistant .message-metadata')?.textContent).toBe('Configured AI model');
  expect(f.requests()).toHaveLength(1);
});

it('keeps historical prose and model names visible after replacing the configured models and sending another turn', async () => {
  const f = await fixture(); f.reply({ model: { value: 'old', resolvedOptions: [{ value: 'old', label: 'Original model' }] } });
  const configurations = createConfigurationState([AGENT_MODELS_CONFIGURATION_FIELD], () => 'current');
  const original = { id: 'old-reply', role: 'assistant' as const, content: 'Original model response', status: 'success', model: 'Original model',
    items: [{ id: 'old-output', content: 'Original model response', contentType: 'markdown', collapsed: false }] };
  f.sessions[0].messages = [{ role: 'user', content: 'First input' }, original];
  f.receive({ configurations, sessions: [...f.sessions] });
  const updated = applyConfigurationAction(configurations, { action: 'save', revision: configurations.revision, id: 'current', values: {
    [AGENT_MODELS_CONFIGURATION_KEY]: [{ id: 'new', name: 'New model', source: 'system', credentialId: 'subscription', model: 'new-model' }],
  } }, () => crypto.randomUUID());
  f.receive({ configurations: updated, parameterRevision: 2 });
  f.reply({ model: { value: 'new', resolvedOptions: [{ value: 'new', label: 'New model' }] } });
  f.type('Next input'); document.querySelector<HTMLButtonElement>('#send')!.click();
  const sent = host.postMessage.mock.calls.map(([message]) => message).find(message => message.type === 'send');
  expect(sent.params.model).toBe('new');
  const messages = Array.from(document.querySelectorAll('.message.assistant'));
  expect(messages).toHaveLength(2);
  expect(messages[0].querySelector('.message-metadata')?.textContent).toBe('Original model');
  const prose = messages[0].querySelector('.message-output')!;
  expect(prose.textContent).toContain('Original model response'); expect(prose.querySelector('.conversation-process')).toBeNull();
  expect(messages[1].querySelector('.message-metadata')?.textContent).toContain('New model');
});

it('guides an empty Agent model list to the active configuration and preserves the message draft', async () => {
  const f=await fixture();f.reply({model:{value:null,resolvedOptions:[]}});
  const configurations=createConfigurationState([AGENT_MODELS_CONFIGURATION_FIELD],()=> 'current');
  f.sessions[0]={...f.sessions[0],messages:[{id:'failed',role:'assistant',content:'',status:'failed',error:'Add a model in Project configurations before running the Agent.'}]};
  f.receive({configurations,sessions:[...f.sessions]});f.type('Keep my message');
  expect(f.action('ai').textContent).toContain('Configure model');expect(f.action('ai').disabled).toBe(false);
  const errorAction=document.querySelector<HTMLButtonElement>('.configure-model-message')!;
  expect(errorAction.hidden).toBe(false);
  const feedback=errorAction.closest<HTMLElement>('.message-feedback')!;
  expect(feedback.hidden).toBe(false);expect(feedback.classList.contains('model-configuration-required')).toBe(true);
  expect(feedback.querySelector('.message-error')?.textContent).toBe(f.sessions[0].messages[0].error);
  expect(errorAction.closest('.message-actions')).toBeNull();
  expect(errorAction.getAttribute('aria-haspopup')).toBe('dialog');expect(errorAction.getAttribute('aria-controls')).toBe('project-information-dialog');
  f.action('ai').focus();f.action('ai').click();
  const request=host.postMessage.mock.calls.map(([message])=>message).find(message=>message.type==='project-configuration'&&message.call.action==='get');
  f.emit({type:'project-configuration-result',requestId:request.requestId,value:configurations});await Promise.resolve();
  const dialog=document.querySelector<HTMLDialogElement>('.project-information-dialog')!;
  expect(dialog.open).toBe(true);expect(document.querySelector<HTMLElement>('.configuration-body')!.hidden).toBe(false);
  expect(document.activeElement?.textContent).toBe('Add model');expect(f.input.value).toBe('Keep my message');
  dialog.close();expect(document.activeElement).toBe(f.action('ai'));
  errorAction.focus();errorAction.click();
  const errorRequest=host.postMessage.mock.calls.map(([message])=>message).filter(message=>message.type==='project-configuration'&&message.call.action==='get').at(-1)!;
  f.emit({type:'project-configuration-result',requestId:errorRequest.requestId,value:configurations});await Promise.resolve();
  expect(dialog.open).toBe(true);expect(document.activeElement?.textContent).toBe('Add model');expect(f.input.value).toBe('Keep my message');
  dialog.close();expect(document.activeElement).toBe(errorAction);
  const saved=applyConfigurationAction(configurations,{action:'save',id:'current',revision:configurations.revision,values:{[AGENT_MODELS_CONFIGURATION_KEY]:[
    {id:'saved',name:'Saved model',model:'example',source:'third-party',apiKind:'openai-completions',baseUrl:'https://models.example/v1',apiKey:'test-only-key'},
  ]}}, () => crypto.randomUUID());
  f.receive({configurations:saved,parameterRevision:2});f.reply({model:{value:'saved',resolvedOptions:[{value:'saved',label:'Saved model'}]}});
  expect(f.action('ai').textContent).toContain('Saved model');expect(errorAction.hidden).toBe(true);expect(f.input.value).toBe('Keep my message');
  expect(feedback.classList.contains('model-configuration-required')).toBe(false);
  expect(feedback.querySelector('.message-error')?.textContent).toBe(f.sessions[0].messages[0].error);
  f.sessions[0].messages=[{id:'failed',role:'assistant',content:'',status:'running',error:'Previous model error'}];
  f.receive({sessions:[...f.sessions]});
  expect(feedback.hidden).toBe(true);expect(errorAction.hidden).toBe(true);
});

it('opens user model settings directly for an empty list and keeps the draft when configured choices arrive', async () => {
  const f = await fixture({ requiredModel: true });
  const project = { ...f.project, fields: f.project.fields.map(field => field.name === 'model'
    ? { ...field, userSetting: { key: 'agent.model' as const, mode: 'default' as const }, userSettingValue: '' } : field) };
  f.receive({ project, parameterRevision: 2 });
  f.reply({ model: { resolvedOptions: [], disabled: true } });
  f.type('Keep my model setup draft');
  expect(f.action('ai').textContent).toContain('Configure model');
  expect(f.action('ai').title).toContain('No available models. Open Settings to add a model.');
  f.action('ai').click();
  expect(host.postMessage).toHaveBeenCalledWith({ type: 'open-user-setting', key: 'agent.model' });
  expect(document.querySelector<HTMLElement>('#parameter-popover')!.hidden).toBe(true);
  expect(f.input.value).toBe('Keep my model setup draft');
  f.receive({ project: { ...project, fields: project.fields.map(field => field.name === 'model' ? { ...field, userSettingValue: 'saved' } : field) }, parameterRevision: 3 });
  f.reply({ model: { resolvedOptions: [{ value: 'saved', label: 'Saved user model' }], disabled: false } });
  f.action('ai').click();
  expect(document.querySelector('[role=option]')?.textContent).toContain('Saved user model');
  expect(host.postMessage.mock.calls.filter(([message]) => message.type === 'open-user-setting')).toHaveLength(1);
  expect(f.input.value).toBe('Keep my model setup draft');
});

it('loads dynamic parameters once and reuses the per-conversation cache on navigation', async () => {
  const f = await fixture();
  expect(f.requests()).toHaveLength(1); expect(f.loading()).toBe(true);
  f.reply({ model: { resolvedOptions: [{ value: 'alpha', label: 'Cached Alpha' }, { value: 'beta' }] } });
  expect(f.loading()).toBe(false); expect(f.action('ai').textContent).toContain('Cached Alpha');
  f.type('draft'); await vi.advanceTimersByTimeAsync(1000);
  for (let index = 0; index < 4; index++) f.receive({ running: index < 3 });
  expect(f.requests()).toHaveLength(1);
  f.receive({ activeId: 'second' }); expect(f.requests()).toHaveLength(2);
  f.reply({ model: { resolvedOptions: [{ value: 'alpha', label: 'Second Alpha' }] } });
  f.receive({ activeId: 'first' });
  expect(f.requests()).toHaveLength(2); expect(f.loading()).toBe(false);
  expect(f.action('ai').textContent).toContain('Cached Alpha'); expect(f.input.value).toBe('draft');
});

it('coalesces edits, ignores stale replies and keeps cached menus and Slash commands usable during refresh', async () => {
  const f = await fixture(); f.reply();
  f.action('advanced').click();
  const note = document.querySelector<HTMLInputElement>('#param-note')!;
  const edit = async (value: string) => { note.value = value; note.dispatchEvent(new Event('input')); await vi.advanceTimersByTimeAsync(200); };
  await edit('one'); const old = f.requests().at(-1)!;
  await edit('two'); await edit('three');
  expect(f.requests()).toHaveLength(2); expect(f.loading()).toBe(false);
  expect(f.action('advanced').disabled).toBe(false); expect(f.action('mode').disabled).toBe(false);
  f.input.focus(); f.type('/plan'); f.input.setSelectionRange(5, 5); f.input.dispatchEvent(new Event('keyup'));
  expect(document.querySelector<HTMLElement>('#slash-menu')!.hidden).toBe(false);
  f.reply({ note: { value: 'obsolete' } }, old);
  expect(note.value).toBe('three'); expect(f.requests()).toHaveLength(3);
  expect(f.requests().at(-1)!.params.note).toBe('three');
  f.reply(); expect(f.loading()).toBe(false); expect(note.value).toBe('three');
});

it('only resolves opted-in input, debounces IME composition and pauses all background work during a run', async () => {
  const f = await fixture({ resolveOnInput: true }); f.reply();
  f.input.dispatchEvent(new CompositionEvent('compositionstart'));
  f.type('ni'); await vi.advanceTimersByTimeAsync(1000); expect(f.requests()).toHaveLength(1);
  f.input.dispatchEvent(new CompositionEvent('compositionend')); f.type('你好');
  await vi.advanceTimersByTimeAsync(349); expect(f.requests()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1); expect(f.requests()).toHaveLength(2); expect(f.loading()).toBe(false);
  const old = f.requests().at(-1)!;
  f.receive({ running: true }); f.type('next draft'); await vi.advanceTimersByTimeAsync(1000);
  f.receive({ parameterRevision: 2 });
  expect(f.requests()).toHaveLength(2); expect(f.loading()).toBe(false); expect(f.input.disabled).toBe(false);
  f.reply({ model: { value: 'beta' } }, old);
  f.receive({ running: false });
  expect(f.requests()).toHaveLength(3); expect(f.requests().at(-1)!.draftText).toBe('next draft');
  expect(f.requests().at(-1)!.params.model).toBe('alpha'); f.reply();
  expect(f.loading()).toBe(false); expect(f.input.value).toBe('next draft');
});

it('refreshes after configuration, identity, restart and reconnect changes without losing a parameter draft', async () => {
  const f = await fixture(); f.reply();
  f.action('advanced').click();
  const note = document.querySelector<HTMLInputElement>('#param-note')!;
  note.value = 'keep me'; note.dispatchEvent(new Event('input')); await vi.advanceTimersByTimeAsync(200); f.reply();
  for (const patch of [{ parameterRevision: 2 }, { authenticationRevision: 2 }, { serverInstanceId: 'replacement' }]) {
    const count = f.requests().length;
    f.receive(patch); expect(f.requests()).toHaveLength(count + 1); f.reply();
    expect(note.value).toBe('keep me'); expect(document.querySelector('#param-note')).toBe(note);
  }
  const count = f.requests().length;
  f.emit({ type: 'connection', status: 'reconnecting' }); f.emit({ type: 'connection', status: 'connected' });
  expect(f.requests()).toHaveLength(count + 1); f.reply(); expect(note.value).toBe('keep me');
});

it.each(['timeout', 'transport', 'host-rejection'])('ends %s failures, retains cached choices and supports explicit retry', async failure => {
  const f = await fixture(); f.reply();
  f.action('mode').click(); const request = f.requests().at(-1)!;
  if (failure === 'timeout') await vi.advanceTimersByTimeAsync(40_000);
  else if (failure === 'transport') f.emit({ type: 'error', requestType: 'resolve', requestId: request.requestId, sessionId: request.sessionId, message: 'Connection failed' });
  else {
    f.reply(); host.postMessage.mockImplementationOnce(() => Promise.reject(new Error('Host rejected')));
    f.action('mode').click(); await Promise.resolve();
  }
  expect(f.loading()).toBe(false); expect(document.querySelector<HTMLElement>('#parameter-error')!.hidden).toBe(false);
  const alert = document.querySelector<HTMLElement>('#parameter-error')!;
  alert.querySelector('button')!.click(); expect(alert.hidden).toBe(true);
  f.receive({ running: true }); expect(alert.hidden).toBe(true);
  expect(document.querySelector<HTMLButtonElement>('#refresh-params')!.title).toBe('Retry loading parameters');
  f.receive({ running: false });
  expect(f.action('advanced').disabled).toBe(false);
  const count = f.requests().length;
  document.querySelector<HTMLButtonElement>('#refresh-params')!.click(); expect(f.requests()).toHaveLength(count + 1);
  f.reply(); expect(document.querySelector<HTMLElement>('#parameter-error')!.hidden).toBe(true);
});

it('stops obsolete work on send, keeps the next draft and does not reload parameters throughout the run', async () => {
  const f = await fixture(); f.reply(); f.type('first turn');
  document.querySelector<HTMLButtonElement>('#send')!.click();
  const send = host.postMessage.mock.calls.map(([message]) => message).find(message => message.type === 'send')!;
  expect(send.text).toBe('first turn'); expect(send.params.model).toBe('alpha');
  f.emit({ ...send, type: 'sent' });
  f.sessions[0] = { ...f.sessions[0], messages: [{ id: send.requestId, role: 'assistant', content: 'Working', status: 'running' }] };
  f.receive({ sessions: [...f.sessions], running: true }); f.type('next turn'); await vi.advanceTimersByTimeAsync(1000);
  f.sessions[0].messages[0].status = 'success'; f.receive({ sessions: [...f.sessions], running: false });
  expect(f.requests()).toHaveLength(1); expect(f.loading()).toBe(false); expect(f.input.value).toBe('next turn');
});

it('retains a freshly validated model from the server until its options refresh after the run', async () => {
  const f = await fixture();
  f.reply({ model: { resolvedOptions: [{ value: 'alpha', label: 'Old model' }] } });
  f.sessions[0] = { ...f.sessions[0], parameterValues: { '': { model: 'beta' } } };
  f.receive({ sessions: [...f.sessions], running: true });
  expect(f.requests()).toHaveLength(1); expect(f.action('ai').textContent).toContain('beta');
  f.receive({ running: false }); expect(f.requests()).toHaveLength(2);
  expect(f.requests().at(-1)!.params.model).toBe('beta');
  f.reply({ model: { resolvedOptions: [{ value: 'beta', label: 'Current model' }] } });
  expect(f.action('ai').textContent).toContain('Current model'); expect(f.loading()).toBe(false);
});

it('offers a compact manual refresh that bypasses a valid cache without blocking parameter controls', async () => {
  const f = await fixture(); f.reply();
  const refresh = document.querySelector<HTMLButtonElement>('#refresh-params')!;
  expect(refresh.closest('.run-options')).not.toBeNull(); expect(refresh.hidden).toBe(false);
  refresh.click(); expect(f.requests()).toHaveLength(2);
  expect(f.loading()).toBe(false); expect(f.action('advanced').disabled).toBe(false);
  expect(refresh.classList.contains('refreshing')).toBe(false);
  f.reply({ model: { resolvedOptions: [{ value: 'alpha', label: 'New catalogue' }] } });
  expect(f.action('ai').textContent).toContain('New catalogue');
});

it('keeps pending parameter edits when switching conversations and applies newer accepted effects on return', async () => {
  const f = await fixture(); f.reply();
  f.sessions[0] = { ...f.sessions[0], parameterValues: { '': { note: 'saved' } } };
  f.receive({ sessions: [...f.sessions] }); f.reply();
  f.action('advanced').click();
  const note = document.querySelector<HTMLInputElement>('#param-note')!;
  note.value = 'unsaved draft'; note.dispatchEvent(new Event('input'));
  f.receive({ activeId: 'second' }); f.reply();
  f.receive({ activeId: 'first' });
  expect(f.requests().at(-1)!.params.note).toBe('unsaved draft');
  f.reply(); f.action('advanced').click();
  expect(document.querySelector<HTMLInputElement>('#param-note')!.value).toBe('unsaved draft');
  f.receive({ activeId: 'second' }); f.reply();
  f.sessions[0] = { ...f.sessions[0], parameterValues: { '': {} }, parameterRevisions: { '': { note: 'accepted-clear' } } };
  f.receive({ sessions: [...f.sessions], activeId: 'first' });
  expect(f.requests().at(-1)!.params.note).toBe('');
});

it('restores saved parameter edits without replacing them with server values after reopening', async () => {
  const key = 'file:///parameters:first:';
  const f = await fixture({ savedState: { params: { [key]: { model: 'beta', note: 'restored draft' } }, parameterEdits: { [key]: { model: null, note: null } } } });
  expect(f.requests()[0].params).toMatchObject({ model: 'beta', note: 'restored draft' }); f.reply();
  f.sessions[0] = { ...f.sessions[0], parameterValues: { '': { model: 'alpha', note: 'older server value' } } };
  f.receive({ sessions: [...f.sessions] });
  f.action('advanced').click();
  expect(document.querySelector<HTMLInputElement>('#param-note')!.value).toBe('restored draft');
  expect(f.action('ai').textContent).toContain('Beta');
  f.sessions[0] = { ...f.sessions[0], parameterValues: { '': { model: 'alpha' } }, parameterRevisions: { '': { note: 'new-effect' } } };
  f.receive({ sessions: [...f.sessions] });
  expect(document.querySelector<HTMLInputElement>('#param-note')!.value).toBe('');
  expect(f.requests().at(-1)!.params.model).toBe('beta');
});

it('clears a removed server value', async () => {
  const f = await fixture(); f.reply();
  f.sessions[0] = { ...f.sessions[0], parameterValues: { '': { note: 'saved' } } };
  f.receive({ sessions: [...f.sessions] }); f.reply();
  f.sessions[0] = { ...f.sessions[0], parameterValues: { '': {} } };
  f.receive({ sessions: [...f.sessions] });
  expect(f.requests().at(-1)!.params.note).toBe('');
});

it('protects a parameter reset from an older server value while other fields refresh', async () => {
  const f = await fixture(); f.reply();
  f.sessions[0] = { ...f.sessions[0], parameterValues: { '': { model: 'beta', note: 'saved' } } };
  f.receive({ sessions: [...f.sessions] }); f.reply();
  f.action('ai').click(); document.querySelector<HTMLButtonElement>('.quick-reset')!.click();
  expect(f.action('ai').textContent).toContain('Alpha');
  f.sessions[0] = { ...f.sessions[0], parameterValues: { '': { model: 'beta', note: 'remote update' } } };
  f.receive({ sessions: [...f.sessions] });
  expect(f.action('ai').textContent).toContain('Alpha');
});

it('releases obsolete background loading immediately when an edit returns to its cached value', async () => {
  const f = await fixture(); f.reply(); f.action('mode').click();
  const obsolete = f.requests().at(-1)!;
  f.action('mode').click();
  const refresh = document.querySelector<HTMLButtonElement>('#refresh-params')!;
  expect(f.requests()).toHaveLength(2); expect(refresh.disabled).toBe(false);
  f.reply({ mode: { value: 'plan' } }, obsolete);
  expect(f.action('mode').textContent).toContain('build');
  refresh.click(); expect(f.requests()).toHaveLength(3);
});

it.each(['pending', 'failed', 'dismissed'])('validates required dynamic defaults on send while initial loading is %s', async phase => {
  const f = await fixture({ requiredModel: true });
  const request = f.requests()[0];
  if (phase !== 'pending') f.emit({ ...request, type: 'params', error: 'Catalogue unavailable' });
  if (phase === 'dismissed') document.querySelector<HTMLButtonElement>('#parameter-error button')!.click();
  f.type('resolve defaults when sending');
  document.querySelector<HTMLButtonElement>('#send')!.click();
  const send = host.postMessage.mock.calls.map(([message]) => message).find(message => message.type === 'send');
  expect(send?.text).toBe('resolve defaults when sending');
  expect(f.loading()).toBe(false);
  f.reply({ model: { value: 'obsolete' } }, request);
  f.type('next draft');
  expect(f.input.value).toBe('next draft');
});

it('rebuilds changed parameter definitions after a service restart at the same project URI', async () => {
  const f = await fixture(); f.reply();
  const fields: Project['fields'] = [{ name: 'temperature', type: 'number', panel: 'auxiliary', defaultValue: '0.5' }];
  f.receive({ serverInstanceId: 'replacement', project: { ...f.project, fields, paramResolver: undefined,
    paramLayout: { actions: [{ kind: 'auxiliary', id: 'new-options', label: 'New options', params: ['temperature'] }] } } });
  expect(f.action('advanced')).toBeNull();
  f.action('new-options').click();
  expect(document.querySelector<HTMLInputElement>('#param-temperature')!.value).toBe('0.5');
  expect(f.requests()).toHaveLength(1); expect(f.loading()).toBe(false);
});

it('changes the parameter cache scope when an entrypoint is replaced with an identical definition', async () => {
  const f = await fixture(); f.reply();
  const parameters = { fields: f.project.fields, paramResolver: f.project.paramResolver, paramLayout: f.project.paramLayout };
  f.receive({ project: { ...f.project, projectType: 'workflow', entrypoints: [{ ...parameters, id: 'replacement' }] } });
  expect(f.requests()).toHaveLength(2); expect(f.requests().at(-1)!.entrypointId).toBe('replacement');
  f.reply();
  expect(host.setState.mock.calls.at(-1)![0].params['file:///parameters:first:replacement']).toBeDefined();
});

it('resumes a debounced parameter edit after a user-input prompt hides and restores the composer', async () => {
  const f = await fixture(); f.reply(); f.action('advanced').click();
  const note = document.querySelector<HTMLInputElement>('#param-note')!;
  note.value = 'pending edit'; note.dispatchEvent(new Event('input'));
  f.sessions[0] = { ...f.sessions[0], messages: [{ id: 'approval', role: 'assistant', content: '', status: 'waiting',
    pendingInput: { requestId: 'approval-input', nodeName: 'approval', title: 'Approval', params: [] } }] };
  f.receive({ sessions: [...f.sessions] });
  await vi.advanceTimersByTimeAsync(500);
  expect(f.requests()).toHaveLength(1);
  f.sessions[0] = { ...f.sessions[0], messages: [] }; f.receive({ sessions: [...f.sessions] });
  expect(f.requests()).toHaveLength(2); expect(f.requests().at(-1)!.params.note).toBe('pending edit');
});

it('persists user-default bindings as empty overrides while showing the current concrete option', async () => {
  const f = await fixture({ dynamic: false });
  const field = { name: 'permissionPolicy', flag: '--permission-policy', type: 'string', control: 'select', panel: 'quick',
    userSetting: { key: 'agent.permissionPolicy' as const, mode: 'default' as const }, userSettingValue: 'workspace',
    options: [{ value: 'read-only', label: 'Read only' }, { value: 'workspace', label: 'Workspace' }, { value: 'auto', label: 'Auto approve' }] };
  f.project.fields.push(field);
  f.project.paramLayout!.actions.push({ kind: 'quick', id: 'permission', label: 'Permission', params: ['permissionPolicy'], summary: ['permissionPolicy'] });
  f.receive(); expect(f.action('permission').textContent).toContain('Workspace');
  const savedValue = () => host.setState.mock.calls.at(-1)![0].params['file:///parameters:first:'].permissionPolicy;
  expect(savedValue()).toBe('');
  field.userSettingValue = 'auto'; f.receive({ parameterRevision: 2 });
  expect(f.action('permission').textContent).toContain('Auto approve'); expect(savedValue()).toBe('');
  f.action('permission').click();
  expect(document.querySelectorAll('#parameter-popover [role=option]')).toHaveLength(3);
  document.querySelector<HTMLButtonElement>('#parameter-popover [role=option]')!.click();
  expect(savedValue()).toBe('read-only');
  field.userSettingValue = 'workspace'; f.receive({ parameterRevision: 3 });
  expect(f.action('permission').textContent).toContain('Read only');
  f.action('permission').click(); document.querySelector<HTMLButtonElement>('.quick-reset')!.click();
  expect(savedValue()).toBe(''); expect(f.action('permission').textContent).toContain('Workspace');
  f.type('Use my default'); document.querySelector<HTMLButtonElement>('#send')!.click();
  const sent = host.postMessage.mock.calls.map(([message]) => message).find(message => message.type === 'send');
  expect(sent.params.permissionPolicy).toBe('');
});

it('keeps fixed setting fields accessible and respects resolver visibility', async () => {
  const f = await fixture();
  f.project.fields.push({ name: 'access', type: 'string', panel: 'auxiliary', label: 'Permission',
    userSetting: { key: 'agent.permissionPolicy', mode: 'fixed' }, userSettingValue: 'auto' });
  const advanced = f.project.paramLayout!.actions.find(action => action.kind === 'auxiliary')!;
  if (advanced.kind !== 'auxiliary') throw new Error('Expected auxiliary group');
  advanced.params.push('access'); f.receive();
  f.reply({ access: { visible: true } }); f.action('advanced').click();
  const root = document.querySelector<HTMLElement>('[data-param=access]')!;
  const note = document.querySelector<HTMLInputElement>('[data-param=note] input')!;
  note.value = 'hide'; note.dispatchEvent(new Event('change'));
  f.reply({ access: { visible: false } });
  expect(root.hidden).toBe(true);
  note.value = 'show'; note.dispatchEvent(new Event('change'));
  f.reply({ access: { visible: true } });
  expect(root.hidden).toBe(false);
  const button = root.querySelector<HTMLButtonElement>('button')!;
  expect(root.querySelector('label')!.control).toBe(button);
  button.click(); expect(host.postMessage).toHaveBeenCalledWith({ type: 'open-user-setting', key: 'agent.permissionPolicy' });
});
