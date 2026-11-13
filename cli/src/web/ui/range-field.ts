import type { Field, ParamValue } from '../workflow-types';

export function rangeField(input: HTMLInputElement, field: Field): HTMLElement {
  const range = field.range!;
  input.type = 'range'; input.min = String(range.min); input.max = String(range.max); input.step = String(range.step);
  const root = document.createElement('div'); root.className = 'param-range';
  const value = document.createElement('output'); value.setAttribute('for', input.id); value.className = 'param-range-value';
  const limits = document.createElement('div'); limits.className = 'param-range-limits'; limits.setAttribute('aria-hidden', 'true');
  for (const number of [range.min, range.max]) { const label = document.createElement('span'); label.textContent = String(number); limits.append(label); }
  root.append(input, value, limits);
  input.addEventListener('input', () => updateRangeField(input, input.value));
  const chooseUnset = () => { if (!input.disabled && value.textContent === '—') input.dispatchEvent(new Event('input', { bubbles: true })); };
  input.addEventListener('pointerup', chooseUnset);
  input.addEventListener('keyup', event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) chooseUnset(); });
  return root;
}

export function updateRangeField(input: HTMLInputElement, value: ParamValue): void {
  const text = typeof value === 'string' ? value : '';
  const next = text || input.min;
  if (input.value !== next) input.value = next;
  input.parentElement!.querySelector('output')!.textContent = text || '—';
  input.setAttribute('aria-valuetext', text || '—');
  input.setAttribute('aria-invalid', String(!!text && (!Number.isFinite(Number(text)) || Number(text) < Number(input.min) || Number(text) > Number(input.max))));
}
