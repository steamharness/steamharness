// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Fields } from '../web/ui/workflow-fields';
import { InputPrompt } from '../web/ui/input-prompt';
import { validateProjectValues, type Field, type ParamValues } from '../web/workflow-types';

vi.mock('../web/ui/parameter-actions', () => ({ ParameterActions: class { render() {} update() {} close() {} } }));
afterEach(() => document.body.replaceChildren());
const field: Field = { name: 'threshold', type: 'number', label: 'Threshold', control: 'range', range: { min: 0, max: 1, step: 0.01 }, defaultValue: '0.8' };

it('shows an editable slider with its exact value, bounds and increment, and restores external changes', () => {
  const root = document.createElement('div'); document.body.append(root);
  const values: ParamValues = { threshold: '0.8' }; let disabled = false;
  const view = new Fields(root, document.createElement('div'), { values: () => values, states: () => ({}), disabled: () => disabled, loading: () => false, file() {}, change: (name, value) => { values[name] = value; view.update(); } });
  view.render({ fields: [field] });
  const input = root.querySelector<HTMLInputElement>('input[type=range]')!;
  expect([input.min, input.max, input.step, input.value]).toEqual(['0', '1', '0.01', '0.8']);
  expect(root.querySelector('output')?.textContent).toBe('0.8');
  input.value = '0.43'; input.dispatchEvent(new Event('input')); expect(values.threshold).toBe('0.43');
  expect(root.querySelector('output')?.textContent).toBe('0.43');
  values.threshold = '0'; view.update(); expect(input.value).toBe('0'); expect(root.querySelector('output')?.textContent).toBe('0');
  disabled = true; view.update(); expect(input.disabled).toBe(true);
  values.threshold = ''; view.update(); expect(root.querySelector('output')?.textContent).toBe('—'); expect(values.threshold).toBe('');
  disabled = false; view.update(); input.dispatchEvent(new Event('pointerup')); expect(values.threshold).toBe('0');
  expect(() => validateProjectValues([field], { threshold: '1.2' })).toThrow('between 0 and 1');
});

it('uses the slider in a resumed input prompt and submits its value without manual typing', () => {
  const submit = vi.fn();
  const prompt = new InputPrompt({ requestId: 'threshold', nodeName: 'review', title: 'Threshold', params: [field] }, { submit, stop() {} });
  document.body.append(prompt.root);
  const input = prompt.root.querySelector<HTMLInputElement>('input[type=range]')!;
  input.value = '0.75'; input.dispatchEvent(new Event('input'));
  expect(prompt.root.querySelector('output')?.textContent).toBe('0.75');
  [...prompt.root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Resume run')!.click();
  expect(submit).toHaveBeenCalledWith({ threshold: '0.75' });
});
