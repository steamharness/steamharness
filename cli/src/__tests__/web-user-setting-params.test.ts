import { expect, it } from 'vitest';
import { projectParamArgs, projectParamEffectiveValue, projectParamValue, projectWithUserSettings, validateProjectValues,
  type Field, type Project } from '../web/workflow-types';

it('keeps inheritance out of saved overrides and uses host values for display and validation', () => {
  const field: Field = { name: 'access', type: 'string', flag: '--access', required: true,
    userSetting: { key: 'agent.permissionPolicy', mode: 'default' }, options: [{ value: 'read-only' }, { value: 'auto' }] };
  const project = { fields: [field], entrypoints: [{ id: 'main', fields: [field] }] } as Project;
  const view = projectWithUserSettings(project, { agent: { permissionPolicy: 'read-only' } });
  expect(project.fields[0].userSettingValue).toBeUndefined();
  expect(view.entrypoints[0].fields[0].userSettingValue).toBe('read-only');
  const bound = view.fields[0];
  expect(projectParamValue(bound)).toBe(''); expect(projectParamValue(bound, 'inherit')).toBe('');
  expect(projectParamEffectiveValue(bound, '')).toBe('read-only');
  expect(projectParamArgs([bound], { access: '' })).toEqual([]);
  expect(() => validateProjectValues([bound], { access: '' })).not.toThrow();
  expect(projectParamArgs([bound], { access: 'auto' })).toEqual(['--access', 'auto']);
  bound.userSettingValue = 'auto'; expect(projectParamEffectiveValue(bound, 'read-only')).toBe('read-only');
  bound.userSetting!.mode = 'fixed';
  expect(projectParamValue(bound, 'read-only')).toBe('');
  expect(projectParamArgs([bound], { access: 'read-only' })).toEqual([]);
  expect(projectParamEffectiveValue(bound, 'read-only')).toBe('auto');
});
