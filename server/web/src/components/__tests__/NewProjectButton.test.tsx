import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { i18n } from '@steamharness/i18n';
import { apiClient } from '../../api';
import { NewProjectButton } from '../NewProjectButton';

afterEach(() => vi.restoreAllMocks());

it.each(['en', 'zh-CN'])('uses the Server-assigned project ID in %s without selecting an ID in the browser', async language => {
  await i18n.changeLanguage(language);
  const id = '78648759-bcde-4fd5-b3bd-9a2dd46a7192', created = vi.fn();
  vi.spyOn(apiClient, 'listGroups').mockResolvedValue({ errCode: 0, errMessage: '', data: { items: [], total: 0, page: 1, pageSize: 100 } });
  const create = vi.spyOn(apiClient, 'createProject').mockResolvedValue({ errCode: 0, errMessage: '', data: { projectId: id } });
  render(<NewProjectButton onCreated={created} />);
  const label = i18n.t('accessCreateProject', { ns: 'serverWeb' });
  fireEvent.click(screen.getByRole('button', { name: label }));
  const dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText(i18n.t('projectSettingsDefaultName', { ns: 'serverWeb' })), { target: { value: 'New application' } });
  fireEvent.click(within(dialog).getByRole('button', { name: label }));
  await waitFor(() => expect(created).toHaveBeenCalledWith(id));
  expect(create).toHaveBeenCalledOnce();
  expect(create.mock.calls[0][0]).toMatchObject({ name: 'New application', entries:[{entryId:'main',type:'workflow',databases:[]}],defaultEntry:'main', groupId: null });
  expect(create.mock.calls[0][0]).not.toHaveProperty('projectId');
});
