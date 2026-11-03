import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { i18n } from '@steamharness/i18n/react';
import { apiClient } from '../../api';
import { DatabaseSpacesPage } from '../DatabaseSpacesPage';
import { parseRoute, routeToPath } from '../../utils/routes';
import { createServerKnowledgeRepository } from '../detail/knowledge-repository';
const id = 'adbe104c-5528-4db6-817d-bb567996876f', hash = 'a'.repeat(64);
const ok = (data: unknown): any => ({ errCode: 0, errMessage: '', data });
const row = { values: { id: 'one', count: 1 }, rowVersion: '42' };
beforeEach(async () => {
  await i18n.changeLanguage('en');
  vi.spyOn(apiClient, 'resourceRequest').mockImplementation(async (_kind, endpoint, body: any) => {
    if (endpoint?.startsWith('?')) return ok({ items: [{ id, name: 'Memory' }], total: 1, pageSize: 20 });
    if (endpoint?.endsWith('/grants')) return ok([]);
    if (body?.operation === 'models') return ok({ models: [{ name: 'Counter', fields: [{ name: 'id', type: 'String', required: true }, { name: 'count', type: 'Int', required: true }], keyFields: ['id'] }], schemaHash: hash, mode: 'write' });
    if (body?.operation === 'rows') return ok({ items: [row], total: 1 });
    return ok({ schemaHash: hash, mode: 'write' });
  });
  vi.spyOn(apiClient, 'knowledgeOperation').mockResolvedValue(ok({ items: [], total: 0, hasMore: false }));
});
afterEach(() => vi.restoreAllMocks());
it('round trips independent resource routes and entry URLs', () => {
  const path = '/detail/project/entries/agent/configurations';
  expect(routeToPath(parseRoute(path))).toBe(path);
  expect(parseRoute('/databases/' + id)).toEqual({ page: 'databases', id });
  expect(parseRoute('/databases/knowledge%3A' + id)).toEqual({ page: 'databases', id: 'knowledge:' + id });
});
it('queries server pagination and filters and selects the resource kind', async () => {
  render(<DatabaseSpacesPage />);
  await screen.findByRole('button', { name: 'Memory' });
  fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'archive' } });
  await waitFor(() => expect(apiClient.resourceRequest).toHaveBeenLastCalledWith('databases', '?page=1&pageSize=20&search=archive', undefined, 'GET', expect.any(AbortSignal)));
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Knowledge bases' }), { button: 0, ctrlKey: false });
  await waitFor(() => expect(apiClient.resourceRequest).toHaveBeenLastCalledWith('knowledge-bases', '?page=1&pageSize=20&search=archive', undefined, 'GET', expect.any(AbortSignal)));
  expect(screen.queryByText('KV')).toBeNull();
});
it('preserves failed row drafts and sends the applied schema and optimistic row version', async () => {
  const request = vi.mocked(apiClient.resourceRequest), original = request.getMockImplementation()!;
  request.mockImplementation(async (...args) => (args[2] as any)?.operation === 'update' ? { errCode: 409, errMessage: 'This row changed' } as any : original(...args));
  render(<DatabaseSpacesPage spaceId={id} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('Row values (JSON)'), { target: { value: '{"id":"one","count":2}' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save row' }));
  expect(await screen.findByText('This row changed')).toBeTruthy();
  expect(screen.getByLabelText('Row values (JSON)')).toHaveValue('{"id":"one","count":2}');
  expect(request).toHaveBeenCalledWith('databases', `/${id}/data`, { operation: 'update', model: 'Counter', schemaHash: hash, data: { id: 'one', count: 2 }, key: { id: 'one' }, rowVersion: '42' }, 'POST', expect.any(AbortSignal));
});
it('protects a row draft before changing resource kinds', async () => {
  const onBack = vi.fn(); render(<DatabaseSpacesPage spaceId={id} onBack={onBack} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('Row values (JSON)'), { target: { value: '{"count":2}' } });
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Knowledge bases' }), { button: 0, ctrlKey: false });
  expect(await screen.findByRole('alertdialog')).toHaveTextContent('Discard unsaved changes?');
  expect(onBack).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByLabelText('Row values (JSON)')).toHaveValue('{"count":2}');
});
it('locks repeated mutations and deletes even when the discarded draft is invalid JSON', async () => {
  const request = vi.mocked(apiClient.resourceRequest), original = request.getMockImplementation()!;
  let finish!: (value: any) => void;
  request.mockImplementation((...args) => (args[2] as any)?.operation === 'delete' ? new Promise(resolve => { finish = resolve; }) : original(...args));
  render(<DatabaseSpacesPage spaceId={id} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('Row values (JSON)'), { target: { value: 'invalid' } });
  fireEvent.click(screen.getByRole('button', { name: 'Delete row' }));
  const confirm = await screen.findAllByRole('button', { name: 'Delete' });
  fireEvent.click(confirm[0]);
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(screen.getByRole('button', { name: 'Save row' })).toBeDisabled();
  await act(async () => finish(ok({ deleted: true })));
  await waitFor(() => expect(screen.queryByLabelText('Row values (JSON)')).toBeNull());
});
it('passes document versions and cancellation through the knowledge repository', async () => {
  const repository = createServerKnowledgeRepository(apiClient, id), signal = new AbortController().signal;
  await repository.getDocument('guide', { signal });
  expect(apiClient.knowledgeOperation).toHaveBeenCalledWith(id, 'knowledge.getDocument', { documentId: 'guide' }, signal);
  await repository.updateDocument('guide', { title: 'Changed', markdown: 'Shared', expectedRevision: 3 });
  expect(apiClient.knowledgeOperation).toHaveBeenLastCalledWith(id, 'knowledge.editDocument', { documentId: 'guide', title: 'Changed', markdown: 'Shared', expectedRevision: 3 }, undefined);
  await repository.deleteDocument('guide', { expectedRevision: 3 });
  expect(apiClient.knowledgeOperation).toHaveBeenLastCalledWith(id, 'knowledge.deleteDocument', { documentId: 'guide', expectedRevision: 3 }, undefined);
});
it('ignores an old catalog reply after switching resource kinds', async () => {
  let finish!: (value: any) => void;
  vi.mocked(apiClient.resourceRequest).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<DatabaseSpacesPage />);
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Knowledge bases' }), { button: 0, ctrlKey: false });
  await screen.findByRole('button', { name: 'Memory' });
  await act(async () => finish(ok({ items: [{ id, name: 'Previous resource' }], total: 1 })));
  expect(screen.queryByText('Previous resource')).toBeNull();
});
