import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const file = '../upstream/vscode/src/vs/workbench/contrib/welcomeGettingStarted/browser/startupPage.ts';
const source = ts.createSourceFile(file, await readFile(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'StartupPageRunnerContribution');
const method = declaration.members.find(node => node.name?.getText(source) === 'tryShowOnboarding');
const compiled = ts.transpileModule(`class Startup { ${method.getText(source)} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture({ web = false, skip = false, enabled = true, fresh = true, completed = false } = {}) {
  const module = { exports: {} }, writes = [];
  runInNewContext(`${compiled}\nmodule.exports = Startup;`, { module, isWeb: web, StorageScope: { APPLICATION: 0 }, StorageTarget: { USER: 0 }, ONBOARDING_STORAGE_KEY: 'welcomeOnboarding.state' });
  const startup = new module.exports();
  let dismiss, shown = 0;
  startup.environmentService = { skipWelcome: skip };
  startup.configurationService = { getValue: () => enabled };
  startup.storageService = { isNew: () => fresh, getBoolean: () => completed, store: (...args) => writes.push(args) };
  startup.onboardingService = { show: () => { shown++; }, onDidDismiss: listener => { dismiss = listener; return { dispose() {} }; } };
  startup._register = value => value;
  return { startup, writes, get shown() { return shown; }, dismiss: () => dismiss() };
}

test('first-run account onboarding works without Copilot services and persists dismissal', () => {
  const fixtureState = fixture();
  fixtureState.startup.tryShowOnboarding();
  assert.equal(fixtureState.shown, 1);
  fixtureState.dismiss();
  assert.deepEqual(fixtureState.writes, [['welcomeOnboarding.state', true, 0, 0]]);
});

for (const options of [{ web: true }, { skip: true }, { enabled: false }, { fresh: false }, { completed: true }]) {
  test(`startup continues honoring the existing welcome guard ${JSON.stringify(options)}`, () => {
    const state = fixture(options);
    state.startup.tryShowOnboarding();
    assert.equal(state.shown, 0);
    assert.deepEqual(state.writes, []);
  });
}
