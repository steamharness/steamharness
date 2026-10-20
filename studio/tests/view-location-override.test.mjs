import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../upstream/vscode/src/vs/workbench/services/views/browser/viewDescriptorService.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true } }).outputText;
const common = { Disposable: class { static None = { dispose() {} }; }, toDisposable: callback => ({ dispose: callback }),
  registerSingleton() {}, InstantiationType: { Delayed: 1 }, StorageScope: { PROFILE: 0 }, StorageTarget: { USER: 0 },
};
const module = { exports: {} };
runInNewContext(compiled, { exports: module.exports, module, require: () => new Proxy(common, { get: (target, key) => key in target ? target[key] : () => undefined }) });

for (const original of [1, 0]) {
  test(`a temporary tool location keeps profile storage at ${original === 1 ? 'the default' : 'the customized'} position`, () => {
    const container = { id: 'project-data', requestedIndex: 3 }, events = [], stored = new Map();
    const service = Object.create(module.exports.ViewDescriptorService.prototype);
    Object.assign(service, {
      viewContainerLocationOverrides: new Map(), viewContainersCustomLocations: new Map(original === 1 ? [] : [[container.id, original]]),
      viewDescriptorsCustomLocations: new Map(), viewContainerBadgeEnablementStates: new Map(),
      isSessionsWindow: false, viewContainersRegistry: { all: [container], getViewContainerLocation: () => 1 },
      _onDidChangeContainerLocation: { fire: event => events.push([event.from, event.to]) }, _onDidChangeLocation: { fire() {} },
      getViewsByContainer: () => [], getOrCreateDefaultViewContainerLocationContextKey: () => ({ set() {} }),
      storageService: { get: (key, scope, fallback) => stored.get(key) ?? fallback, store: (key, value) => stored.set(key, value) },
    });
    const location = service.overrideViewContainerLocation(container, 2);
    assert.equal(service.getViewContainerLocation(container), 2);
    assert.equal(container.requestedIndex, undefined);
    // A different preference may be saved while Steam mode is active.
    service.setViewContainerBadgeEnablementState(container.id, false);
    const saved = JSON.parse([...stored.values()][0]);
    assert.equal(saved.viewContainerLocations[container.id], original === 1 ? undefined : original);
    location.dispose();
    assert.equal(service.getViewContainerLocation(container), original);
    assert.equal(container.requestedIndex, 3);
    assert.deepEqual(events, [[original, 2], [2, original]]);
  });
}
