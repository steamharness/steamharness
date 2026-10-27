import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { register } from 'tsx/esm/api';
register();
const { inspectProjectCli, resolveProjectCli, startProjectCli } = await import('../extensions/studio-workstation/src/workflow-cli-process.ts');
const { RecoverableWebSession } = await import('../extensions/studio-workstation/src/workflow-session.ts');
import { projectFrameHtml } from '../extensions/studio-workstation/src/workflow-webview.ts';

async function fixture(t, version = '1.0.0', protocol = 1, fail = false, startupDelay = 0, assistantProtocol = 1, accountProtocol = 1, relatedProtocol = 1, systemAiProtocol = 1, userSettingsProtocol = 1) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'studio-project-cli-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'package.json'), '{"name":"user-project"}');
  const cli = path.join(directory, 'node_modules/@steamharness/cli');
  await fs.mkdir(path.join(cli, 'dist'), { recursive: true });
  await fs.writeFile(path.join(cli, 'package.json'), JSON.stringify({ name: '@steamharness/cli', version, type: 'module', bin: { 'steamharness': 'dist/index.js' } }));
  await fs.writeFile(path.join(cli, 'dist/index.js'), `
    import { createServer } from 'node:http';
    import { createInterface } from 'node:readline';
    const version=${JSON.stringify(version)},args=process.argv.slice(2);
    const assistantId='a3aca697-b086-459b-84e4-d357ad2d9fb2';
    if(args.includes('--inspect') && !args.includes('--host-stdio')) {
      console.log(JSON.stringify({projects:[{name:version,folderPath:process.cwd(),projectType:'conversation',fields:[],entrypoints:[]}],errors:[]}));
    } else {
      const input=createInterface({input:process.stdin});
      let configuration,effectiveConnection,server,authMessages=0,userSettingsMessages=0;
      const authenticate=message=>{
        if(configuration.surface==='editor' && ${systemAiProtocol}!==1 && (message.connection?.aiServerUrl!==undefined || message.connection?.aiAccessToken!==undefined)) {
          console.error('AI connection requires the assistant surface.');process.exit(1);
        }
        effectiveConnection=message.connection && ${systemAiProtocol}===1 && message.systemAiConnection
          ? {...message.connection,aiServerUrl:message.systemAiConnection.serverUrl,aiAccessToken:message.systemAiConnection.accessToken}:message.connection;
      };
      input.on('line',line=>{
        const message=JSON.parse(line);
        if(message.type==='configure') {
          configuration=message;
          if(args.includes('--inspect')) { console.log(JSON.stringify({assistantProtocolVersion:${assistantProtocol},projects:[{id:assistantId,name:'Project Assistant',folderPath:message.assistantProjectDir,projectType:'conversation',fields:[],entrypoints:[],tools:[{name:'skill'}]}],errors:[]}));input.close();process.stdin.pause();return; }
          authenticate(message);
          if(${fail}) {console.error(message.connection?.accessToken);process.exit(1);}
          const studioControl={hasUrl:!!process.env.STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL,hasToken:!!process.env.STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN,mcpServer:process.env.STEAMHARNESS_STUDIO_CONTROL_MCP_SERVER??null,permissionPolicy:process.env.STEAMHARNESS_STUDIO_CONTROL_PERMISSION_POLICY??null};
          server=createServer((request,response)=>{
            response.setHeader('Content-Type','application/json');
            if(request.url==='/crash') {
              const token=configuration.connection?.accessToken??'';
              process.stderr.write('x'.repeat(7995)+token.slice(0,5));
              setTimeout(()=>{process.stderr.write(token.slice(5)+' '+(effectiveConnection?.aiAccessToken??'')+' '+(process.env.STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN??'')+' diagnostic tail');response.end('{}');setTimeout(()=>process.exit(23),10);},10);
              return;
            }
            response.end(JSON.stringify({configuration,effectiveConnection,args,pid:process.pid,authMessages,userSettingsMessages,studioControl}));
          });
          setTimeout(()=>server.listen(Number(args[args.indexOf('--port')+1]??0),'127.0.0.1',()=>console.log(JSON.stringify({type:'ready',protocolVersion:1,hostProtocolVersion:${protocol},accountProtocolVersion:${accountProtocol},systemAiConnectionProtocolVersion:${systemAiProtocol},relatedProjectsProtocolVersion:${relatedProtocol},userSettingsProtocolVersion:${userSettingsProtocol},assistantProtocolVersion:${assistantProtocol},url:'http://127.0.0.1:'+server.address().port+'/#session='+'a'.repeat(64),project:{id:message.assistantProjectDir?assistantId:'user',name:message.assistantProjectDir?'Project Assistant':version,projectType:'conversation'},runtime:{harnessVersion:version,harnessPath:process.cwd()+'/node_modules/steamharness/dist/index.js'}}))),${startupDelay});
        } else if(message.type==='auth') {authMessages++;authenticate(message);configuration.connection=message.connection;configuration.systemAiConnection=message.systemAiConnection;}
        else if(message.type==='related-projects') {configuration.relatedProjects=message.relatedProjects;}
        else if(message.type==='user-settings') {if(${userSettingsProtocol}!==1) process.exit(31);userSettingsMessages++;configuration.userSettings=message.userSettings;}
        else if(message.type==='close') {input.close();process.stdin.pause();server?.close();}
      });
      input.on('close',()=>{process.stdin.pause();server?.close();});
    }
  `);
  return { directory, cli, options: { projectDir: directory, dataDir: path.join(directory, 'data'), nodePath: process.execPath, theme: 'dark', surface: 'editor' } };
}

test('user settings use host stdin, deduplicate updates and respect older CLI capabilities', async t => {
  for (const protocol of [0, 1]) {
    const f = await fixture(t, '1.0.0', 1, false, 0, 1, 1, 1, 1, protocol);
    const initial = { agent: { permissionPolicy: 'auto' } }, next = { agent: { permissionPolicy: 'read-only' } };
    const session = await startProjectCli({ ...f.options, userSettings: initial }); t.after(() => session.close());
    session.updateUserSettings(initial);
    session.updateUserSettings(next); session.updateUserSettings(structuredClone(next));
    const state = await (await fetch(session.ready.url)).json();
    assert.deepEqual(state.configuration.userSettings, protocol === 1 ? next : initial);
    assert.equal(state.userSettingsMessages, protocol === 1 ? 1 : 0);
  }
});

test('each project resolves its own CLI and runs its own inspection', async t => {
  const first = await fixture(t, '1.2.3');
  const second = await fixture(t, '2.3.4');
  assert.equal((await resolveProjectCli(first.directory)).version, '1.2.3');
  assert.equal((await resolveProjectCli(second.directory)).version, '2.3.4');
  assert.equal((await inspectProjectCli(first.directory, process.execPath)).projects[0].name, '1.2.3');
  assert.equal((await inspectProjectCli(second.directory, process.execPath)).projects[0].name, '2.3.4');
  const alias = path.join(second.directory, 'linked-project');
  await fs.symlink(first.directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await inspectProjectCli(alias, process.execPath)).projects[0].folderPath, alias);
});

test('a missing project CLI fails without falling back to a workstation runtime', async t => {
  const { directory } = await fixture(t);
  await fs.rm(path.join(directory, 'node_modules'), { recursive: true });
  await assert.rejects(resolveProjectCli(directory), /@steamharness\/cli/);
});

test('setup inspection supplements old CLI validation summaries with structured violations', async t => {
  const { directory, cli } = await fixture(t);
  await fs.writeFile(path.join(cli, 'dist/index.js'), `
    const summary = 'Workflow "Created" script validation failed.';
    if (process.argv.includes('structure')) {
      console.log(JSON.stringify({ diagnostics: { error: { metadata: { violations: [{ message: 'The executor must declare projectType.' }] } } } }));
      process.exitCode = 1;
    } else { console.log(JSON.stringify({ projects: [], errors: [summary] })); }
  `);
  const ordinary = await inspectProjectCli(directory, process.execPath);
  assert.equal(ordinary.errors.length, 1);
  const detailed = await inspectProjectCli(directory, process.execPath, undefined, undefined, undefined, 'zh-cn', true);
  assert.equal(detailed.projects.length, 0);
  assert.match(detailed.errors.join('\n'), /script validation failed[\s\S]*executor must declare projectType/);
});

test('reinstalling a project CLI uses the new package in the same host process', async t => {
  const first = await fixture(t, '1.2.3');
  const second = await fixture(t, '2.3.4');
  const previous = path.join(first.directory, 'previous-cli');
  await fs.rename(first.cli, previous);
  await fs.symlink(previous, first.cli, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await resolveProjectCli(first.directory)).version, '1.2.3');
  await fs.unlink(first.cli);
  await fs.symlink(second.cli, first.cli, process.platform === 'win32' ? 'junction' : 'dir');
  const current = await resolveProjectCli(first.directory);
  assert.equal(current.version, '2.3.4');
  assert.equal(current.entry, path.join(await fs.realpath(second.cli), 'dist/index.js'));
  assert.equal((await inspectProjectCli(first.directory, process.execPath)).projects[0].name, '2.3.4');
  await fs.unlink(first.cli);
  await assert.rejects(resolveProjectCli(first.directory), /@steamharness\/cli/);
});

test('nested projects resolve CLI packages hoisted to a parent node_modules', async t => {
  const { directory, cli } = await fixture(t);
  const nested = path.join(directory, 'packages', 'conversation');
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(nested, 'package.json'), '{"name":"nested-conversation"}');
  assert.equal((await resolveProjectCli(nested)).entry, path.join(await fs.realpath(cli), 'dist/index.js'));
});

test('the independent assistant launches its own CLI and Core in its own workspace', async t => {
  const first = await fixture(t, '1.2.3');
  const second = await fixture(t, '2.3.4');
  const workdir = path.join(first.directory, 'workspace');
  await fs.mkdir(workdir);
  const assistantProjectDir = first.directory;
  const assistant = { standalone: true, workdir, roots: [{ uri: `file://${workdir}`, folderPath: workdir, name: 'Assistant' }] };
  const inspected = await inspectProjectCli(assistantProjectDir, process.execPath, undefined, assistantProjectDir, assistant);
  assert.equal(inspected.projects[0].name, 'Project Assistant');
  assert.equal(inspected.projects[0].folderPath, assistantProjectDir);
  assert.ok(inspected.projects[0].tools.some(tool => tool.name === 'skill'));
  const session = await startProjectCli({ ...first.options, surface: 'assistant', assistantProjectDir, assistant,
    expectedProjectId: 'a3aca697-b086-459b-84e4-d357ad2d9fb2' });
  t.after(() => session.close());
  const result = await fetch(new URL(session.ready.url).origin).then(response => response.json());
  assert.equal(session.ready.project.name, 'Project Assistant');
  assert.equal(path.normalize(session.ready.runtime.harnessPath), path.join(await fs.realpath(first.directory), 'node_modules/steamharness/dist/index.js'));
  assert.notEqual(session.ready.runtime.harnessVersion, (await inspectProjectCli(second.directory, process.execPath)).projects[0].name);
  assert.equal(result.args[result.args.indexOf('web') + 1], assistantProjectDir);
  assert.equal(result.configuration.surface, 'assistant');
  assert.equal(result.configuration.assistantProjectDir, assistantProjectDir);
  assert.deepEqual(result.configuration.assistant, assistant);
});

test('a CLI without dedicated assistant support cannot silently run the workspace executor', async t => {
  const { options, directory } = await fixture(t, 'old-assistant', 1, false, 0, 0);
  const assistantProjectDir = path.join(directory, 'dedicated-assistant');
  await assert.rejects(inspectProjectCli(directory, process.execPath, undefined, assistantProjectDir), /@steamharness\/cli/);
  await assert.rejects(startProjectCli({ ...options, surface: 'assistant', assistantProjectDir, assistant: { workdir: directory, roots: [{ uri: `file://${directory}`, folderPath: directory, name: 'Current' }] } }), /@steamharness\/cli/);
});

test('host credentials use stdin and can change without restarting the CLI', async t => {
  const { options } = await fixture(t);
  const connection = { serverUrl: 'https://steamharness.test', accessToken: 'private-host-token' };
  const session = await startProjectCli({ ...options, connection });
  t.after(() => session.close());
  const origin = new URL(session.ready.url).origin;
  const initial = await fetch(origin).then(response => response.json());
  assert.deepEqual(initial.configuration.connection, connection);
  assert.equal(initial.args.join(' ').includes(connection.accessToken), false);
  session.updateAuth({ ...connection });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await fetch(origin).then(response => response.json())).authMessages, 0);
  session.updateAuth({ ...connection, accessToken: 'replacement-token' });
  let next;
  for (let attempt = 0; attempt < 100; attempt++) {
    next = await fetch(origin).then(response => response.json());
    if (next.configuration.connection.accessToken === 'replacement-token') { break; }
  }
  assert.equal(next.configuration.connection.accessToken, 'replacement-token');
  assert.equal(next.pid, initial.pid);
  session.updateAuth();
  for (let attempt = 0; attempt < 100; attempt++) {
    next = await fetch(origin).then(response => response.json());
    if (next.configuration.connection === null) { break; }
  }
  assert.equal(next.configuration.connection, null);
});

test('legacy editor CLIs start and rotate project accounts without assistant-only AI fields', async t => {
  const { options } = await fixture(t, '0.1.1', 1, false, 0, 1, 1, 1, 0);
  const project = { serverUrl: 'https://project.test', accessToken: 'project-fixture' };
  const connection = { ...project, aiServerUrl: 'https://ai.test', aiAccessToken: 'ai-fixture' };
  const session = await startProjectCli({ ...options, connection });
  t.after(() => session.close());
  const read = () => fetch(new URL(session.ready.url).origin).then(response => response.json());
  const initial = await read();
  assert.deepEqual(initial.configuration.connection, project);
  assert.deepEqual(initial.effectiveConnection, project);
  assert.equal(initial.configuration.surface, 'editor');
  assert.equal(initial.configuration.assistant, undefined);
  assert.ok(!initial.args.join(' ').includes('fixture'));
  session.updateAuth({ ...connection, aiAccessToken: 'rotated-ai-fixture' });
  assert.equal((await read()).authMessages, 0);
  session.updateAuth({ ...connection, accessToken: 'rotated-project-fixture' });
  let next;
  for (let attempt = 0; attempt < 100; attempt++) {
    next = await read();
    if (next.effectiveConnection.accessToken === 'rotated-project-fixture') break;
  }
  assert.deepEqual(next.effectiveConnection, { ...project, accessToken: 'rotated-project-fixture' });
  assert.equal(next.configuration.systemAiConnection, undefined);
  assert.equal(next.pid, initial.pid);
  session.updateAuth();
  for (let attempt = 0; attempt < 100; attempt++) {
    next = await read(); if (next.effectiveConnection === null) break;
  }
  assert.equal(next.effectiveConnection, null);
});

test('capable editor CLIs receive separate system AI on startup, rotation and revocation', async t => {
  // The same package version can exist before and after protocol support.
  const { options } = await fixture(t, '0.1.1');
  const project = { serverUrl: 'https://project.test', accessToken: 'project-fixture' };
  const connection = { ...project, aiServerUrl: 'https://ai.test', aiAccessToken: 'ai-fixture' };
  const session = await startProjectCli({ ...options, connection });
  t.after(() => session.close());
  const read = () => fetch(new URL(session.ready.url).origin).then(response => response.json());
  const initial = await read();
  assert.equal(session.ready.systemAiConnectionProtocolVersion, 1);
  assert.deepEqual(initial.configuration.connection, project);
  assert.deepEqual(initial.configuration.systemAiConnection, { serverUrl: connection.aiServerUrl, accessToken: connection.aiAccessToken });
  assert.deepEqual(initial.effectiveConnection, connection);
  session.updateAuth({ ...connection });
  assert.equal((await read()).authMessages, 0);
  const rotated = { ...connection, aiAccessToken: 'rotated-ai-fixture' };
  session.updateAuth(rotated);
  let next;
  for (let attempt = 0; attempt < 100; attempt++) {
    next = await read(); if (next.effectiveConnection.aiAccessToken === rotated.aiAccessToken) break;
  }
  assert.deepEqual(next.effectiveConnection, rotated);
  assert.equal(next.pid, initial.pid);
  session.updateAuth(project);
  for (let attempt = 0; attempt < 100; attempt++) {
    next = await read(); if (!next.effectiveConnection.aiAccessToken) break;
  }
  assert.deepEqual(next.effectiveConnection, project);
  session.updateAuth();
  for (let attempt = 0; attempt < 100; attempt++) {
    next = await read(); if (next.effectiveConnection === null) break;
  }
  assert.equal(next.effectiveConnection, null);
});

test('legacy assistant CLIs retain their existing independent AI authentication', async t => {
  const { options, directory } = await fixture(t, '0.1.1', 1, false, 0, 1, 1, 1, 0);
  const connection = { serverUrl: 'https://project.test', accessToken: 'project-fixture', aiServerUrl: 'https://ai.test', aiAccessToken: 'ai-fixture' };
  const session = await startProjectCli({ ...options, surface: 'assistant', assistantProjectDir: directory,
    assistant: { workdir: directory, roots: [{ uri: `file://${directory}`, folderPath: directory, name: 'Workspace' }] }, connection });
  t.after(() => session.close());
  const read = () => fetch(new URL(session.ready.url).origin).then(response => response.json());
  assert.deepEqual((await read()).effectiveConnection, connection);
  session.updateAuth({ ...connection, aiAccessToken: 'rotated-ai-fixture' });
  let next;
  for (let attempt = 0; attempt < 100; attempt++) {
    next = await read(); if (next.effectiveConnection.aiAccessToken === 'rotated-ai-fixture') break;
  }
  assert.deepEqual(next.effectiveConnection, { ...connection, aiAccessToken: 'rotated-ai-fixture' });
});

test('closing a tab closes its service and is repeatable', async t => {
  const { options } = await fixture(t);
  const session = await startProjectCli(options);
  let exited = 0;
  session.onExit(() => exited++);
  await Promise.all([session.close(), session.close()]);
  assert.equal(exited, 1);
  await assert.rejects(fetch(new URL(session.ready.url).origin));
});

test('unsupported project CLIs fail and are cleaned up', async t => {
  const { options } = await fixture(t, 'old', 0);
  await assert.rejects(startProjectCli(options), /@steamharness\/cli/);
});

test('a CLI without authoritative host accounts cannot restore a separate project login', async t => {
  const { options } = await fixture(t, 'old-account', 1, false, 0, 1, 0);
  await assert.rejects(startProjectCli(options), /@steamharness\/cli/);
});

test('signed-out Studio explicitly configures the project with no account', async t => {
  const { options } = await fixture(t);
  const session = await startProjectCli(options);
  t.after(() => session.close());
  const result = await fetch(new URL(session.ready.url).origin).then(response => response.json());
  assert.equal(result.configuration.connection, null);
});

test('a normal project can receive an explicit control connection without assistant configuration', async t => {
  const { options } = await fixture(t);
  const session = await startProjectCli({ ...options, studioControl: { url: 'http://127.0.0.1:12345/studio-control', token: 'control-test-token' } });
  t.after(() => session.close());
  const result = await fetch(new URL(session.ready.url).origin).then(response => response.json());
  assert.deepEqual(result.studioControl, { hasUrl: true, hasToken: true, mcpServer: null, permissionPolicy: null });
  assert.equal(result.configuration.surface, 'editor');
  assert.equal(result.configuration.assistant, undefined);
  assert.equal(result.configuration.assistantProjectDir, undefined);
  assert.equal(result.args.includes('control-test-token'), false);
});

test('ordinary projects cannot inherit a control connection or permission from the host environment', async t => {
  const { options } = await fixture(t);
  const keys = ['STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL', 'STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN', 'STEAMHARNESS_STUDIO_CONTROL_MCP_SERVER', 'STEAMHARNESS_STUDIO_CONTROL_PERMISSION_POLICY'];
  const original = keys.map(key => process.env[key]);
  t.after(() => keys.forEach((key, index) => { if (original[index] === undefined) delete process.env[key]; else process.env[key] = original[index]; }));
  for (const key of keys) process.env[key] = 'inherited-test-value';
  const session = await startProjectCli(options);
  t.after(() => session.close());
  const result = await fetch(new URL(session.ready.url).origin).then(response => response.json());
  assert.deepEqual(result.studioControl, { hasUrl: false, hasToken: false, mcpServer: null, permissionPolicy: null });
});

test('imported related bindings are configured and updated without restarting the project CLI', async t => {
  const { options, directory } = await fixture(t);
  const relatedProjects = [{ alias: 'database', projectDir: path.join(directory, 'imported-database') }];
  const session = await startProjectCli({ ...options, relatedProjects });
  t.after(() => session.close());
  const origin = new URL(session.ready.url).origin;
  const initial = await fetch(origin).then(response => response.json());
  assert.deepEqual(initial.configuration.relatedProjects, relatedProjects);
  session.updateRelatedProjects([]);
  let next;
  for (let attempt = 0; attempt < 100; attempt++) {
    next = await fetch(origin).then(response => response.json());
    if (!next.configuration.relatedProjects.length) { break; }
  }
  assert.deepEqual(next.configuration.relatedProjects, []);
  assert.equal(next.pid, initial.pid);
});

test('an old project CLI cannot silently ignore imported related bindings', async t => {
  const { options, directory } = await fixture(t, 'old-related', 1, false, 0, 1, 1, 0);
  const relatedProjects = [{ alias: 'database', projectDir: path.join(directory, 'database') }];
  await assert.rejects(startProjectCli({ ...options, relatedProjects }), /@steamharness\/cli/);
  const session = await startProjectCli(options);
  t.after(() => session.close());
  assert.throws(() => session.updateRelatedProjects(relatedProjects), /@steamharness\/cli/);
});

test('closing a workspace aborts an unfinished CLI startup', async t => {
  const { options } = await fixture(t, 'slow', 1, false, 60_000);
  const controller = new AbortController();
  const startup = startProjectCli({ ...options, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(startup, /abort/i);
});

test('an unexpected CLI exit is reported and the project can start again', async t => {
  const { options } = await fixture(t);
  const first = await startProjectCli(options);
  const pid = (await fetch(new URL(first.ready.url).origin).then(response => response.json())).pid;
  let exited = false;
  first.onExit(() => { exited = true; });
  process.kill(pid);
  await first.closed;
  assert.equal(exited, true);
  const second = await startProjectCli(options);
  t.after(() => second.close());
  const result = await fetch(new URL(second.ready.url).origin).then(response => response.json());
  assert.notEqual(result.pid, pid);
});

test('runtime exits retain code and bounded diagnostics with rotated credentials redacted', async t => {
  const { options } = await fixture(t);
  const session = await startProjectCli({ ...options, connection: { serverUrl: 'https://fixture.test', accessToken: 'old-secret-fixture-token' },
    studioControl: { url: 'http://127.0.0.1:12345', token: 'control-secret-fixture-token' } });
  t.after(() => session.close());
  session.updateAuth({ serverUrl: 'https://fixture.test', accessToken: 'rotated-secret-fixture-token', aiServerUrl: 'https://ai.test', aiAccessToken: 'ai-secret-fixture-token' });
  const exited = new Promise(resolve => session.onExit(resolve));
  await fetch(new URL('/crash', session.ready.url));
  const exit = await exited; await session.closed;
  assert.equal(exit.code, 23); assert.equal(exit.signal, null);
  assert.ok(exit.stderr.length <= 8000);
  assert.match(exit.stderr, /\[redacted\].*diagnostic tail/);
  for (const token of ['old-secret-fixture-token', 'rotated-secret-fixture-token', 'ai-secret-fixture-token', 'control-secret-fixture-token']) assert.ok(!exit.stderr.includes(token));
  assert.deepEqual(await new Promise(resolve => session.onExit(resolve)), exit);
});

test('startup failures redact the injected account token', async t => {
  const { options } = await fixture(t, 'broken', 1, true);
  await assert.rejects(startProjectCli({ ...options, connection: { serverUrl: 'https://steamharness.test', accessToken: 'secret-fixture-token' } }), error => {
    assert.ok(!error.message.includes('secret-fixture-token'));
    assert.match(error.message, /redacted/); return true;
  });
});

test('the tab contains a CLI frame and no second conversation renderer', () => {
  const html = projectFrameHtml(`http://127.0.0.1:3000/#session=${'a'.repeat(64)}`, '<User project>', 'file:///user/project', 'dark', 'fixture');
  assert.match(html, /<iframe/); assert.match(html, /frame-src http:\/\/127.0.0.1:3000/);
  assert.match(html, /&lt;User project&gt;/); assert.match(html, /vscode.setState/);
  assert.doesNotMatch(html, /workflow-ui\.js|id="app"|core\.mjs/);
  assert.throws(() => projectFrameHtml('javascript:alert(1)', 'Project', 'user', 'dark', 'fixture'), /Invalid/);
});

test('the project frame retains the latest native chrome reservation across iframe loads', () => {
  const listeners = new Map(), frameListeners = new Map(), messages = [], native = [];
  const frame = { contentWindow: { postMessage: message => messages.push(message) }, addEventListener: (type, callback) => frameListeners.set(type, callback) };
  const initial = { active: true, projectUri: 'file:///project', height: 52, left: 228, right: 0, revision: 1 };
  const html = projectFrameHtml('http://127.0.0.1:3000/', 'Project', initial.projectUri, 'dark', 'fixture', 'en', initial);
  runInNewContext(/<script nonce="fixture">([\s\S]*?)<\/script>/.exec(html)[1], {
    acquireVsCodeApi: () => ({ setState() {}, postMessage: message => native.push(JSON.parse(JSON.stringify(message))) }),
    document: { getElementById: () => frame, documentElement: { dataset: {} } },
    addEventListener: (type, callback) => listeners.set(type, callback),
  });
  frameListeners.get('load')();
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1).windowChrome)), initial);
  const drag = { type: 'workflow-window-drag', version: 1, width: 800, height: 600, regions: [{ x: 300, y: 0, width: 100, height: 52 }] };
  const event = { source: frame.contentWindow, origin: 'http://127.0.0.1:3000', data: drag };
  const before = native.length;
  listeners.get('message')({ ...event, origin: 'https://unrelated.example' });
  assert.equal(native.length, before);
  listeners.get('message')(event);
  assert.deepEqual(native.at(-1), { ...drag, type: 'studio-window-drag-regions' });
  const next = { ...initial, active: false, revision: 2 };
  listeners.get('message')({ data: { type: 'workflow-host', windowChrome: next } });
  assert.deepEqual(native.at(-1).regions, []);
  const cleared = native.length;
  listeners.get('message')(event);
  assert.equal(native.length, cleared);
  // An embedded page cannot change its own host reservation.
  listeners.get('message')({ source: frame.contentWindow, origin: 'http://127.0.0.1:3000', data: { type: 'workflow-host', windowChrome: initial } });
  frameListeners.get('load')();
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1).windowChrome)), next);
});

for (const language of ['en', 'zh-cn']) {
  test(`the project CLI and embedded frame receive the ${language} host language`, async t => {
    const { options } = await fixture(t);
    const session = await startProjectCli({ ...options, locale: language });
    t.after(() => session.close());
    const result = await fetch(new URL(session.ready.url).origin).then(response => response.json());
    const normalized = language === 'en' ? 'en' : 'zh-CN';
    assert.equal(result.args[result.args.indexOf('--locale') + 1], normalized);
    const html = projectFrameHtml(session.ready.url, 'Project', 'project', 'dark', 'test', language);
    assert.ok(html.includes(`projectLocale=${normalized}`));
    assert.ok(html.includes(`locale:"${normalized}"`));
    assert.ok(html.includes(`<html lang="${normalized}">`));
  });
}

test('Retry restores an exited CLI on the same origin and never duplicates a live process', async t => {
  const { options } = await fixture(t);
  const first = await startProjectCli(options);
  let starts = 0, exits = 0, closed = false;
  const session = new RecoverableWebSession(first, async (port, signal) => {
    starts++;
    return startProjectCli({ ...options, port, signal });
  });
  t.after(() => session.close());
  let exitDetails;
  session.onExit(exit => { exits++; exitDetails = exit; });
  void session.closed.then(() => { closed = true; });
  const origin = new URL(first.ready.url).origin;
  const initial = await fetch(origin).then(response => response.json());
  assert.equal(await session.reconnect(), false);
  assert.equal(starts, 0);
  process.kill(initial.pid);
  await first.closed;
  assert.equal(exits, 1); assert.equal(closed, false);
  assert.ok(exitDetails); assert.ok('code' in exitDetails && 'signal' in exitDetails && 'stderr' in exitDetails);
  const connection = { serverUrl: 'https://current.test', accessToken: 'latest-account' };
  const userSettings = { agent: { permissionPolicy: 'read-only' } };
  session.updateAuth(connection);
  session.updateRelatedProjects([{ alias: 'latest', projectDir: options.projectDir }]);
  session.updateUserSettings(userSettings);
  userSettings.agent.permissionPolicy = 'auto';
  assert.deepEqual(await Promise.all([session.reconnect(), session.reconnect()]), [true, true]);
  assert.equal(starts, 1); assert.equal(new URL(session.ready.url).origin, origin);
  let recovered;
  for (let i = 0; i < 100; i++) {
    recovered = await fetch(origin).then(response => response.json());
    if (recovered.configuration.connection?.accessToken === connection.accessToken && recovered.configuration.relatedProjects[0]?.alias === 'latest' && recovered.configuration.userSettings?.agent.permissionPolicy === 'read-only') break;
  }
  assert.notEqual(recovered.pid, initial.pid);
  assert.equal(recovered.configuration.connection.accessToken, connection.accessToken);
  assert.equal(recovered.configuration.relatedProjects[0].alias, 'latest');
  assert.equal(recovered.configuration.userSettings.agent.permissionPolicy, 'read-only', 'Recovery uses the last copied user snapshot');
  await session.close(); assert.equal(closed, true);
  await assert.rejects(session.reconnect(), /closed/);
});

test('closing a page cancels CLI recovery before another owner can be left running', async t => {
  const { options } = await fixture(t);
  const first = await startProjectCli(options);
  const pid = (await fetch(new URL(first.ready.url).origin).then(response => response.json())).pid;
  let entered;
  const starting = new Promise(resolve => { entered = resolve; });
  const session = new RecoverableWebSession(first, (port, signal) => new Promise((resolve, reject) => {
    entered(); signal.addEventListener('abort', () => reject(new Error('Recovery aborted')), { once: true });
  }));
  t.after(() => session.close());
  process.kill(pid); await first.closed;
  const reconnecting = session.reconnect();
  const rejected = assert.rejects(reconnecting, /aborted/);
  await starting; await session.close(); await rejected;
});

test('a failed CLI restart leaves Retry available for the next attempt', async t => {
  const { options } = await fixture(t);
  const first = await startProjectCli(options);
  const pid = (await fetch(new URL(first.ready.url).origin).then(response => response.json())).pid;
  let fail = true;
  const session = new RecoverableWebSession(first, (port, signal) => {
    if (fail) return Promise.reject(new Error('Dependencies are not ready'));
    return startProjectCli({ ...options, port, signal });
  });
  t.after(() => session.close());
  process.kill(pid); await first.closed;
  await assert.rejects(session.reconnect(), /Dependencies/);
  fail = false; assert.equal(await session.reconnect(), true);
});
