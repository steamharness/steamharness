import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { register } from 'tsx/esm/api';
import { build } from 'esbuild';

register();
const { WorkflowScheduleStore } = await import('../extensions/studio-workstation/src/workflow-schedule-store.ts');
const { WorkflowScheduler } = await import('../extensions/studio-workstation/src/workflow-scheduler.ts');
const { outputFiles: [runtimeBundle] } = await build({ entryPoints: [path.join(import.meta.dirname, '../extensions/studio-workstation/src/workflow-schedule-runtime.ts')],
  bundle: true, write: false, platform: 'node', format: 'esm' });
const { WorkflowScheduleRuntime } = await import(`data:text/javascript;base64,${Buffer.from(runtimeBundle.contents).toString('base64')}`);
const { inspectProjectCli, startProjectCli } = await import('../extensions/studio-workstation/src/workflow-cli-process.ts');
const { previewProjectSchedule } = await import('../../shared/workflow-schedules/index.ts');
const cron = (options = {}) => ({ name: 'Review', enabled: true, resolvedTarget: 'dev', entrypointId: 'review', timezone: 'UTC',
  trigger: { kind: 'cron', expression: '* * * * *' }, paramValues: {}, ...options });

async function dir(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'studio-schedules-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function until(poll) {
  const deadline = Date.now() + 15_000;
  do { const value = await poll(); if (value) return value; await delay(100); } while (Date.now() < deadline);
  assert.fail('Scheduled run did not reach the expected state.');
}

test('one leader persists fires, skips overlaps and does not catch up across resume or restart', async t => {
  const root = await dir(t);
  const target = { directory: root, projectId: randomUUID(), entryId: 'main', version: '1.0.0' };
  const first = new WorkflowScheduleStore(root), follower = new WorkflowScheduleStore(root);
  const started = [], errors = [];
  let now = Date.parse('2026-11-24T12:00:59.000Z'), waiting = true;
  const fake = { start: async (_, fire) => { started.push(fire.id); return { status: 'waiting_for_input', runId: fire.id }; },
    status: async (_, fire) => ({ status: waiting ? 'waiting_for_input' : 'success', runId: fire.id }) };
  const a = new WorkflowScheduler(first, fake, error => errors.push(error), () => now);
  const b = new WorkflowScheduler(follower, fake, error => errors.push(error), () => now);
  try {
    const plan = first.save(target, cron(), now);
    const sibling = { ...target, directory: path.join(root, 'another-copy') };
    assert.deepEqual(first.list(sibling), []);
    a.tick(); b.tick(); now += 1000;
    a.tick(); b.tick(); await Promise.all([a.idle(), b.idle()]);
    const [firstFire] = follower.history(plan.id);
    assert.equal(firstFire.status, 'waiting_for_input');
    assert.equal(started.length, 1);
    assert.throws(() => follower.remove(plan.id), /active/);
    assert.throws(() => follower.save(target, cron({ entrypointId: 'other' }), now, plan.id), /active/);
    follower.manual(plan.id, now); follower.manual(plan.id, now);
    assert.deepEqual(follower.history(plan.id).map(fire => fire.status), ['skipped_overlap', 'skipped_overlap', 'waiting_for_input']);
    now += 59_000; a.tick(); now += 1000; a.tick(); await a.idle();
    assert.equal(follower.history(plan.id)[0].status, 'skipped_overlap');
    now += 120_000; a.tick(); await a.idle();
    assert.deepEqual(follower.history(plan.id).slice(0, 2).map(fire => fire.reason), ['studio-offline', 'studio-offline']);
    await a.stop();
    now += 120_000; b.tick(); await b.idle();
    assert.deepEqual(follower.history(plan.id).slice(0, 2).map(fire => fire.status), ['skipped_missed', 'skipped_missed']);
    assert.deepEqual(started, [firstFire.runId]);
    follower.setEnabled(plan.id, false, now);
    assert.equal(follower.active(plan.id), true, 'pausing does not cancel in-flight approval');
    waiting = false; b.tick(); await b.idle();
    assert.equal(follower.history(plan.id).find(fire => fire.id === firstFire.id).status, 'success');
    assert.deepEqual(errors, []);
  } finally { await b.stop(); }
});

test('previews five timezone-aware timestamps through DST using the shared rules', () => {
  const input = { timezone: 'America/New_York', trigger: { kind: 'window-interval', weekdays: [7], windows: [{ start: '09:00', end: '09:00' }], intervalMinutes: 30 } };
  assert.deepEqual(previewProjectSchedule(input, '2026-03-01T00:00:00Z').nextRuns, [
    '2026-03-01T14:00:00.000Z', '2026-03-08T13:00:00.000Z', '2026-03-15T13:00:00.000Z', '2026-03-22T13:00:00.000Z', '2026-03-29T13:00:00.000Z',
  ]);
  assert.equal(previewProjectSchedule({ ...input, trigger: { kind: 'cron', expression: '0 9 * * 0' } }, '2026-11-01T00:00:00Z').nextRuns[0], '2026-11-01T14:00:00.000Z');
});

test('a clock rollback cannot dispatch an already queued fire before its time', async t => {
  const root = await dir(t), store = new WorkflowScheduleStore(root);
  const target = { directory: root, projectId: randomUUID(), entryId: 'main', version: '1.0.0' };
  const at = Date.parse('2026-11-24T12:00:00.000Z');
  let now = at - 1_000;
  const started = [], errors = [];
  const scheduler = new WorkflowScheduler(store, {
    start: async (_, fire) => { started.push(fire.scheduledFor); return { status: 'success', runId: fire.id }; },
    status: async () => undefined,
  }, error => errors.push(error), () => now);
  try {
    const plan = store.save(target, cron({ enabled: false }), now);
    scheduler.tick();
    store.manual(plan.id, at);
    now = at - 2_000;
    scheduler.tick(); await scheduler.idle();
    assert.deepEqual(started, []);
    assert.equal(store.history(plan.id)[0].status, 'pending');
    now = at;
    scheduler.tick(); await scheduler.idle();
    assert.deepEqual(started, [at]);
    assert.equal(store.history(plan.id)[0].status, 'success');
    assert.deepEqual(errors, []);
  } finally { await scheduler.stop(); }
});

test('scheduled Workflow uses the private desktop capability and resumes the same run after both hosts close', { timeout: 45_000 }, async t => {
  const root = await dir(t), project = path.join(root, 'project'), webData = path.join(root, 'data'), schedules = path.join(root, 'schedules');
  const id = randomUUID(), target = { directory: project, projectId: id, entryId: 'main', version: '1.0.0' };
  await mkdir(path.join(project, 'node_modules/@steamharness'), { recursive: true });
  const link = (folder, destination) => symlink(path.resolve(import.meta.dirname, '..', '..', folder), path.join(project, 'node_modules', destination), process.platform === 'win32' ? 'junction' : 'dir');
  await link('cli', '@steamharness/cli'); await link('harness', 'steamharness');
  await writeFile(path.join(project, 'package.json'), '{"type":"module","name":"schedule-fixture","version":"1.0.0","devDependencies":{"steamharness":"0.2.5","@steamharness/cli":"0.2.5"}}');
  await writeFile(path.join(project, 'steamharness.json'), JSON.stringify({ id, name: 'Review fixture', version: '1.0.0', defaultEntry: 'main',
    entries: [{ entryId: 'main', type: 'workflow', name: 'Main', root: '.', entry: 'index.ts' }] }));
  await writeFile(path.join(project, 'index.ts'), `
    const approval = steamharness.createUserInputNode({ name: 'check', title: 'Review', params: [{ name: 'approved', type: 'boolean', required: true }], defaultValues: { approved: true } });
    const resultNode = steamharness.createOutputNode({ name: 'result', format: input => steamharness.createOutputPayload({items:[{id:'result',contentType:'text',content:input.subject}]}) });
    const wrong = steamharness.defineProject({ name: 'wrong', async run() { throw new Error('Default operation must not run'); } });
    const review = steamharness.defineProject({ name: 'review', async run(input, context) {
      await steamharness.runNode(approval, input, context);
      return steamharness.runNode(resultNode, input, context);
    } });
    export const executor = steamharness.defineExecutor({ projectType: 'workflow', defaultEntrypoint: 'main', entrypoints: [
      steamharness.defineEntrypoint({ id: 'main', title: 'Wrong', workflow: wrong, createInput: () => ({errCode:0,errMessage:''}) }),
      steamharness.defineEntrypoint({ id: 'review', title: 'Review', workflow: review, params: [{ name:'subject',flag:'--subject',type:'string',required:true }],
        createInput: ({ paramValues }) => ({errCode:0,errMessage:'',subject:paramValues.subject}) }),
    ] });`);
  const inspected = await inspectProjectCli(project, process.execPath, undefined, undefined, undefined, 'en', true, undefined, path.join(root, 'auth'));
  assert.deepEqual(inspected.errors, []);
  const sessions = new Set();
  const spawn = async (_target, workflowScheduleKey) => {
    const session = await startProjectCli({ projectDir: project, expectedProjectId: id, entryId: 'main', dataDir: webData,
      authRoot: path.join(root, 'auth'), nodePath: process.execPath, surface: 'editor', theme: 'dark', workflowScheduleKey });
    sessions.add(session); void session.closed.then(() => sessions.delete(session)); return session;
  };
  const runtimes = new Set();
  t.after(async () => { await Promise.all([...sessions].map(session => session.close())); await Promise.all([...runtimes].map(runtime => runtime.close())); });
  let trusted = true;
  const failures = [];
  const open = () => { const runtime = new WorkflowScheduleRuntime(schedules, webData, async () => trusted, spawn, error => failures.push(error)); runtimes.add(runtime); return runtime; };
  const retire = async runtime => { await runtime.close(); runtimes.delete(runtime); };
  const leader = open(), otherWindow = open();
  const capability = WorkflowScheduleRuntime.capability();
  const live = await spawn(target, capability);
  await otherWindow.register(project, id, live, capability);
  const url = new URL(live.ready.url), publicToken = url.hash.slice('#session='.length);
  const send = (session, route, value, token) => fetch(new URL(`api/${route}`, session.ready.url), { method: 'POST',
    headers: { Authorization: `Bearer ${token ?? new URL(session.ready.url).hash.slice('#session='.length)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const forbidden = await send(live, 'host-workflow-schedule', { action: 'status', runId: randomUUID() }, publicToken);
  if (forbidden.status === 200) assert.fail(await (await send(live, 'retry', {}, publicToken)).text());
  assert.equal(forbidden.status, 404, await forbidden.text());
  const spec = cron({ enabled: false, paramValues: { subject: 'Scheduled subject' } });
  await leader.validate(target, spec, AbortSignal.timeout(10_000));
  await assert.rejects(leader.validate(target, { ...spec, paramValues: { unknown: 'wrong' } }, AbortSignal.timeout(10_000)), /invalid-parameters/);
  const plan = otherWindow.store.save(target, spec, Date.now());
  otherWindow.store.manual(plan.id, Date.now());
  otherWindow.scheduler.tick(); leader.scheduler.tick();
  const [waiting] = await until(() => {
    const result = leader.store.history(plan.id); return result[0]?.status === 'waiting_for_input' ? result : undefined;
  });
  assert.equal(waiting.runId, waiting.id);
  assert.equal(await otherWindow.existingRunView(plan, waiting, AbortSignal.timeout(5_000)), live.ready.url);
  otherWindow.store.manual(plan.id, Date.now());
  assert.equal(otherWindow.store.history(plan.id)[0].status, 'skipped_overlap');
  await live.close(); await retire(otherWindow); await retire(leader);
  const afterRestart = open(), key = WorkflowScheduleRuntime.capability(), resumed = await spawn(target, key);
  await afterRestart.register(project, id, resumed, key);
  const ready = await (await send(resumed, 'message', { type: 'ready' })).json();
  const state = ready.messages.find(message => message.type === 'state');
  assert.equal(state.runs.length, 1);
  assert.equal(state.occupiedRun.id, waiting.runId);
  assert.equal(state.occupiedRun.report.scheduleId, plan.id);
  assert.equal(await afterRestart.existingRunView(plan, waiting, AbortSignal.timeout(5_000)), undefined, 'a reader without the original owner must restore from history');
  const reply = await send(resumed, 'message', { type: 'workflow-resume', id: waiting.runId, requestId: state.occupiedRun.pendingInput.requestId, values: { approved: true } });
  assert.equal(reply.status, 200);
  await until(() => afterRestart.store.history(plan.id).find(fire => fire.id === waiting.id && fire.status === 'success'));
  const done = await (await send(resumed, 'message', { type: 'ready' })).json();
  assert.deepEqual(done.messages.find(message => message.type === 'state').runs.map(run => run.id), [waiting.runId]);
  await resumed.close();
  const failurePlan = afterRestart.store.save(target, cron({ name: 'Failure test', entrypointId: 'main', enabled: false }), Date.now());
  afterRestart.store.manual(failurePlan.id, Date.now()); afterRestart.scheduler.tick();
  const failure = await until(() => afterRestart.store.history(failurePlan.id).find(fire => fire.status === 'failed'));
  assert.equal(failure.reason, 'run-failed');
  assert.equal(failure.runId, failure.id);
  trusted = false;
  afterRestart.store.manual(plan.id, Date.now()); afterRestart.scheduler.tick();
  await until(() => afterRestart.store.history(plan.id)[0]?.status === 'skipped_authorization');
  assert.deepEqual(failures, []);
  await retire(afterRestart);
});
