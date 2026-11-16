import { expect, it } from 'vitest';
import { readProjectDeclaration } from '../index';
import { readKanbanEntryConfig } from '../../kanban-project';

const source = (webApp: unknown, type = 'kanban') => ({ id: '00000000-0000-4000-8000-000000000001', name: 'Application', version: '1.0.0', defaultEntry: 'main', entries: [{ entryId: 'main', root: '.', type, ...(type === 'kanban' ? {} : { entry: 'index.ts' }), name: 'Application', webApp }] });
it('retains only an explicit Kanban service and supported permissions', () => {
  const declaration = readProjectDeclaration(source({ service: 'example.app', permissions: ['microphone'] }));
  expect(declaration.entries[0]!.webApp).toEqual({ service: 'example.app', permissions: ['microphone'] });
  expect(readKanbanEntryConfig(declaration.entries[0]!).webApp).toEqual(declaration.entries[0]!.webApp);
  expect(readProjectDeclaration(source(undefined)).entries[0]!.webApp).toBeUndefined();
});
it('rejects project-supplied service targets, credentials and unsupported capabilities', () => {
  for (const value of [{ service: 'https://example.com' }, { service: 'example.app', apiBaseUrl: 'https://example.com/api' }, { service: 'example.app', token: 'secret' }, { service: 'example.app', permissions: ['camera'] }, { service: 'example.app', permissions: ['microphone', 'microphone'] }]) expect(() => readProjectDeclaration(source(value))).toThrow();
  expect(() => readProjectDeclaration(source({ service: 'example.app' }, 'workflow'))).toThrow(/Kanban/);
});
