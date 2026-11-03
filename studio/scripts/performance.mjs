import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { build, stop } from 'esbuild';

export async function runPerformance({ measure, PROFILE }) {
  const metrics = [], require = createRequire(import.meta.url), disposable = { dispose() {} };
  const vscode = { workspace: { isTrusted: true }, env: { language: 'en' } };
  async function load(source) {
    const compiled = await build({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
    const module = { exports: {} };
    runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports,
      require: name => name === 'vscode' ? vscode : require(name),
      structuredClone, URL, AbortController, crypto: globalThis.crypto, TextEncoder, Error, Date, setTimeout, clearTimeout });
    return module.exports;
  }
  try {
    const { UserModels } = await load('extensions/studio-workstation/src/user-models.ts');
    const models = new UserModels({ get: async () => undefined }, () => {});
    let requests = 0;
    models.registerCatalogProvider({ load: async () => {
      requests++; await delay(PROFILE.networkMs);
      return { entries: [{ id: 'fixture', name: 'Fixture', models: Array.from({ length: 64 }, (_, index) => ({ id: `model-${index}`, name: `Model ${index}` })) }] };
    } });
    try {
      await models.refreshCatalog(); // Finish the provider registration's automatic refresh before timing explicit reads.
      for (const [name, fresh, expectedRequests, budgetMs] of [['cold', true, 1, 150], ['warm', false, 0, 40]]) {
        metrics.push(await measure(`studio.catalog.${name}`, async () => {
          const before = requests;
          const catalog = fresh ? await models.refreshCatalog() : await models.catalog(new AbortController().signal);
          assert.equal(catalog.entries[0].models.length, 64); assert.equal(requests - before, expectedRequests);
          return { requests: requests - before };
        }, { budgetMs, workload: { models: 64, expectedRequests } }));
      }
    } finally { models.dispose(); }

    const { DatabaseViews } = await load('extensions/studio-workstation/src/workflow-databases-view.ts');
    const projects = Array.from({ length: 6 }, (_, index) => ({ id: 'project', entryId: `entry-${index}`, uri: 'file:///fixture', name: 'Fixture', databases: ['main'] }));
    requests = 0;
    const launcher = { inspect: async () => ({ projects, errors: [] }), database: async input => {
      requests++; await delay(PROFILE.networkMs);
      return input.action === 'bindings' ? { bindings: [{ alias: 'main', databaseId: 'fixture' }] }
        : { resources: [{ id: 'fixture', kind: 'databases', name: 'Fixture' }] };
    } };
    const views = new DatabaseViews({ subscriptions: [] }, launcher,
      { getConnection: () => ({ serverUrl: 'https://performance.test', accessToken: 'fixture-only' }), onDidChange: () => disposable }, { appendLine() {} }, false);
    views.update(projects, projects[0]);
    try {
      for (const [name, force, callers, expectedRequests, budgetMs] of [
        ['cold', true, 1, 7, 250], ['reopen', false, 1, 0, 40], ['concurrent-refresh', true, 20, 7, 250],
      ]) metrics.push(await measure(`studio.resources.${name}`, async () => {
        const before = requests;
        await Promise.all(Array.from({ length: callers }, () => views.refresh(force)));
        assert.equal(views.error, ''); assert.equal(views.resources.length, 1); assert.equal(views.bindings.length, 6);
        assert.equal(requests - before, expectedRequests); return { requests: requests - before };
      }, { budgetMs, workload: { entries: 6, callers, expectedRequests } }));
    } finally { views.dispose(); }
  } finally { stop(); }
  return metrics;
}
