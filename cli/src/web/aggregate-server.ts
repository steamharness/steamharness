import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { selectProjectEntry } from '@steamharness/project-manifest';
import { readProjectManifestFromDirectory } from '@steamharness/project-manifest/node';
import { startEntryWebServer, type WebOptions } from './server';
import type { Project } from './workflow-types';
import { t } from './localization';
import { sharedWebLogin } from './account-auth';
import type { AggregateEntryCall } from './entry-conversations';
import { studioPreviewMount } from './studio-preview-mount';

type EntryHost = Awaited<ReturnType<typeof startEntryWebServer>>;
const escape = (value: string) => value.replace(/[&<>"']/g, value => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[value]!));

/** One public HTTP service; each registered entry owns its controllers and state. */
export async function startAggregateWebServer(options: WebOptions) {
  const directory = options.host?.assistantProjectDir ?? options.projectDir;
  const folderBot = options.host?.folderBot;
  const readManifest = async () => {
    if (folderBot && !await realpath(folderBot.directory).then(async resolved => resolved === folderBot.directory && (await stat(resolved)).isDirectory()).catch(() => false)) {
      throw new Error('The local Bot folder is unavailable or has changed.');
    }
    const declaration = await readProjectManifestFromDirectory(directory);
    if (!folderBot) return declaration;
    const entry = selectProjectEntry(declaration, options.entryId);
    if (entry.entryId !== declaration.defaultEntry || entry.type !== 'bot' || entry.folderContext !== true || declaration.projectId !== folderBot.projectId) {
      throw new Error('The local Bot entry or its folder support has changed.');
    }
    return { ...declaration, entries: [entry] };
  };
  let manifest = await readManifest();
  const selectedId = selectProjectEntry(manifest, options.entryId).entryId;
  const credentials = { capability: randomBytes(32).toString('hex'), cookie: `project_web_${randomBytes(8).toString('hex')}` };
  const entries = new Map<string, EntryHost>(), failures = new Map<string, string>();
  const starting = new Map<string, Promise<void>>();
  let activeCalls = 0;
  const trackCall = async (call: () => Promise<unknown>) => {
    activeCalls++;
    try { return await call(); } finally { activeCalls--; }
  };
  const invokeEntry = async (call: AggregateEntryCall): Promise<unknown> => {
    if (closing || replacing) throw new Error('The aggregate execution host changed.');
    call.abortSignal?.throwIfAborted();
    if (call.projectId !== manifest.projectId) throw new Error("The aggregate project identity changed.");
    selectProjectEntry(manifest, call.sourceEntryId);
    const target = selectProjectEntry(manifest, call.entryId);
    if (target.type !== (call.action === 'workflow' || call.action === 'workflow-control' ? 'workflow' : 'bot')) throw new Error('The entry does not support this operation.');
    const runtime = entries.get(call.entryId);
    if (!runtime) throw new Error('The target entry is unavailable.');
    return trackCall(() => runtime.invokeEntry(call));
  };
  let origin = '', closing = false, replacing = false, resetting: Promise<void> | undefined;
  let host = options.host;
  const catalog = () => ({ projectId: manifest.projectId, name: manifest.name, defaultEntry: manifest.defaultEntry, entries: manifest.entries.map(entry => {
    const running = entries.get(entry.entryId);
    return { entryId: entry.entryId, name: entry.name, type: entry.type, projectCard: entry.projectCard, href: `/entries/${entry.entryId}/`, status: failures.has(entry.entryId) ? 'error' : running?.running ? 'running' : running ? 'idle' : 'starting' };
  }) });
  const matches = (value: string) => { const input = Buffer.from(value), expected = Buffer.from(credentials.capability); return input.length === expected.length && timingSafeEqual(input, expected); };
  const launch = (entryId: string): Promise<void> => {
    if (starting.has(entryId)) return starting.get(entryId)!;
    failures.delete(entryId);
    const pending = (async () => {
      try {
        const runtime = await startEntryWebServer({ ...options, runtimePersistence: options.runtimePersistenceForEntry?.(entryId) ?? options.runtimePersistence, host, projectDir: directory, entryId,
          mount: { openConversationView: (source, target, emit) => {
            if (closing || replacing || source.projectId !== manifest.projectId) throw new Error('The aggregate host changed.');
            selectProjectEntry(manifest, source.entryId);
            if (selectProjectEntry(manifest, target.entryId).type !== 'bot') throw new Error('The target is not a Bot.');
            const runtime = entries.get(target.entryId);
            if (!runtime) throw Object.assign(new Error('Conversation entry unavailable.'), { code: 'ENTRY_RUNTIME_UNAVAILABLE' });
            return runtime.openConversationView(source, target, emit);
          }, origin, basePath: `/entries/${entryId}`, catalog, identityChanged: reset, reloadProject: () => reload(entryId), invokeEntry,
            subscribeConversation(sourceEntryId, targetId, conversationId, listener) {
              selectProjectEntry(manifest, sourceEntryId);
              if (closing || replacing || selectProjectEntry(manifest, targetId).type !== 'bot') throw new Error('The conversation entry is unavailable.');
              const target = entries.get(targetId);
              if (!target) throw new Error('The conversation entry is unavailable.');
              return target.subscribeConversation(conversationId, listener);
            },
          } }, credentials);
        if (closing) await runtime.close(); else entries.set(entryId, runtime);
      } catch (error) { failures.set(entryId, error instanceof Error ? error.message : String(error)); }
    })().finally(() => starting.delete(entryId));
    starting.set(entryId, pending); return pending;
  };
  const busyError = () => new Error(t('The project is busy or waiting for input. Try again when it is idle.'));
  const assertIdle = () => {
    if (activeCalls > 0 || [...entries.values()].some(entry => entry.reloadBusy)) throw busyError();
  };
  const reload = async (requestedEntry?: string) => {
    if (closing || resetting) throw new Error(t('The project is already reloading. Try again shortly.'));
    if (requestedEntry) assertIdle();
    else replacing = true;
    const operation = (async () => {
      // An invalid declaration must not take the current project offline.
      const next = await readManifest();
      await Promise.all([...starting.values()]);
      if (requestedEntry) {
        // Let ordinary requests (including draft writes) settle without cancelling any runs.
        const deadline = new AbortController();
        const timeout = delay(5_000, 'timeout', { signal: deadline.signal, ref: false }).catch(() => undefined);
        try {
          for (;;) {
            assertIdle();
            const requests = [...entries.values()].flatMap(entry => entry.pendingMessages);
            if (requests.length === 0) break;
            if (await Promise.race([Promise.allSettled(requests), timeout]) === 'timeout') throw busyError();
          }
        } finally { deadline.abort(); }
      }
      replacing = true;
      await Promise.all([...entries.values()].map(entry => entry.close()));
      entries.clear(); failures.clear();
      manifest = next;
      if (!closing) await Promise.all(manifest.entries.map(entry => launch(entry.entryId)));
      return requestedEntry && !next.entries.some(entry => entry.entryId === requestedEntry) ? next.defaultEntry : undefined;
    })().finally(() => { replacing = false; resetting = undefined; });
    // Host updates and shutdown wait for the attempt, not its browser-facing result.
    resetting = operation.then(() => undefined, () => undefined);
    return operation;
  };
  const reset = () => {
    if (closing || resetting) return;
    void reload().catch(error => process.stderr.write(`Aggregate project reload: ${String(error)}\n`));
  };
  const recovery = (entryId: string, mount: string, nonce: string) => {
    const entry = selectProjectEntry(manifest, entryId);
    const links = manifest.entries.map(item => `<option value="${escape(item.entryId)}"${item.entryId === entryId ? ' selected' : ''}>${escape(item.name)} · ${escape(item.type)}</option>`).join('');
    return `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(manifest.name)} / ${escape(entry.name)}</title><body><main><h1>${escape(manifest.name)} / ${escape(entry.name)}</h1><label>${escape(t('Project window'))} <select>${links}</select></label><p role="alert">${escape(t('This entry could not start. Fix its declaration or dependencies, then try again.'))}</p><pre></pre><button>${escape(t('Check again'))}</button></main><script nonce="${nonce}">
const mount=${JSON.stringify(mount)}, prefix=mount+'/entries/${entryId}', projectId=${JSON.stringify(manifest.projectId)}, session=new URLSearchParams(location.hash.slice(1)).get('session');
if(session){history.replaceState(null,'',location.pathname);}
const auth=session?fetch(prefix+'/api/session',{method:'POST',headers:{Authorization:'Bearer '+session}}):Promise.resolve();
document.querySelector('select').onchange=event=>{const entryId=event.target.value;if(parent!==window)parent.postMessage({type:'workflow-open-entry',version:1,projectId,entryId},'*');else location.assign(mount+'/entries/'+entryId+'/');};
document.querySelector('button').onclick=async event=>{event.target.disabled=true;try{await auth;const response=await fetch(prefix+'/api/retry',{method:'POST',headers:session?{Authorization:'Bearer '+session}:{}});const result=await response.json();if(!response.ok)throw new Error(result.message);if(result.ready)location.reload();else document.querySelector('pre').textContent=result.message;}catch(error){document.querySelector('pre').textContent=String(error);}finally{event.target.disabled=false;}};
</script></body></html>`;
  };
  const server = createServer((request, response) => {
    void (async () => {
      if (folderBot?.background) { response.writeHead(404); response.end(); return; }
      const url = new URL(request.url ?? '/', origin);
      if (url.pathname === '/') { response.writeHead(302, { Location: `/entries/${manifest.entries.some(item => item.entryId === selectedId) ? selectedId : manifest.defaultEntry}/${url.search}` }); response.end(); return; }
      const match = /^\/entries\/([a-z][a-z0-9_-]{0,63})(\/.*)?$/.exec(url.pathname);
      if (!match || !manifest.entries.some(entry => entry.entryId === match[1])) { response.writeHead(404); response.end('Unknown project entry.'); return; }
      if (!match[2]) { response.writeHead(302, { Location: `${url.pathname}/${url.search}` }); response.end(); return; }
      const entryId = match[1]!, runtime = entries.get(entryId);
      if (runtime) { request.url = `${match[2]}${url.search}`; runtime.handle(request, response); return; }
      if (match[2] === '/api/host-workflow-schedule') { response.writeHead(404).end(); return; }
      response.setHeader('Content-Type','application/json; charset=utf-8'); response.setHeader('Cache-Control','no-store');
      response.setHeader('X-Content-Type-Options','nosniff'); response.setHeader('Referrer-Policy','no-referrer');
      const requestOrigin = `http://${request.headers.host}`;
      const forwarded = !!host && ['127.0.0.1','localhost','[::1]'].includes(new URL(requestOrigin).hostname);
      const embeddedRecovery = !!host && match[2] === '/' && request.method === 'GET' && request.headers['sec-fetch-dest'] === 'iframe' && !request.headers.origin;
      if (request.headers.host !== new URL(origin).host && !forwarded || request.headers.origin && request.headers.origin !== requestOrigin || request.headers['sec-fetch-site'] === 'cross-site' && !embeddedRecovery) { response.writeHead(403); response.end(JSON.stringify({message:'Invalid request origin.'})); return; }
      if (match[2] === '/api/session' || match[2] === '/api/retry') {
        const cookie = String(request.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(`${credentials.cookie}=`))?.slice(credentials.cookie.length + 1) ?? '';
        if (!matches(String(request.headers.authorization ?? '').replace(/^Bearer /,'')) && !matches(cookie)) { response.writeHead(401); response.end(JSON.stringify({message:'Invalid session.'})); return; }
        if (request.method !== 'POST') { response.writeHead(405); response.end('{}'); return; }
        if (match[2] === '/api/session') { response.setHeader('Set-Cookie',`${credentials.cookie}=${credentials.capability}; HttpOnly; SameSite=Strict; Path=/`); response.end('{"ok":true}'); return; }
        await resetting; await launch(entryId);
        response.end(JSON.stringify({ready:entries.has(entryId),message:failures.get(entryId)})); return;
      }
      const nonce = randomBytes(16).toString('base64url');
      response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'`);
      response.setHeader('Content-Type','text/html; charset=utf-8'); response.end(recovery(entryId, host ? studioPreviewMount(request) : '', nonce));
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  server.on('upgrade', (request, socket, head) => {
    try {
      if (!host || folderBot?.background || !studioPreviewMount(request) || !request.url) { socket.destroy(); return; }
      const url = new URL(request.url, origin);
      const match = /^\/entries\/([a-z][a-z0-9_-]{0,63})\/studio-app(\/.*)$/.exec(url.pathname);
      const kanban = match && entries.get(match[1]!)?.kanbanController;
      const app = kanban && kanban.hostedPreview;
      if (!match || !app) { socket.destroy(); return; }
      request.url = match[2] + url.search;
      app.handleUpgrade(request, socket, head, origin);
    } catch { socket.destroy(); }
  });
  await new Promise<void>((resolve,reject) => { server.once('error',reject); server.listen(options.port ?? 0,'127.0.0.1',() => { server.off('error',reject); resolve(); }); });
  origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  await Promise.all(manifest.entries.map(entry => launch(entry.entryId)));
  if (folderBot && !entries.has(selectedId)) {
    await new Promise<void>(resolve => server.close(() => resolve()));
    throw new Error(failures.get(selectedId) ?? 'The local folder Bot could not start.');
  }
  const current = () => entries.get(selectedId) ?? entries.values().next().value;
  const project = (): Project => {
    const runtime = current(); if (runtime) return runtime.project;
    const entry = selectProjectEntry(manifest,manifest.entries.some(item => item.entryId === selectedId) ? selectedId : undefined);
    return {id:manifest.projectId,entryId:entry.entryId,name:entry.name,aggregateName:manifest.name,entries:manifest.entries,defaultEntry:manifest.defaultEntry,
      uri:directory,folderPath:directory,entryRoot:path.resolve(directory,entry.root),projectType:entry.type,fields:[],entrypoints:[]};
  };
  return {
    origin, url:`${origin}/entries/${selectedId}/#session=${credentials.capability}`,
    invokeEntry,
    hostTurn: async (entryId: string, input: Record<string, unknown>) => {
      const target = entries.get(entryId);
      if (closing || replacing || !target || selectProjectEntry(manifest,entryId).type !== 'bot') throw new Error('Conversation entry unavailable.');
      return trackCall(() => target.hostTurn(input));
    },
    get manifest() { return manifest; }, get project() { return project(); },
    get configurations() { return current()?.configurations; }, get controller() { return current()?.controller; },
    get restrictedConfigurationEntries() { return [...entries].filter(([, entry]) => entry.configurations?.state.profilePolicy).map(([id]) => id); },
    get webAppConfigurations() { return Object.fromEntries([...entries].filter(([, entry]) => entry.project.kanban?.webApp).map(([id, entry]) => [id, entry.kanbanController!.configuration()])); },
    get projectController() { return current()?.projectController; }, get kanbanController() { return current()?.kanbanController; },
    entryUrl:(entryId:string) => { selectProjectEntry(manifest,entryId); return `${origin}/entries/${entryId}/#session=${credentials.capability}`; },
    readModelRequest: (entryId: string, sessionId: string, messageId: string, executionId: string) => resetting ? undefined : entries.get(entryId)?.readModelRequest(sessionId, messageId, executionId),
    setHostUserSettings:async (value:Parameters<EntryHost['setHostUserSettings']>[0]) => { host={...host,surface:host?.surface??'editor',userSettings:value}; await resetting; await Promise.all([...entries.values()].map(entry => entry.setHostUserSettings(value))); },
    setHostResourceProjects:(value:string[]) => { host={...host,surface:host?.surface??'editor',resourceProjects:value}; for (const entry of entries.values()) entry.setHostResourceProjects(value); },
    setHostWebApps:async (value:Parameters<EntryHost['setHostWebApps']>[0]) => { host={...host,surface:host?.surface??'editor',webApps:value}; await resetting; await Promise.all([...entries.values()].map(entry => entry.setHostWebApps(value))); },
    setHostConnection:async (...[value, ai]:Parameters<EntryHost['setHostConnection']>) => { host={...host,surface:host?.surface??'editor',connection:value,systemAiConnection:ai}; await resetting; await Promise.all([...entries.values()].map(entry => entry.setHostConnection(value, ai))); },
    close:async () => {
      closing=true; await resetting; await Promise.all([...starting.values()]);
      try { await Promise.all([...entries.values()].map(entry => entry.close())); }
      finally {
        // Entry subscribers must detach before cancelling login emits an account change.
        sharedWebLogin(credentials).cancel();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    },
  };
}
