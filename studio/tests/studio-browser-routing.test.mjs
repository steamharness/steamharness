import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

async function load(filename, common) {
  const source = await readFile(new URL(`../upstream/vscode/src/vs/workbench/${filename}`, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true } }).outputText;
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports,
    require: () => new Proxy(common, { get: (target, key) => key in target ? target[key] : () => undefined }),
  });
  return module.exports;
}

test('reserved Steam groups take precedence over native browser side-group and window placement', async t => {
  const policy = await load('services/editor/common/editorOpenTarget.ts', { toDisposable: dispose => ({ dispose }) });
  const { BrowserViewWorkbenchService } = await load('contrib/browserView/electron-browser/browserViewWorkbenchService.ts', {
    Disposable: class {}, URI: { from: value => value }, Schemas: { vscodeBrowser: 'vscode-browser' }, BrowserViewCommandId: {},
    ContextKeyExpr: { and() {}, has() {}, or() {}, equals() {} },
    ChatContextKeys: { enabled: {} }, ChatConfiguration: { AgentEnabled: 'agent.enabled' },
    IsSessionsWindowContext: { negate() {} },
    ACTIVE_GROUP: -1, SIDE_GROUP: -2, ...policy,
  });
  const service = Object.create(BrowserViewWorkbenchService.prototype);
  const toolGroup = { id: 2 }, dedicatedGroup = { id: 3 };
  let placement, dedicated = 0;
  service.configurationService = { getValue: () => placement };
  service._getOrCreateDedicatedGroup = () => { dedicated++; return dedicatedGroup; };
  const routing = policy.registerEditorOpenTarget(editor => {
    assert.equal(editor.resource.scheme, 'vscode-browser'); return toolGroup;
  });
  t.after(() => routing.dispose());
  for (placement of ['activeGroup', 'sideGroup', 'window']) {
    for (const preferred of [undefined, -1, -2, -3]) {
      assert.equal(await service.getPreferredGroup(preferred), toolGroup);
    }
  }
  assert.equal(dedicated, 0);
  routing.dispose(); placement = 'window';
  assert.equal(await service.getPreferredGroup(), dedicatedGroup); assert.equal(dedicated, 1);
});
