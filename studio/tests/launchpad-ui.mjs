import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { settingsFixture, settingsThemeCss } from './settings-ui-fixture.mjs';
import { checkLibraryExperience } from './launchpad-library-ui.mjs';
import { storeFixture } from './launchpad-store-ui.mjs';

// Render the desktop controller, creation dialog and Settings UI with isolated host services.
const kernel = fileURLToPath(new URL('../upstream/vscode/', import.meta.url));
const bootstrap = await build({ entryPoints: [`${kernel}/src/vs/code/electron-browser/workbench/workbench.ts`],
  bundle: true, write: false, format: 'esm', target: 'es2022' });
const origin = 'http://127.0.0.1:4321';
// An optional project image can be used for visual inspection without shipping private project assets.
const coverBytes = process.env.STUDIO_TEST_PROJECT_COVER ? await readFile(process.env.STUDIO_TEST_PROJECT_COVER) : Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF6sAAAAASUVORK5CYII=', 'base64');
const coverName = process.env.STUDIO_TEST_PROJECT_COVER?.endsWith('.webp') ? 'studio-cover.webp' : 'studio-cover.png';
const workbenchPath = `${origin}/out/vs/code/electron-browser/workbench`;
const workbenchMain = `${origin}/out/vs/workbench/workbench.desktop.main.js`;
const bundle = await build({ stdin: { resolveDir: kernel, contents: `
  import { StudioLaunchpad } from './src/vs/workbench/electron-browser/studioLaunchpad.ts';
  import { StudioProjectCreateDialog } from './src/vs/workbench/contrib/studioStart/browser/studioProjectCreateDialog.ts';
  import { URI } from './src/vs/base/common/uri.ts';
  import { decodeBase64 } from './src/vs/base/common/buffer.ts';
  import { StudioNotificationInbox } from './src/vs/workbench/electron-browser/studioNotificationInbox.ts';
  import { NotificationChangeType } from './src/vs/workbench/common/notifications.ts';
  import { Emitter, Event } from './src/vs/base/common/event.ts';
  import { observableValue } from './src/vs/base/common/observable.ts';
  import { OverlayWebview } from './src/vs/workbench/contrib/webview/browser/overlayWebview.ts';
  import { BrowserAuxiliaryWindowService } from './src/vs/workbench/services/auxiliaryWindow/browser/auxiliaryWindowService.ts';
  import { WebviewViewService } from './src/vs/workbench/contrib/webviewView/browser/webviewViewService.ts';
  import { Sash, Orientation } from './src/vs/base/browser/ui/sash/sash.ts';
  import './src/vs/base/browser/ui/splitview/splitview.css';
  import './src/vs/workbench/contrib/modernUI/browser/media/sashHandles.css';
  import { CommandsRegistry } from './src/vs/platform/commands/common/commands.ts';
  import { ContextMenuService } from './src/vs/platform/contextview/browser/contextMenuService.ts';
  import { ContextViewService } from './src/vs/platform/contextview/browser/contextViewService.ts';
  import { FileOperationError, FileOperationResult } from './src/vs/platform/files/common/files.ts';
  import { hostedSidebarHtml } from '../../extensions/studio-workstation/src/project-sidebar-html.ts';
  import { applyRecentMetadata, RECENT_PROJECTS_KEY } from '../../extensions/studio-workstation/src/projects.ts';
  const state = { canCreate: true, platform: window.enhanced, recent: [], recommendations: window.enhanced ? { items:window.storeFixture.recommendations } : undefined };
  const root = document.querySelector('.monaco-workbench');
  const [outer, inner] = root.querySelectorAll('.sash-container');
  const sashes = [new Sash(outer, {getHorizontalSashTop:()=>365}, {orientation:Orientation.HORIZONTAL}),
    new Sash(inner, {getVerticalSashLeft:()=>400}, {orientation:Orientation.VERTICAL})];
  window.sashDrags = [];
  sashes.forEach(sash=>sash.onDidStart(()=>window.sashDrags.push(sash.orientation)));
  const layoutChange = new Emitter();
  const layout = { mainContainer:root, activeContainer:root, getContainer:(_window,part)=>part ? root.querySelector('.titlebar') : root, mainContainerOffset:{top:36}, onDidLayoutMainContainer:layoutChange.event, onDidLayoutContainer:Event.None };
  window.placeWindowControls = side => {
    const controls=root.querySelector('.window-controls-container'); root.querySelector('.titlebar-'+side).append(controls);
    controls.style.width=side==='right'?'138px':'66px'; layoutChange.fire();
  };
  const chatAvatar = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#3063af"/></svg>');
  const chats = { connection:'connected', items:[{id:'group-team',group:true,time:Date.now(),name:'Team',preview:'Review',unread:2,avatarUrl:chatAvatar},{id:'solo',name:'Solo',preview:'Hi',unread:0,avatarUrl:'data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path fill="#345" d="M0 0h32v32H0z"/></svg>')}] };
  const zh = window._VSCODE_NLS_LANGUAGE === 'zh-cn';
  const serverUrl = 'https://studio.example.test';
  let account = { status:'authenticated', statusLabel:zh?'服务器已连接':'Server Connected', hasAccount:true, name:'My account', email:'me@example.test', avatarUrl:chatAvatar, scopeKey:'a'.repeat(64), serverUrl };
  const commandEvent = new Emitter();
  const kernelCommand = (id,...args) => CommandsRegistry.getCommand('studio.internal'+id).handler(undefined,...args);
  const publishAccount = () => commandEvent.fire({commandId:'studio.internalUpdateAccountMenuState', args:[account]});
  window.updateAccount = changes => { account = {...account,...changes}; publishAccount(); };
  window.signOut = () => {
    kernelCommand('CloseLaunchpadApp','account-key');
    account = {status:'signed-out',hasAccount:false,name:'',serverUrl,statusLabel:zh?'未登录':'Signed Out'};
    publishAccount();
  };
  window.prewarm = () => kernelCommand('PrepareLaunchpadApp','account-key',{title:'IM',port:4321,html:hostedSidebarHtml('en','IM',{url:'http://127.0.0.1:4321/app',nonce:'fixture',microphone:false},true)});
  const people = [{id:'alice',name:'Alice',relation:'friend',avatarUrl:chatAvatar},{id:'visitor',name:'Visitor'},
    {id:'dana',name:'Dana',relation:'incoming'},{id:'erin',name:'Erin',relation:'incoming'},{id:'sent',name:'Outgoing',relation:'outgoing'},{id:'removed',name:'Former friend',relation:'removed'}];
  const notices = [{id:'request:first',inviteId:'first',title:'Dana',source:'studio',read:true},
    {id:'request:second',inviteId:'second',title:'Erin',source:'studio',read:false},{id:'request:old',title:'Old request',source:'studio',read:true}];
  const commands = { onDidExecuteCommand:commandEvent.event, async executeCommand(id, ...args) {
    window.actions.push([id,...args]);
    if (id === 'studio.internalGetAccountMenuState') return account;
    if (id === 'studio.getStoreCatalog' || id === 'studio.getLocalCatalog') {
      const {page,query,type}=args[0], pageSize=2, rows=window.storeFixture.items.filter(p=>p.name.toLowerCase().includes(query.toLowerCase()) && (!type || type===p.projectType));
      return {items:rows.slice((page-1)*pageSize,page*pageSize).map(p=>window.enhanced?{id:p.id,name:p.name,description:p.summary,version:p.version,projectType:p.projectType,images:p.images}:p),total:rows.length,pageSize};
    }
    if (id === 'studio.getStoreListingDetails') {
      if (window.storePending) await window.storePending;
      if (window.storeFailure) throw new Error('Unavailable');
      return window.storeFixture.items.find(p=>p.id===args[0]);
    }
    if (id === 'studio.getSocialSnapshot') {
      const owned = account.scopeKey === 'a'.repeat(64);
      if (window.socialGate) await window.socialGate;
      if (window.socialFailure === 'unsupported') return {unavailable:'unsupported'};
      if (window.socialFailure) throw new Error('Service unavailable');
      return owned ? structuredClone({people:people.filter(p=>p.name.toLowerCase().includes(args[0].toLowerCase())),favorites:[{id:'saved',title:'Saved message',conversation:'group-team'}],notices}) : {people:[],favorites:[],notices:[]};
    }
    if (id === 'studio.changeSocial') {
      const {action,id:key}=args[0];
      if(action==='remove') people.find(p=>p.id===key).relation='removed';
      else if(action==='accept-invite'||action==='decline-invite'){
        const n=notices.find(n=>n.inviteId===key); if(!n) throw new Error('Invalid invitation');
        people.find(p=>p.name===n.title).relation=action==='accept-invite'?'friend':'removed'; delete n.inviteId; n.read=true;
      }
      return;
    }
    if (id === 'studio.openSettings') {
      window.settingsDestination = args[0];
      await kernelCommand('ShowLaunchpadSettings',zh?'设置':'Settings');
    }
    if (id === 'studio.getLaunchpadInbox') return window.guest ? {items:[],message:'Signed out',connection:'guest'} : chats;
    if (id === 'studio.openLaunchpadInbox') {
      if (window.imError) return window.imError;
      if (window.delayOpen) await new Promise(resolve => window.finishOpening = resolve);
      const ok=await kernelCommand('ShowLaunchpadApp','account-key',args[0],args[2]?'user:'+args[2]:args[1]);
      window.actions.push(['opened', args[0]]);
      return ok;
    }
    if (id === 'studio.createProject') {
      const dialog = new StudioProjectCreateDialog({ labels:{create:'Create',cancel:'Cancel',confirmCreate:'Create project'},
        templates:[{id:'starter',name:'Starter',projectType:'workflow',kind:'starter'}],parentDirectory:'/projects' }, commands,
        {softDispatch:()=>({kind:0})}, layout, {setWindowDimmed(){}});
      try { await dialog.show(); } finally { dialog.dispose(); }
    }
  } };
  const folders = Array.from({length:8}, (_,i)=>URI.file('/projects/Project '+(8-i)));
  folders[1] = URI.file('/projects/folder.code-workspace');
  const workspace = URI.file('/projects/Sample.code-workspace');
  const historyChange = new Emitter();
  const recent = { workspaces: [{ workspace:{id:'workspace',configPath:workspace} },...folders.map(folderUri=>({folderUri}))] };
  const avatar = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="4" fill="#2563eb"/></svg>');
  const history = folders.map((uri,i) => ({uri:uri.toString(),kind:'folder',label:uri.path.split('/').at(-1),lastOpened:1700000000000-i*86400000}));
  const detected = new Map([[history[0].uri,{projectType:'workflow',version:'1.2.0',projectId:'294b1eec-23fa-42cf-9fd3-2417f71c0570',distribution:'source',entries:[{entryId:'main',name:'Main workflow',type:'workflow',primary:true},{entryId:'chat',name:'Chat',type:'bot',primary:false}],artwork:{entries:[avatar,avatar]},avatarUrl:avatar}],[history[2].uri,{projectType:'bot',distribution:'download',artwork:{entries:[avatar]}}],[history[3].uri,{artwork:{files:['notes.txt','demo.js','README.md']}}]]);
  detected.set(history[1].uri,{projectType:'kanban',distribution:'source',artwork:{cover:{name:window.coverName,mtime:1}}});
  detected.set(history[4].uri,{projectType:'bot',distribution:'release',artwork:{entries:[avatar]}});
  const startEvent = new Emitter();
  const start = { state:undefined, onDidChange:startEvent.event, setVisible(){} };
  const storage = { getExtensionState:(id,global)=>global && JSON.parse(localStorage.getItem(id)) };
  window.activateProjects = () => {
    state.recent=applyRecentMetadata(history,detected);
    localStorage.setItem('studio.studio-workstation',JSON.stringify({[RECENT_PROJECTS_KEY]:state.recent}));
    start.state=state; startEvent.fire();
  };
  window.delayProjects = () => {start.state=undefined; startEvent.fire();};
  const windows = [{ id:23, dirty:false, workspace:{id:'folder',uri:folders[0]} },{id:24,dirty:true,workspace:{id:'bot',uri:folders[2]}},{id:25,dirty:false,workspace:{id:'third',uri:folders[3]}}];
  const edits = new Emitter();
  window.projectReads = { windows:0, history:0, stats:0 };
  window.openRequests = [];
  window.editProject = (id, dirty) => { windows.find(w=>w.id===id).dirty=dirty; edits.fire({windowId:id,dirty}); };
  const native = {onDidChangeWindowDirty:edits.event, getWindows:async()=>{window.projectReads.windows++; return windows.map(w=>({...w}));}, focusWindow:async o=>window.actions.push(['focus',o.targetWindowId]),
    showItemInFolder:async path=>window.actions.push(['reveal',path]),
    async showMessageBox({message,detail,buttons}) {
      const dialog = document.createElement('dialog'); dialog.className = 'native-message';
      dialog.append(message, detail ?? ''); document.body.append(dialog);
      const response = await new Promise(resolve => {
        buttons.forEach((label, i) => { const b=document.createElement('button'); b.textContent=label; b.onclick=()=>resolve(i); dialog.append(b); }); dialog.showModal();
      }); dialog.remove(); return {response};
    },
    openWindow:async (entries,opts)=>{
      const openables=entries.map(entry=>{const kind=Object.keys(entry)[0]; return {kind,path:entry[kind].path};});
      window.openRequests.push({openables,forceNewWindow:opts.forceNewWindow});
      window.actions.push(['open',openables[0].kind,opts.forceNewWindow]);
    }};
  const dialogs = { pickFolderAndOpen:async opts=>window.actions.push(['pickFolder',opts.forceNewWindow]), pickWorkspaceAndOpen:async opts=>window.actions.push(['pickWorkspace',opts.forceNewWindow]),
    showOpenDialog: async opts=>{ window.actions.push(['pickPaths',opts]); return window.selectedPaths?.map(path=>URI.file(path)); } };
  const opener = {open:async (uri,opts)=>window.actions.push(['external',uri.toString(),opts.openExternal])};
  const files = {readFile:async()=>({value:decodeBase64(window.coverBytes)}), stat: async uri=>{
    window.projectReads.stats++;
    if (uri.path===window.missingPath) throw new FileOperationError('Missing',FileOperationResult.FILE_NOT_FOUND);
    const isFile=uri.path===workspace.path||uri.path==='/projects/notes.txt'||uri.path.endsWith('/'+window.coverName);
    return {isFile,isDirectory:!isFile,size:window.coverBytes.length*3/4};
  } };
  const contextKeys = { createScoped:()=>contextKeys, createKey:()=>({set(){},reset(){},get(){}}), dispose(){} };
  const webviews = { createWebviewOverlay(init) { return new OverlayWebview(init,layout,this,contextKeys); }, createWebviewElement({title}) {
    const frame = document.createElement('iframe'); frame.title = title; frame.style.cssText = 'width:100%;height:100%;border:0;display:block';
    const messages = new Emitter(); const receive=e=>{if(e.source===frame.contentWindow && e.data.fixtureHost) messages.fire({message:e.data.fixtureHost});};
    let owner=window;
    return { onMessage:messages.event, onFatalError:Event.None, onDidFocus:Event.None, onDidBlur:Event.None, onDidClickLink:Event.None,
      onMissingCsp:Event.None, onDidWheel:Event.None, onDidScroll:Event.None, onDidUpdateState:Event.None,
      intrinsicContentSize:observableValue('fixture',undefined), setContextKeyService(){},
      mountTo:parent=>{owner=parent.ownerDocument.defaultView;owner.addEventListener('message',receive);parent.append(frame);}, setHtml:html=>{window.actions.push(['setHtml',title]);frame.srcdoc=html;},
      async postMessage(msg){frame.contentWindow.postMessage(msg,window.origin);return true;}, focus:()=>frame.focus(), dispose:()=>{owner.removeEventListener('message',receive);messages.dispose();frame.remove();} };
  } };
  const webviewViews = new WebviewViewService();
  const settingsResolver = webviewViews.register('studio.launchpadSettings', { async resolve({webview}) {
    if (window.settingsError) throw new Error('Settings fixture failure');
    const ready = webview.onMessage(({message}) => {
      if (message?.type !== 'ready') return;
      const { name:displayName, email, avatarUrl, status, hasAccount } = account;
      void webview.postMessage({type:'settings',state:window.settingsSnapshot});
      void webview.postMessage({type:'account',state:{status,serverUrl,user:hasAccount?{displayName,email,avatarUrl,userId:'fixture'}:undefined}});
      void webview.postMessage({type:'settings-navigate',state:window.settingsDestination});
    });
    webview.onDidDispose(() => ready.dispose());
    webview.setHtml(window.settingsHtml);
  } });
  const changed = () => window.events['vscode:studioProjectWindowsChanged']();
  window.startLaunchpad = () => {
    root.classList.add('studio-launchpad-window');
    const auxiliary = new BrowserAuxiliaryWindowService(layout, dialogs, {getValue:()=>undefined}, {publicLog2(){}}, {onDidChangeFullScreen:Event.None,focus(){}}, {}, {});
    const records = new Map(), notification = new Emitter(), valueChange = new Emitter();
    const notices = new StudioNotificationInbox({keys:()=>Array.from(records.keys()),getObject:key=>records.get(key),onDidChangeValue:()=>valueChange.event,store(key,value){records.set(key,value);valueChange.fire({key});},remove:key=>{records.delete(key);valueChange.fire({key});}}, {model:{onDidChangeNotification:notification.event}},commands);
    window.notify = text=>notification.fire({kind:NotificationChangeType.ADD,item:{message:{raw:text}}});
    window.localNotices=()=>notices.list(); window.readNotice=id=>notices.read(id);
    window.notify('Owner not yet known');
    const contextView = new ContextViewService(layout);
    const menus = new ContextMenuService({publicLog2(){}},{error:e=>{throw e;}},contextView,{lookupKeybinding:()=>undefined},{},contextKeys);
    const controller = new StudioLaunchpad(notices,start,native,{getRecentlyOpened:async()=>{
      window.projectReads.history++;
      if (window.delayHistory) {
        window.delayHistory=false;
        await new Promise(resolve=>window.resumeHistory=()=>{delete window.resumeHistory;resolve();});
      }
      return recent;
    },onDidChangeRecentlyOpened:historyChange.event,addRecentlyOpened:async entries=>{
      const paths=new Set(entries.map(row=>row.folderUri.path)); window.actions.push(['import',...paths]);
      recent.workspaces=[...entries,...recent.workspaces.filter(row=>!paths.has((row.folderUri??row.workspace.configPath).path))]; historyChange.fire();
    },removeRecentlyOpened:async ([uri])=>{
      window.actions.push(['forget',uri.path]); recent.workspaces=recent.workspaces.filter(row=>(row.folderUri??row.workspace.configPath).path!==uri.path); historyChange.fire();
    }},layout,commands,dialogs,{error:e=>{throw e;}},opener,webviews,files,storage,webviewViews,auxiliary,menus,{writeText:async text=>window.actions.push(['copy',text])});
    window.clearHistory=()=>{recent.workspaces=[];historyChange.fire();};
    window.refreshInbox=()=>CommandsRegistry.getCommand('studio.internalLaunchpadInboxChanged').handler(undefined,true);
    window.refreshSocial=()=>kernelCommand('StudioSocialChanged');
    window.closeProject=id=>{ if (id===undefined) windows.length=0; else windows.splice(windows.findIndex(w=>w.id===id),1); changed(); };
    window.duplicateProject=(id,newId)=>{ windows.push({...windows.find(w=>w.id===id),id:newId,dirty:true}); changed(); };
    window.showHome=()=>CommandsRegistry.getCommand('studio.internalShowLaunchpad').handler();
    window.openInbox=()=>CommandsRegistry.getCommand('studio.internalOpenLaunchpadInbox').handler();
    window.stopLaunchpad=()=>{controller.dispose();menus.dispose();contextView.dispose();auxiliary.dispose();notices.dispose();notification.dispose();valueChange.dispose();};
    window.cleanup=()=>{ window.stopLaunchpad(); settingsResolver.dispose(); webviewViews.dispose(); sashes.forEach(sash=>sash.dispose()); commandEvent.dispose(); startEvent.dispose(); edits.dispose(); historyChange.dispose(); layoutChange.dispose(); };
  };
` }, tsconfig: `${kernel}/src/tsconfig.json`, bundle: true, write: false, outdir: 'out', target: 'es2022',
  loader: { '.svg':'dataurl', '.ttf':'dataurl', '.png':'dataurl' } });
const js = bundle.outputFiles.find(file=>file.path.endsWith('.js')).text;
const css = bundle.outputFiles.find(file=>file.path.endsWith('.css')).text;
const settingsBundle = await build({ entryPoints:[fileURLToPath(new URL('../extensions/studio-workstation/webview/account.ts',import.meta.url))],
  bundle:true, write:false, outdir:'out', target:'es2022', loader:{'.svg':'dataurl'} });
const settingsJs = settingsBundle.outputFiles.find(file=>file.path.endsWith('.js')).text;
const settingsCss = settingsBundle.outputFiles.find(file=>file.path.endsWith('.css')).text;
const chinese = JSON.parse(await readFile(new URL('../extensions/studio-workstation/l10n/bundle.l10n.zh-cn.json',import.meta.url),'utf8'));
const proof = new URL('../.studio/launchpad-ui/', import.meta.url);
await mkdir(proof, {recursive:true});
const hostFocusCss = '.monaco-workbench [tabindex=\"-1\"]:focus, .monaco-workbench button:focus { outline: 2px solid #007acc; outline-offset: -1px; }';
const codicons = new URL('../node_modules/@vscode/codicons/dist/', import.meta.url);
const iconCss = (await readFile(new URL('codicon.css',codicons),'utf8')).replace(/url\([^)]+\)/,`url(data:font/ttf;base64,${(await readFile(new URL('codicon.ttf',codicons))).toString('base64')})`);
function workbenchConfig({ isStudioLaunchpad, language, light, reduceMotion, cached = true, highContrast = false }) {
  return {
    windowId: 1, isStudioLaunchpad, nls: { language, messages: [] }, studioLaunchpadReduceMotion: reduceMotion, appRoot: '/studio',
    autoDetectHighContrast: true, autoDetectColorScheme: true, colorScheme: { dark: !light, highContrast },
    partsSplash: cached ? {
      baseTheme: light ? 'vs' : 'vs-dark',
      colorInfo: { background: light ? '#fafafa' : '#191b1e', foreground: light ? '#202020' : '#eeeeee',
        editorBackground: '#191b1e', titleBarBackground: '#292929', activityBarBackground: '#292929', statusBarNoFolderBackground: '#292929' },
      layoutInfo: { modernUI: true, sideBarSide: 'left', titleBarHeight: 44, statusBarHeight: 22, activityBarWidth: 48, sideBarWidth: 0, auxiliaryBarWidth: 0 },
    } : undefined,
  };
}

function installBootstrapFixture(config) {
  window._VSCODE_USE_RELATIVE_IMPORTS = true;
  window.startupIpc = [];
  window.vscode = {
    ...window.vscode,
    process: { platform: 'darwin', env: { VSCODE_DEV: '1' } },
    context: { resolveConfiguration: async () => config },
    ipcRenderer: { ...window.vscode?.ipcRenderer, send(channel) { window.startupIpc.push(channel); } },
  };
}

async function routeBootstrap(page) {
  await page.route(`${workbenchPath}/workbench.js`, route => route.fulfill({ contentType: 'text/javascript', body: bootstrap.outputFiles[0].text }));
}

async function startWorkbench(page, options, loadWorkbench) {
  await routeBootstrap(page);
  await page.route(workbenchMain, async route => {
    await loadWorkbench;
    return route.fulfill({ contentType: 'text/javascript', body: `export async function main(config) {
      if (config.isStudioLaunchpad) { window.delayHistory = true; window.startLaunchpad(); }
    }` });
  });
  await page.evaluate(installBootstrapFixture, workbenchConfig(options));
  await page.addScriptTag({ type: 'module', url: `${workbenchPath}/workbench.js` });
}

async function checkStartupRecovery(browser, cause, language) {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  try {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.cspViolations = [];
      document.addEventListener('securitypolicyviolation', event => window.cspViolations.push(event.violatedDirective));
    });
    await page.addInitScript(installBootstrapFixture, workbenchConfig({
      isStudioLaunchpad: true, language, light: true, reduceMotion: false, highContrast: cause === 'slow',
    }));
    if (cause === 'slow') await page.clock.install();
    const html = await readFile(new URL('../upstream/vscode/src/vs/code/electron-browser/workbench/workbench.html', import.meta.url), 'utf8');
    await page.route(`${workbenchPath}/workbench.html`, route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.route(`${origin}/out/vs/workbench/workbench.desktop.main.css`, route => route.fulfill({ contentType: 'text/css', body: '' }));
    await routeBootstrap(page);
    await page.route(workbenchMain, route => cause === 'import' ? route.abort() : route.fulfill({ contentType: 'text/javascript', body: `
      export async function main() {
        ${cause === 'slow' ? 'await new Promise(() => {});' : `
          const workbench = document.createElement('div'); workbench.className = 'monaco-workbench studio-launchpad-window';
          document.body.append(workbench);
          throw new Error('workbench initialization failed');`}
      }` }));
    await page.goto(`${workbenchPath}/workbench.html`);
    await page.waitForFunction(() => window.startupIpc.includes('vscode:studioLaunchpadPainted'));
    const splash = page.locator('#studio-launchpad-splash');
    await splash.locator('img').evaluate(img => img.decode());
    if (cause === 'slow') {
      assert.equal(await splash.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)', 'stale cache is ignored for a high contrast switch');
      assert.equal(await splash.locator('.studio-splash-progress').evaluate(el => getComputedStyle(el, '::after').animationName),
        'studio-splash-progress', 'explicit Studio motion setting overrides the OS preference');
      await page.clock.fastForward(30000);
    }
    const retry = splash.getByRole('button', { name: language === 'zh-cn' ? '重试' : 'Retry' });
    await retry.waitFor();
    assert.equal(await splash.getByRole('alert').textContent(), cause === 'slow' ? 'Launchpad is taking longer than expected' :
      (language === 'zh-cn' ? '无法打开启动台' : 'Could not open Launchpad'));
    assert.equal(await splash.locator('.studio-splash-progress').isVisible(), false);
    assert.equal(await page.locator('.monaco-workbench:not([inert]), #monaco-parts-splash').count(), 0);
    assert.equal(await retry.evaluate(el => el === document.activeElement), true);
    await retry.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.startupIpc), ['vscode:studioLaunchpadPainted', 'vscode:reloadWindow']);
    assert.deepEqual(await page.evaluate(() => window.cspViolations), []);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
}

// Sample each editor sash away from the intersection, including its actual pointer target.
const sashPoints = [[400,160], [160,365]];
async function checkEditorSashes(page, visible) {
  const rendered = await page.locator('.sash-container > .monaco-sash').evaluateAll(sashes => sashes.map(s => s.getClientRects().length > 0));
  const hits = await page.evaluate(points => points.map(([x,y]) => !!document.elementFromPoint(x,y)?.closest('.monaco-sash')), sashPoints);
  assert.deepEqual({ rendered, hits }, { rendered:[visible,visible], hits:[visible,visible] }, 'both editor sashes must belong only to the project window');
  assert.ok(await page.locator('.titlebar-drag-region').evaluate(region => {
    const {left, top, width, height} = region.getBoundingClientRect();
    const y = top + height / 2;
    for (let x = left + 12; x < left + width - 24; x += 24) {
      if (document.elementFromPoint(x,y) === region && document.elementFromPoint(x+16,y) === region) return true;
    }
    return false;
  }), 'the native titlebar still has reachable drag space outside its action buttons');
}
async function checkProjectDrop(page, language) {
  const home=page.locator('.studio-launchpad'), title=home.locator('.lp-library-heading h1'), hint=page.locator('.lp-project-drop');
  const warning=page.locator('.native-message');
  const count=await page.evaluate(()=>window.openRequests.length);
  const fileTransfer=names=>page.evaluateHandle(names=>{
    const transfer=new DataTransfer();
    for (const name of names) transfer.items.add(new File([],name));
    return transfer;
  },names);
  const dataTransfer=await fileTransfer(['拖入 project']);
  await home.dispatchEvent('dragenter',{dataTransfer});
  await home.dispatchEvent('dragover',{dataTransfer});
  assert.ok(await hint.isVisible());
  assert.equal(await hint.textContent(),language==='zh-cn'?'松开以导入项目文件夹':'Drop folders to import projects');
  assert.ok((await hint.boundingBox()).y >= (await home.locator('.lp-titlebar').boundingBox()).height,'drop hint clears native controls');
  assert.equal(await hint.evaluate(el=>getComputedStyle(el).pointerEvents),'none');
  await title.dispatchEvent('dragenter',{dataTransfer});
  await home.dispatchEvent('dragleave',{dataTransfer});
  assert.ok(await hint.isVisible(),'crossing launchpad children does not clear the drop target');
  await title.dispatchEvent('dragleave',{dataTransfer});
  assert.equal(await hint.isVisible(),false,'leaving without dropping cancels the hint');
  assert.equal(await page.evaluate(()=>window.openRequests.length),count);

  await title.dispatchEvent('dragenter',{dataTransfer});
  await title.dispatchEvent('dragover',{dataTransfer});
  await title.dispatchEvent('drop',{dataTransfer});
  await home.locator('.lp-project-details').getByRole('heading',{name:'拖入 project'}).waitFor();
  assert.equal(await hint.isVisible(),false);
  assert.ok(await home.isVisible(),'importing a dropped folder leaves the launchpad resident');

  await home.locator('#lp-tab-community').click();
  const batch=await fileTransfer(['Batch A','notes.txt','Batch B','Batch A']); await home.dispatchEvent('drop',{dataTransfer:batch});
  await home.locator('.lp-all .lp-library-card').filter({hasText:'Batch B'}).waitFor();
  assert.equal(await home.locator('.lp-project-details').count(),0,'a batch returns to the library without picking a project');
  assert.deepEqual(await page.evaluate(()=>window.actions.filter(([id])=>id==='import').at(-1)),['import','/projects/Batch A','/projects/Batch B']);

  const link=await page.evaluateHandle(()=>{const transfer=new DataTransfer(); transfer.setData('text/uri-list','file:///projects/untrusted-link'); return transfer;});
  await home.dispatchEvent('dragover',{dataTransfer:link});
  assert.equal(await hint.isVisible(),false,'links cannot activate folder import');
  await home.dispatchEvent('drop',{dataTransfer:link});
  const file=await fileTransfer(['notes.txt']);
  await home.dispatchEvent('drop',{dataTransfer:file});
  await warning.waitFor();
  assert.ok((await warning.textContent()).includes(language==='zh-cn'?'没有可导入的项目文件夹':'No project folders could be imported'));
  await warning.getByRole('button').click();
  assert.equal(await page.evaluate(()=>window.openRequests.length),count,'dropping folders, links or regular files never opens an editor');
}

const browser = await chromium.launch({ headless:true, executablePath:process.env.STUDIO_START_TEST_BROWSER_PATH || undefined });
try {
  const project = await browser.newPage();
  await project.route('http://127.0.0.1:4321/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
  await project.goto('http://127.0.0.1:4321/');
  await startWorkbench(project, { isStudioLaunchpad: false, language: 'en', light: false }, Promise.resolve());
  await project.locator('#monaco-parts-splash').waitFor({ state: 'attached' });
  assert.ok(await project.locator('#monaco-parts-splash > div').count() > 1, 'project startup retains its editor layout preview');
  assert.equal(await project.locator('#studio-launchpad-splash').count(), 0, 'the branded splash is exclusive to launchpad windows');
  assert.deepEqual(await project.evaluate(() => window.startupIpc), []);
  await project.close();

  await checkStartupRecovery(browser, 'import', 'en');
  await checkStartupRecovery(browser, 'initialization', 'zh-cn');
  await checkStartupRecovery(browser, 'slow', 'en');
  console.log('launchpad import rejection, initialization rejection and stalled startup recovery passed');

  for (const [language, enhanced, light] of [['zh-cn',true,true],['en',true,false],['en',false,true]]) {
    const page = await browser.newPage({viewport:{width:1120,height:680}, reducedMotion:language==='zh-cn'?'reduce':'no-preference'});
    const stem = `${language}-${enhanced?'enhanced':'local'}-${light?'light':'dark'}`;
    const errors=[]; page.on('pageerror', e=>errors.push(e.message));
    await page.context().addInitScript(() => { window.acquireVsCodeApi = () => ({ postMessage:fixtureHost=>parent.postMessage({fixtureHost},window.origin) }); });
    let loads=0;
    await page.context().route('http://127.0.0.1:4321/**', route => {if(new URL(route.request().url()).pathname==='/app') loads++;return route.fulfill({contentType:'text/html',body:`<main>Inbox fixture</main><output></output><input aria-label="draft"><script>window.addEventListener('message',e=>{if(e.source===parent && e.data?.nonce==='fixture' && e.data.visible && e.data.conversation) document.querySelector('output').textContent=e.data.conversation;});parent.postMessage({type:'steamharness:web-app-ready',nonce:'fixture'},'*');</script>`});});
    await page.route('http://127.0.0.1:4321/settings-fixture.js',route=>route.fulfill({contentType:'text/javascript',body:settingsJs}));
    await page.route(`${origin}/store-preview/*.png`,route=>route.fulfill({path:fileURLToPath(new URL(`../../docs/images/studio/${language}/${new URL(route.request().url()).pathname.split('/').pop()}`,import.meta.url))}));
    await page.goto('http://127.0.0.1:4321/');
    await page.setContent(`<style>
      :root{--vscode-foreground:#d4d4d4;--vscode-editor-background:#1f1f1f;--vscode-sideBar-background:#252526;--vscode-panel-border:#3a3a3a;--vscode-textLink-foreground:#68b6ed;--vscode-button-background:#007acc;--vscode-button-foreground:white;--vscode-descriptionForeground:#aaa;--vscode-focusBorder:#007acc;--vscode-badge-background:#38383c;--vscode-badge-foreground:#eee;--vscode-list-hoverBackground:#303030;--vscode-input-background:#272727;--vscode-input-foreground:#ddd;--vscode-charts-yellow:#dcbd85;}
      main,body{margin:0}.monaco-workbench{position:fixed;inset:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);font:13px system-ui}.part.statusbar{height:22px}.part.titlebar{height:44px}.titlebar-container{display:flex;align-items:center;justify-content:space-between;height:100%}.titlebar-right{display:flex}.monaco-workbench .part.titlebar>.titlebar-container>.titlebar-right>.action-toolbar-container:not(.has-no-actions){display:flex}
      .monaco-grid-view {position:absolute;inset:0}
      .part.titlebar {position:relative}.titlebar-drag-region {position:absolute;inset:0;-webkit-app-region:drag}.window-controls-container {position:relative}
      </style><div class="monaco-workbench modern-ui ${light?'vs':'vs-dark'}"><div class="monaco-grid-view"><div class="monaco-split-view2 vertical"><div class="sash-container"></div><div class="monaco-split-view2 horizontal"><div class="sash-container"></div>
      <div class="part titlebar"><div class="titlebar-container"><div class="titlebar-drag-region"></div><div class="titlebar-left"><button>IDE</button><button class="window-controls-container" style="width:66px">×</button></div><div class="titlebar-right"><div class="action-toolbar-container"><button>Layout</button></div></div></div></div><div class="part editor"><button>Editor</button></div><div class="part statusbar"></div></div></div></div></div>`);
    if (light) await page.addStyleTag({content:':root{--vscode-foreground:#262626;--vscode-editor-background:#fff;--vscode-sideBar-background:#f6f6f6;--vscode-panel-border:#d9d9d9;--vscode-descriptionForeground:#565656;--vscode-input-background:#fafafa;--vscode-input-foreground:#333;--vscode-textLink-foreground:#005fb8;--vscode-list-hoverBackground:#ededed;--vscode-badge-background:#dedede;--vscode-badge-foreground:#333}'});
    await page.addStyleTag({content:'.vs{--vscode-list-warningForeground:#855f00}.vs-dark{--vscode-list-warningForeground:#cca700}.hc-black,.hc-light{--vscode-contrastBorder:currentColor}'});
    await page.evaluate(({language,enhanced,coverBytes,coverName,store})=>{
      window.storeFixture=store;
      window.coverBytes=coverBytes; window.coverName=coverName;
      window._VSCODE_NLS_LANGUAGE=language; window.enhanced=enhanced; window.actions=[]; window.events={};
      window.vscodeWindowId=1; // The UI fixture loads before the bootstrap replaces this with the real window ID.
      window.vscode={ipcRenderer:{on:(id,fn)=>window.events[id]=fn,removeListener:id=>delete window.events[id]},
        webUtils:{getPathForFile:file=>'/projects/'+file.name}};
    },{language,enhanced,coverBytes:coverBytes.toString('base64'),coverName,store:storeFixture(language==='zh-cn')});
    if (enhanced) {
      const localization = JSON.stringify({locale:language,bundle:language==='zh-cn'?chinese:{}}).replace(/</g,'\\u003c');
      const html = `<!doctype html><html lang="${language}"><head><style>${settingsThemeCss(light?'light':'dark')}\n${settingsCss}\n${iconCss}</style></head>
        <body data-platform="true" data-launchpad="true"><main id="account-app"></main><script id="studio-localization" type="application/json">${localization}</script><script src="/settings-fixture.js"></script></body></html>`;
      const snapshot = {...settingsFixture(language),workspaceAvailable:false};
      await page.evaluate(({html,snapshot})=>{window.settingsHtml=html;window.settingsSnapshot=snapshot;},{html,snapshot});
    }
    await page.addStyleTag({content:hostFocusCss}); await page.addStyleTag({content:css+'\n'+iconCss}); await page.addScriptTag({content:js});
    await checkEditorSashes(page, true);
    for (const [x,y] of sashPoints) { await page.mouse.move(x,y); await page.mouse.down(); await page.mouse.move(x+10,y+10); await page.mouse.up(); }
    assert.equal(await page.evaluate(()=>new Set(window.sashDrags).size),2,'both resize directions still work in a project window');
    await page.mouse.move(0,0);
    const workbench = Promise.withResolvers();
    try {
      await startWorkbench(page, { isStudioLaunchpad: true, language, light, reduceMotion: enhanced ? undefined : true, cached: enhanced }, workbench.promise);
      const splash = page.locator('#studio-launchpad-splash');
      await splash.waitFor();
      await splash.locator('img').evaluate(img => img.decode());
      assert.equal(await splash.getByRole('status').textContent(), language==='zh-cn'?'正在打开启动台…':'Opening Launchpad…');
      assert.deepEqual(await splash.boundingBox(), { x:0, y:0, width:1120, height:680 });
      assert.equal(await splash.evaluate(el => getComputedStyle(el).backgroundColor), light ? (enhanced ? 'rgb(250, 250, 250)' : 'rgb(255, 255, 255)') : 'rgb(25, 27, 30)');
      assert.equal(await splash.locator('.studio-splash-progress').evaluate(el => getComputedStyle(el, '::after').animationName),
        language==='en' && enhanced ? 'studio-splash-progress' : 'none');
      assert.equal(await page.locator('#monaco-parts-splash, .studio-launchpad').count(), 0, 'the splash paints before the workbench without IDE placeholders');
      await page.waitForFunction(() => window.startupIpc.includes('vscode:studioLaunchpadPainted'));
      await page.screenshot({path:fileURLToPath(new URL(`${stem}-startup.png`,proof))});
    } finally {
      workbench.resolve();
    }
    await page.locator('.studio-launchpad').waitFor({timeout:5000}).catch(error=>{throw new Error(errors.join('\n') || error.message);});
    assert.equal(await page.locator('#studio-launchpad-splash').count(), 0, 'the splash leaves as soon as the launchpad renders');
    assert.equal(await page.evaluate(() => typeof window.resumeHistory), 'function', 'history has not returned at handoff');
    await page.evaluate(() => { window.showHome(); window.resumeHistory(); });
    assert.equal(await page.locator('#studio-launchpad-splash').count(), 0, 'revealing the resident launchpad does not replay startup');
    await checkLibraryExperience({ page, language, enhanced, checkEditorSashes, checkProjectDrop,
      screenshot: name => page.screenshot({path:fileURLToPath(new URL(stem+'-'+name+'.png',proof))}), loads:()=>loads });
    await page.evaluate(()=>window.cleanup()); assert.deepEqual(errors,[]); await page.close(); console.log(`${language}: launchpad resources, layout, keyboard actions, window changes, library import, drag and drop, creation${enhanced?', account and settings':''} passed`);
  }
} finally { await browser.close(); }
