import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/workflow-runtime-node.ts'],
  bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });

test('runtime changes isolate new services and recovery keeps the original runtime snapshot', async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'Studio 会话 Node-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const nodes = [];
  for (const name of ['bundled', 'local']) {
    const bin = path.join(directory, name); await mkdir(bin);
    const node = path.join(bin, process.platform === 'win32' ? 'node.exe' : 'node'); await copyFile(process.execPath, node); nodes.push(node);
  }
  const cli = path.join(directory, 'node_modules/@steamharness/cli'); await mkdir(path.join(cli, 'dist'), { recursive: true });
  await writeFile(path.join(cli, 'package.json'), JSON.stringify({ name: '@steamharness/cli', version: '1.0.0', type: 'module', bin: { steamharness: 'dist/index.js' } }));
  await writeFile(path.join(cli, 'dist/index.js'), `
    import { createServer } from 'node:http';
    import { execFileSync } from 'node:child_process';
    import { createInterface } from 'node:readline';
    const args=process.argv.slice(2),input=createInterface({input:process.stdin});
    const server=createServer((request,response)=>{
      if(request.url==='/crash'){response.end('{}');setImmediate(()=>process.exit(23));return;}
      response.end(JSON.stringify({node:process.execPath,version:process.version,pid:process.pid,
        child:execFileSync('node',['-p','process.execPath'],{encoding:'utf8'}).trim(),electron:process.env.ELECTRON_RUN_AS_NODE}));
    });
    input.on('line',line=>{const message=JSON.parse(line);if(message.type==='configure'){
      server.listen(Number(args[args.indexOf('--port')+1]||0),'127.0.0.1',()=>console.log(JSON.stringify({type:'ready',protocolVersion:1,hostProtocolVersion:1,
        accountProtocolVersion:1,entriesProtocolVersion:1,databaseSpacesProtocolVersion:1,userSettingsProtocolVersion:1,
        url:'http://127.0.0.1:'+server.address().port+'/entries/main/#session='+'a'.repeat(64),
        project:{id:'project',name:'Project',projectType:'conversation',entryId:'main',defaultEntry:'main',entries:[{entryId:'main',name:'Main',type:'conversation',root:'.',entry:'index.ts',databases:[]}],databases:[]}})));
    }});
    input.on('close',()=>{process.stdin.pause();server.close();});
  `);
  let nodePath = nodes[0];
  const vscode = { env: { language: 'en' }, ColorThemeKind: { Light: 1, HighContrastLight: 4 },
    workspace: { isTrusted: true, onDidChangeConfiguration: () => ({ dispose() {} }),
      getConfiguration: () => ({ get: key => key === 'project.nodePath' ? nodePath : '', inspect: () => ({}) }) },
    window: { activeColorTheme: { kind: 1 } } };
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'vscode' ? vscode : require(name),
    process, structuredClone, AbortController, AbortSignal, URL, setTimeout, clearTimeout, queueMicrotask });
  const runtime = module.exports.createProjectRuntime({ extensionUri: { fsPath: directory }, globalStorageUri: { fsPath: path.join(directory, 'storage') } },
    { getConnection: () => undefined, onDidChange: () => ({ dispose() {} }) });
  t.after(() => runtime.dispose());
  const project = { id: 'project', folderPath: directory, uri: '', projectType: 'conversation', entryId: 'main', entries: [{ entryId: 'main' }] };
  const first = await runtime.start(project, 'editor'); t.after(() => first.close());
  const info = session => fetch(session.ready.url).then(response => response.json());
  const initial = await info(first);
  assert.equal(initial.node, nodes[0]); assert.equal(initial.child, nodes[0]); assert.equal(initial.electron, undefined);
  const same = await runtime.start(project, 'editor'); t.after(() => same.close());
  assert.equal((await info(same)).pid, initial.pid);
  nodePath = nodes[1];
  const second = await runtime.start(project, 'editor'); t.after(() => second.close());
  assert.equal((await info(second)).node, nodes[1]); assert.equal((await info(first)).pid, initial.pid);
  const exited = new Promise(resolve => first.onExit(resolve));
  await fetch(new URL('/crash', first.ready.url)); await exited;
  assert.equal(await first.reconnect(), true);
  const restored = await info(first);
  assert.equal(restored.node, nodes[0]); assert.equal(restored.child, nodes[0]); assert.notEqual(restored.pid, initial.pid);
  assert.equal((await info(second)).node, nodes[1]);
});
