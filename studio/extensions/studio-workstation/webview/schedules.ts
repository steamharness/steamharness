import type { ScheduleInput } from '../../../../shared/workflow-schedules/index';
import type { LocalFire, LocalSchedule, SchedulePanelMetadata } from '../src/workflow-schedule-contract';

declare const acquireVsCodeApi: () => { postMessage(message: Record<string, unknown>): void };
type Row = LocalSchedule & { active: boolean };
type Snapshot = { plans: Row[]; selected?: string; history: (LocalFire & { cursor: number })[]; older: boolean };
const host = acquireVsCodeApi();
const page = document.querySelector<HTMLElement>('#schedules')!;
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, value = '', name?: string) => {
  const element = document.createElement(tag);
  element.textContent = value;
  if (name) element.className = name;
  return element;
};
const button = (label: string, icon: string, click: () => void, primary = false) => {
  const control = node('button', '', primary ? 'primary' : 'secondary');
  control.type = 'button';
  const glyph = node('i', '', `codicon codicon-${icon}`); glyph.setAttribute('aria-hidden', 'true');
  control.append(glyph, node('span', label)); control.addEventListener('click', click);
  return control;
};
const option = (value: string, title: string) => Object.assign(node('option', title), { value });

function init(meta: SchedulePanelMetadata) {
  const t = meta.labels;
  const datetime = (value: number | string, zone: string) => new Intl.DateTimeFormat(document.documentElement.lang, {
    year: 'numeric', month: 'short', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: zone, timeZoneName: 'shortOffset',
  }).format(new Date(value));
  const plans = node('ul', '', 'plan-list'), results = node('ol'), preview = node('ol', '', 'preview-list'), status = node('p', '', 'status');
  status.setAttribute('role', 'status');
  const form = node('form'), name = node('input'), target = node('select'), timezone = node('input'), kind = node('select');
  const expression = node('input'), interval = node('input'), parameters = node('textarea');
  const days = node('div', '', 'days'), windows = node('div', '', 'time-windows'), intervalRule = node('div', '', 'interval-rule');
  const save = button(t.save, 'save', () => undefined, true); save.type = 'submit';
  const previewButton = button(t.preview, 'watch', () => submit('preview'));
  const actionbar = node('div', '', 'actions');
  const show = node('section'); const history = node('section');
  const names = node('aside'); names.setAttribute('aria-label', t.title);
  const newPlan = button(t.newPlan, 'add', () => select());
  const current = node('p', '', 'muted');
  const label = (title: string, control: HTMLElement) => { const item = node('label', '', 'field'); item.append(node('span', title), control); return item; };
  const cronRule = label(t.cronExpression, expression);
  name.required = timezone.required = true; name.maxLength = 100; timezone.maxLength = 128;
  expression.maxLength = 200; parameters.rows = 3; parameters.maxLength = 20_000; parameters.spellcheck = false;
  interval.type = 'number'; interval.min = '1'; interval.max = '1440'; interval.value = '15';
  kind.append(option('cron', t.cron), option('window-interval', t.interval));
  target.append(...meta.operations.map(item => option(item.id, item.title ? `${item.title} · ${item.id}` : item.id)));
  const ticks = t.days.map((day, index) => {
    const check = node('input'); check.type = 'checkbox'; check.value = String(index + 1);
    const item = node('label'); item.append(check, node('span', day)); days.append(item); return check;
  });
  const addWindow = (start = '09:00', end = '17:00') => {
    const row = node('div', '', 'window'), from = node('input'), to = node('input');
    from.type = to.type = 'time'; from.value = start; to.value = end; from.required = to.required = true;
    const remove = button(t.removeWindow, 'remove', () => row.remove());
    row.append(label(t.windowStart, from), label(t.windowEnd, to), remove); windows.append(row);
  };
  const add = button(t.addWindow, 'add', () => { if (windows.childElementCount < 12) addWindow(); });
  intervalRule.append(label(t.intervalMinutes, interval), node('p', t.weekdays), days, node('p', t.windows), windows, add);
  const rules = () => {
    const cron = kind.value === 'cron'; cronRule.hidden = !cron; expression.disabled = !cron; expression.required = cron;
    intervalRule.hidden = cron;
    intervalRule.querySelectorAll<HTMLInputElement>('input').forEach(input => { input.disabled = cron; });
  };
  kind.onchange = rules;
  const preset = node('select'); preset.append(option('', t.selectPreset), ...meta.presets.map(item => option(item.id, item.title)));
  const fields = node('div', '', 'field-grid'); fields.append(label(t.name, name), label(t.operation, target), label(t.timezone, timezone), label(t.rule, kind));
  const submitbar = node('div', '', 'actions'); submitbar.append(previewButton, save);
  const presetField = label(t.presets, preset); presetField.hidden = !meta.presets.length;
  form.append(presetField, fields, cronRule, intervalRule, label(t.parameters, parameters), submitbar, preview);
  const heading = node('header', '', 'heading');
  heading.append(node('h1', t.title), node('p', `${meta.project} · ${meta.target.entryId} · ${meta.target.version}`), node('p', meta.target.directory, 'muted'));
  names.append(newPlan, plans); show.append(node('h2', t.details), current, actionbar, form, status);
  const older = button(t.more, 'chevron-right', () => send('history', { older: true }));
  const latest = button(t.latest, 'history', () => send('history', { older: false }));
  history.append(node('h2', t.report), results, latest, older);
  const layout = node('div', '', 'layout'); const detail = node('div'); detail.append(show, history); layout.append(names, detail); page.replaceChildren(heading, layout);

  let data: Snapshot = { plans: [], history: [], older: false }, editing: string | undefined, busy = false;
  let planShape = '', receiptShape = '';
  const send = (type: string, extra: Record<string, unknown> = {}) => {
    if (busy) return;
    busy = true; renderControls();
    host.postMessage({ type, id: editing, ...extra });
  };
  function select(id?: string) { if (!busy) { editing = id; apply(data.plans.find(row => row.id === id)); send('select'); } }
  function apply(value?: Pick<ScheduleInput, 'name' | 'entrypointId' | 'timezone' | 'trigger' | 'paramValues'>) {
    name.value = value?.name ?? ''; target.value = value?.entrypointId ?? meta.operations[0]?.id ?? '';
    timezone.value = value?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    kind.value = value?.trigger.kind ?? 'cron'; expression.value = value?.trigger.kind === 'cron' ? value.trigger.expression : '0 9 * * 1-5';
    const spec = value?.trigger.kind === 'window-interval' ? value.trigger : undefined;
    interval.value = String(spec?.intervalMinutes ?? 15); ticks.forEach((tick, index) => { tick.checked = (spec?.weekdays ?? [1, 2, 3, 4, 5]).includes(index + 1); });
    windows.replaceChildren(); (spec?.windows ?? [{ start: '09:00', end: '17:00' }]).forEach(window => addWindow(window.start, window.end));
    parameters.value = JSON.stringify(value?.paramValues ?? {}, null, 2); preview.replaceChildren(); status.textContent = ''; preset.value = ''; rules();
  }
  preset.onchange = () => { const value = meta.presets.find(item => item.id === preset.value); if (value) apply({ ...value, name: value.title }); };
  const recordKey = (value: Row | undefined) => value && JSON.stringify({ id: value.id, enabled: value.enabled, active: value.active, next: value.nextFireAt });
  function renderControls() {
    const row = data.plans.find(plan => plan.id === editing);
    save.disabled = busy || !!row?.active;
    previewButton.disabled = busy;
    newPlan.disabled = busy;
    const signature = JSON.stringify([recordKey(row), busy]);
    if (signature === planShape) return;
    planShape = signature;
    current.textContent = row?.nextFireAt ? `${t.next}: ${datetime(row.nextFireAt, row.timezone)}` : row ? t.disabled : '';
    actionbar.replaceChildren();
    if (row) {
      const controls = [button(row.enabled ? t.pause : t.enable, row.enabled ? 'debug-pause' : 'calendar', () => send(row.enabled ? 'pause' : 'enable')),
        button(t.run, 'play', () => send('run')), button(t.remove, 'trash', () => send('delete'))];
      controls.forEach((control, index) => { control.disabled = busy || index === 2 && row.active; }); actionbar.append(...controls);
    }
  }
  function submit(type: 'preview' | 'save') {
    if (busy || !form.reportValidity()) return;
    let paramValues: unknown;
    try { paramValues = JSON.parse(parameters.value || '{}'); }
    catch { status.textContent = t.reasons['invalid-parameters']; return; }
    const trigger = kind.value === 'cron' ? { kind: 'cron', expression: expression.value } : { kind: 'window-interval',
      weekdays: ticks.filter(tick => tick.checked).map(tick => Number(tick.value)), intervalMinutes: Number(interval.value),
      windows: [...windows.children].map(row => { const [start, end] = row.querySelectorAll('input'); return { start: start.value, end: end.value }; }) };
    send(type, { input: { name: name.value, entrypointId: target.value, timezone: timezone.value, paramValues, trigger } });
  }
  form.onsubmit = event => { event.preventDefault(); submit('save'); };
  form.oninput = () => { preview.replaceChildren(); };
  apply();
  return (event: Record<string, any>) => {
    if (event.type === 'state') {
      data = event as unknown as Snapshot;
      if (editing !== data.selected) { editing = data.selected; apply(data.plans.find(plan => plan.id === editing)); }
      const navKey = JSON.stringify([data.plans.map(row => [row.id, row.name, row.enabled]), editing]);
      if (plans.dataset.signature !== navKey) {
        plans.dataset.signature = navKey;
        plans.replaceChildren(...(data.plans.length ? data.plans.map(row => {
          const item = node('li'), control = button(row.name, row.enabled ? 'calendar' : 'circle-outline', () => select(row.id));
          control.dataset.plan = row.id; control.setAttribute('aria-pressed', String(editing === row.id));
          control.append(node('small', row.enabled ? t.enabled : t.disabled)); item.append(control); return item;
        }) : [node('li', t.noPlans, 'muted')]));
      }
      const row = data.plans.find(plan => plan.id === editing);
      history.hidden = !row;
      const nextReceipts = JSON.stringify([editing, data.history, data.older]);
      if (row && receiptShape !== nextReceipts) {
        receiptShape = nextReceipts;
        results.replaceChildren(...(data.history.length ? data.history.map(fire => {
          const item = node('li', '', 'receipt');
          const summary = node('div'); summary.append(node('strong', t.states[fire.status]), node('time', datetime(fire.scheduledFor, row.timezone)), node('small', fire.manual ? t.manual : t.clock));
          const reason = fire.reason && t.reasons[fire.reason as keyof typeof t.reasons];
          item.append(summary); if (reason) item.append(node('p', reason, 'muted'));
          if (fire.runId && fire.status !== 'running') item.append(button(t.open, 'go-to-file', () => send('open', { fireId: fire.id })));
          return item;
        }) : [node('li', t.emptyHistory, 'muted')]));
        latest.hidden = !data.older; older.hidden = data.history.length < 30;
      }
      renderControls();
    } else if (event.type === 'result') {
      busy = false; renderControls();
      status.textContent = event.error ?? (event.saved ? t.saved : '');
      if (event.preview) {
        try { preview.replaceChildren(...(event.preview as string[]).map(value => node('li', datetime(value, timezone.value.trim())))); }
        catch { preview.replaceChildren(); }
      }
    }
  };
}

let receive: ReturnType<typeof init> | undefined;
window.addEventListener('message', ({ data }) => {
  if (data?.type === 'init') receive = init(data);
  else receive?.(data);
});
host.postMessage({ type: 'ready' });
