import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAssistantProject } from '../extensions/studio-workstation/src/assistant-workspace.ts';

test('the assistant keeps every supported Studio Control tool and the template permission default', () => {
  const tools = ['studio_state', 'get_related_projects', 'get_diagnostics', 'open_file', 'set_theme', 'open_terminal', 'show_view']
    .map(name => ({ name: `workflow-studio_${name}`, enabled: true, autoApprove: true }));
  const target = { uri: 'file:///workspace', folderPath: '/workspace', name: 'Workspace' };
  for (const policy of ['auto', 'workspace', 'read-only']) {
    const field = { name: 'permissionPolicy', defaultValue: policy };
    const project = createAssistantProject({ fields: [field], tools: [...tools, { name: 'arbitrary_command' }] }, target, [target]);
    assert.deepEqual(project.tools, tools);
    assert.equal(project.requiresLogin, false, 'third-party Agent models work without a system AI login');
    assert.equal(project.fields[0].defaultValue, policy);
    assert.notEqual(project.fields[0], field);
    assert.equal(field.defaultValue, policy);
  }
});

test('assistant workspace adaptation retains slash modes and conditional footer declarations', () => {
  const target = { uri: 'file:///workspace', folderPath: '/workspace', name: 'Workspace' };
  const template = {
    fields: [{ name: 'agent', type: 'string', flag: '--agent', panel: 'slash', defaultValue: 'build',
      options: [{ value: 'build' }, { value: 'plan', command: 'plan' }] }],
    paramLayout: { actions: [{ kind: 'slash', name: 'agent' }] },
    conversation: { footer: [{ text: 'Plan mode', localizedText: { 'zh-CN': 'Plan 模式' },
      when: { param: 'agent', value: 'plan' } }] },
  };
  const project = createAssistantProject(template, target, [target]);
  assert.deepEqual(project.fields, template.fields);
  assert.deepEqual(project.paramLayout, template.paramLayout);
  assert.deepEqual(project.conversation, template.conversation);
  assert.equal(project.fields[0].defaultValue, 'build');
});
