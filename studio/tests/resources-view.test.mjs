import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/workflow-resources-view.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
const project = (name, projectType = 'conversation') => ({ id: name, uri: `file:///${name}`, folderPath: `/${name}`, name, projectType,entryId:'main',databases:[{alias:'data',host:'local'}] });

function fixture(t, operation = async () => ({ items: [], total: 0, hasMore: false }), connection, register = true) {
  const providers = new Map(), commands = new Map(), views = new Map(), messages = new Map(), receivers = new Map(), calls = [], contextValues = [], copied = [], invalidated = [];
  let accountChanged;
  const disposable = { dispose() {} };
  const vscode = {
    Uri: { joinPath: (_root, ...parts) => ({ toString: () => parts.join('/') }) },
    workspace: { isTrusted: true },
    env: { language: 'en', clipboard: { writeText: async text => { copied.push(text); } } },
    window: { registerWebviewViewProvider: (id, provider) => { providers.set(id, provider); return disposable; }, showWarningMessage: async () => "Delete" },
    commands: { registerCommand: (id, fn) => { commands.set(id, fn); return disposable; }, executeCommand: async (...args) => contextValues.push(args) },
  };
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'vscode' ? vscode : require(name), crypto: globalThis.crypto, AbortController });
  const provider = new module.exports.ResourceViews({ subscriptions: [], extensionUri: {} }, {
    resource: async (...args) => { calls.push(args); return operation(...args); },
  }, { getConnection: () => connection, onDidChange: callback => { accountChanged = callback; return disposable; },
    invalidate: async current => { invalidated.push(current); connection = undefined; accountChanged({ status: 'expired' }); }, open() {} }, { appendLine() {} }, register);
  t.after(() => provider.dispose());
  for (const kind of ['kv', 'knowledge']) {
    const sent = []; messages.set(kind, sent);
    const view = { webview: { cspSource: 'self', asWebviewUri: uri => uri,
      onDidReceiveMessage: fn => { receivers.set(kind, fn); return disposable; }, postMessage: async message => { sent.push(message); return true; } },
      onDidChangeVisibility: () => disposable, onDidDispose: () => disposable, show() {} };
    if (register) { providers.get(`studio.${kind}`).resolveWebviewView(view); } else { provider.resolve(kind, view); }
    views.set(kind, view);
  }
  const state = kind => messages.get(kind).findLast(item => item.type === 'resources-state');
  const send = async (kind, input = { action: 'list' }, extra = {}) => {
    receivers.get(kind)({ type: 'request', id: 1, generation: state(kind).generation, projectUri: state(kind).selected, input, ...extra });
    await new Promise(resolve => setImmediate(resolve));
  };
  return { provider, commands, messages, receivers, views, calls, state, send, contextValues, copied, invalidated, vscode,
    accountChanged: (status = 'signed-out', nextConnection) => { connection = nextConnection; accountChanged({ status }); } };
}

const key = (project, alias = 'data') => `${project.uri}#entry=${project.entryId}:database=${alias}`;

test('resource choices identify each entry and declared alias and exclude the assistant',t=>{
 const f=fixture(t),a=project('Aggregate'),b={...a,entryId:'other',databases:[{alias:'shared',host:'server'}]};
 f.provider.update([a,b,{...project('assistant'),assistant:{standalone:true}}]);
 assert.deepEqual(Array.from(f.state('kv').projects,item=>item.uri),[key(a),key(b,'shared')]);
 assert.equal(f.contextValues.at(-1)[2],true);f.provider.update([]);assert.equal(f.contextValues.at(-1)[2],false);
});
test('active entries and explicit aliases select independently and stable scans preserve selection',t=>{
 const f=fixture(t),a=project('first'),b=project('second');f.provider.update([a,b],a);
 f.receivers.get('kv')({type:'select',projectUri:key(b)});assert.equal(f.state('knowledge').selected,key(b));
 f.provider.update([a,b],a);assert.equal(f.state('kv').selected,key(b));
 f.provider.update([a,b],b);f.provider.update([a,b],a);assert.equal(f.state('kv').selected,key(a));
});
test('the host supplies entry, alias and source and rejects untrusted workspace mutations',async t=>{
 const f=fixture(t),a=project('first');f.provider.update([a],a);
 await f.send('kv',{action:'list',source:'server',database:'forged'});
 assert.equal(f.calls[0][0].entryId,'main');assert.equal(f.calls[0][1].source,'local');assert.equal(f.calls[0][1].database,'data');
 f.vscode.workspace.isTrusted=false;await f.send('kv',{action:'save',key:'x',value:1});
 assert.equal(f.calls.length,1);assert.match(f.messages.get('kv').at(-1).error,/Trust/);
});
test('separate resource panel instances keep selections and pending operations independent',async t=>{
 let finish;const f=fixture(t,()=>new Promise(resolve=>finish=resolve),undefined,false),g=fixture(t,undefined,undefined,false),a=project('first'),b=project('second');
 f.provider.update([a,b],a);g.provider.update([a,b],a);await f.send('kv');
 g.receivers.get('kv')({type:'select',projectUri:key(b)});g.provider.dispose();
 assert.equal(f.calls[0][2].aborted,false);finish({items:[{key:'retained'}],total:1});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.messages.get('kv').at(-1).value.items[0].key,'retained');assert.equal(f.commands.has('studio.refreshResources'),false);
});
test('switching entry cancels old work and late replies cannot update the panel',async t=>{
 let finish;const f=fixture(t,()=>new Promise(resolve=>finish=resolve)),a=project('first'),b=project('second');
 f.provider.update([a,b],a);await f.send('knowledge');const generation=f.state('knowledge').generation;
 f.provider.update([a,b],b);assert.equal(f.calls[0][2].aborted,true);finish({items:['stale']});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.messages.get('knowledge').some(message=>message.type==='resources-result'&&message.generation===generation),false);
});
test('stable account checks preserve work while account rotation and logout cancel it',async t=>{
 const connection={serverUrl:'https://server.test',accessToken:'token'};
 const f=fixture(t,()=>new Promise(()=>{}),connection),a=project('first');f.provider.update([a],a);await f.send('kv');
 const signal=f.calls[0][2];f.accountChanged('signed-in',{...connection});f.provider.update([a],a);assert.equal(signal.aborted,false);
 f.accountChanged('signed-in',{...connection,accessToken:'other'});assert.equal(signal.aborted,true);
 f.accountChanged();assert.equal(f.state('kv').authenticated,false);
});
test('copy validates the current entry and generation',async t=>{
 const f=fixture(t),a=project('first');f.provider.update([a],a);
 await f.receivers.get('kv')({type:'copy',text:'value',projectUri:key(a),generation:f.state('kv').generation});
 await f.receivers.get('kv')({type:'copy',text:'stale',projectUri:key(a),generation:0});assert.deepEqual(f.copied,['value']);
});
