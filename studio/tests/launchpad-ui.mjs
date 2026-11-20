import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { settingsFixture, settingsThemeCss } from './settings-ui-fixture.mjs';

// Render the desktop controller, creation dialog and Settings UI with isolated host services.
const kernel = fileURLToPath(new URL('../upstream/vscode/', import.meta.url));
const bundle = await build({ stdin: { resolveDir: kernel, contents: `
  import { StudioLaunchpad } from './src/vs/workbench/electron-browser/studioLaunchpad.ts';
  import { StudioProjectCreateDialog } from './src/vs/workbench/contrib/studioStart/browser/studioProjectCreateDialog.ts';
  import { URI } from './src/vs/base/common/uri.ts';
  import { Emitter, Event } from './src/vs/base/common/event.ts';
  import { observableValue } from './src/vs/base/common/observable.ts';
  import { OverlayWebview } from './src/vs/workbench/contrib/webview/browser/overlayWebview.ts';
  import { WebviewViewService } from './src/vs/workbench/contrib/webviewView/browser/webviewViewService.ts';
  import { Sash, Orientation } from './src/vs/base/browser/ui/sash/sash.ts';
  import './src/vs/base/browser/ui/splitview/splitview.css';
  import './src/vs/workbench/contrib/modernUI/browser/media/sashHandles.css';
  import { CommandsRegistry } from './src/vs/platform/commands/common/commands.ts';
  import { FileOperationError, FileOperationResult } from './src/vs/platform/files/common/files.ts';
  import { hostedSidebarHtml } from '../../extensions/studio-workstation/src/project-sidebar-html.ts';
  import { applyRecentMetadata, RECENT_PROJECTS_KEY } from '../../extensions/studio-workstation/src/projects.ts';
  const state = { canCreate: true, platform: window.enhanced, recent: [], recommendations: window.enhanced ? { items: [{ id:'checklist', name:'Checklist', description:'Verify a release' }] } : undefined };
  const root = document.querySelector('.monaco-workbench');
  const [outer, inner] = root.querySelectorAll('.sash-container');
  const sashes = [new Sash(outer, {getHorizontalSashTop:()=>365}, {orientation:Orientation.HORIZONTAL}),
    new Sash(inner, {getVerticalSashLeft:()=>400}, {orientation:Orientation.VERTICAL})];
  window.sashDrags = [];
  sashes.forEach(sash=>sash.onDidStart(()=>window.sashDrags.push(sash.orientation)));
  const layout = { mainContainer:root, activeContainer:root, getContainer:(_window,part)=>part ? root.querySelector('.titlebar') : root, mainContainerOffset:{top:36}, onDidLayoutMainContainer: Event.None };
  const chatAvatar = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#3063af"/></svg>');
  const chats = { connection:'connected', items:[{id:'group-team',group:true,time:Date.now(),name:'Team',preview:'Review',unread:2,avatarUrl:chatAvatar},{id:'solo',name:'Solo',preview:'Hi',unread:0,avatarUrl:'data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path fill="#345" d="M0 0h32v32H0z"/></svg>')}] };
  const zh = window._VSCODE_NLS_LANGUAGE === 'zh-cn';
  const serverUrl = 'https://studio.example.test';
  let account = { status:'authenticated', statusLabel:zh?'服务器已连接':'Server Connected', hasAccount:true, name:'My account', email:'me@example.test', avatarUrl:chatAvatar, serverUrl };
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
  const commands = { onDidExecuteCommand:commandEvent.event, async executeCommand(id, ...args) {
    window.actions.push([id,...args]);
    if (id === 'studio.internalGetAccountMenuState') return account;
    if (id === 'studio.openSettings') {
      window.settingsDestination = args[0];
      await kernelCommand('ShowLaunchpadSettings',zh?'设置':'Settings');
    }
    if (id === 'studio.getLaunchpadInbox') return window.guest ? {items:[],message:'Signed out',connection:'guest'} : chats;
    if (id === 'studio.openLaunchpadInbox') {
      if (window.imError) return window.imError;
      if (window.delayOpen) await new Promise(resolve => window.finishOpening = resolve);
      await kernelCommand('ShowLaunchpadApp','account-key',...args);
      window.actions.push(['opened', args[0]]);
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
  const recent = { workspaces: [{ workspace:{id:'workspace',configPath:workspace} },...folders.map(folderUri=>({folderUri}))] };
  const avatar = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="4" fill="#2563eb"/></svg>');
  const history = folders.map((uri,i) => ({uri:uri.toString(),kind:'folder',label:uri.path.split('/').at(-1),lastOpened:1700000000000-i*86400000}));
  const detected = new Map([[history[0].uri,{projectType:'workflow',avatarUrl:avatar}],[history[2].uri,{projectType:'bot'}]]);
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
    showOpenDialog: async opts=>{ window.actions.push(['relocate',opts.canSelectFolders]); return window.newLocation && [URI.file(window.newLocation)]; } };
  const files = { stat: async uri=>{
    window.projectReads.stats++;
    if (uri.path===window.missingPath) throw new FileOperationError('Missing',FileOperationResult.FILE_NOT_FOUND);
    const isFile=uri.path===workspace.path||uri.path==='/projects/notes.txt';
    return {isFile,isDirectory:!isFile};
  } };
  const contextKeys = { createScoped:()=>contextKeys, createKey:()=>({set(){},reset(){},get(){}}), dispose(){} };
  const webviews = { createWebviewOverlay(init) { return new OverlayWebview(init,layout,this,contextKeys); }, createWebviewElement({title}) {
    const frame = document.createElement('iframe'); frame.title = title; frame.style.cssText = 'width:100%;height:100%;border:0;display:block';
    const messages = new Emitter(); const receive=e=>{if(e.source===frame.contentWindow && e.data.fixtureHost) messages.fire({message:e.data.fixtureHost});};
    window.addEventListener('message',receive);
    return { onMessage:messages.event, onFatalError:Event.None, onDidFocus:Event.None, onDidBlur:Event.None, onDidClickLink:Event.None,
      onMissingCsp:Event.None, onDidWheel:Event.None, onDidScroll:Event.None, onDidUpdateState:Event.None,
      intrinsicContentSize:observableValue('fixture',undefined), setContextKeyService(){},
      mountTo:parent=>parent.append(frame), setHtml:html=>{window.actions.push(['setHtml',title]);frame.srcdoc=html;},
      async postMessage(msg){frame.contentWindow.postMessage(msg,window.origin);return true;}, focus:()=>frame.focus(), dispose:()=>{window.removeEventListener('message',receive);messages.dispose();frame.remove();} };
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
    const controller = new StudioLaunchpad(start,native,{getRecentlyOpened:async()=>{
      window.projectReads.history++;
      if (window.delayHistory) { window.delayHistory=false; await new Promise(resolve=>window.resumeHistory=resolve); }
      return recent;
    },onDidChangeRecentlyOpened:Event.None,removeRecentlyOpened:async ([uri])=>{
      window.actions.push(['forget',uri.path]); recent.workspaces=recent.workspaces.filter(row=>(row.folderUri??row.workspace.configPath).path!==uri.path); changed();
    }},layout,commands,dialogs,{error:e=>{throw e;}},{},webviews,files,storage,webviewViews);
    window.clearHistory=()=>{recent.workspaces=[];changed();};
    window.refreshInbox=()=>CommandsRegistry.getCommand('studio.internalLaunchpadInboxChanged').handler(undefined,true);
    window.closeProject=id=>{ if (id===undefined) windows.length=0; else windows.splice(windows.findIndex(w=>w.id===id),1); changed(); };
    window.duplicateProject=(id,newId)=>{ windows.push({...windows.find(w=>w.id===id),id:newId,dirty:true}); changed(); };
    window.showHome=()=>CommandsRegistry.getCommand('studio.internalShowLaunchpad').handler();
    window.openInbox=()=>CommandsRegistry.getCommand('studio.internalOpenLaunchpadInbox').handler();
    window.stopLaunchpad=()=>controller.dispose();
    window.cleanup=()=>{ controller.dispose(); settingsResolver.dispose(); webviewViews.dispose(); sashes.forEach(sash=>sash.dispose()); commandEvent.dispose(); startEvent.dispose(); edits.dispose(); };
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
async function checkStatusLayout(page) {
  const overflow = await page.locator('.lp-project-row').evaluateAll(rows => rows.filter(row => {
    const [name,status,time,actions] = row.children;
    const box = status.getBoundingClientRect(), next = (time.offsetWidth ? time : actions).getBoundingClientRect();
    return name.getBoundingClientRect().right > box.left || box.right > next.left || [...status.children].some(el => {
      const r = el.getBoundingClientRect(); return r.left < box.left || r.right > box.right || r.top < row.getBoundingClientRect().top || r.bottom > row.getBoundingClientRect().bottom;
    });
  }).map(row => row.dataset.key));
  assert.deepEqual(overflow, [], `status text and icons fit between columns at ${page.viewportSize().width}px`);
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
  const home=page.locator('.lp-home'), title=home.getByRole('heading',{level:1}), hint=page.locator('.lp-project-drop');
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
  assert.equal(await hint.textContent(),language==='zh-cn'?'打开项目文件夹':'Open project folder');
  assert.deepEqual(await hint.boundingBox(),await home.boundingBox(),'the target covers the content without overlapping window controls');
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
  await page.waitForFunction(count=>window.openRequests.length===count+1,count);
  assert.deepEqual(await page.evaluate(()=>window.openRequests.at(-1)),{openables:[{kind:'folderUri',path:'/projects/拖入 project'}],forceNewWindow:true});
  assert.equal(await hint.isVisible(),false);
  assert.ok(await home.isVisible(),'opening a dropped folder leaves the launchpad resident');

  const link=await page.evaluateHandle(()=>{const transfer=new DataTransfer(); transfer.setData('text/uri-list','file:///projects/untrusted-link'); return transfer;});
  await home.dispatchEvent('dragover',{dataTransfer:link});
  assert.equal(await hint.isVisible(),false,'links cannot activate folder import');
  await home.dispatchEvent('drop',{dataTransfer:link});
  const file=await fileTransfer(['notes.txt']);
  await home.dispatchEvent('drop',{dataTransfer:file});
  await warning.waitFor();
  assert.ok((await warning.textContent()).includes(language==='zh-cn'?'没有可打开的项目文件夹':'No project folders could be opened'));
  await warning.getByRole('button').click();
  assert.equal(await page.evaluate(()=>window.openRequests.length),count+1,'dropping a link or regular file never opens an editor');
}

const browser = await chromium.launch({ headless:true, executablePath:process.env.STUDIO_START_TEST_BROWSER_PATH || undefined });
try {
  for (const [language, enhanced, light] of [['zh-cn',true,true],['en',true,false],['en',false,true]]) {
    const page = await browser.newPage({viewport:{width:1120,height:680}});
    const errors=[]; page.on('pageerror', e=>errors.push(e.message));
    await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ postMessage:fixtureHost=>parent.postMessage({fixtureHost},window.origin) }); });
    let loads=0;
    await page.route('http://127.0.0.1:4321/**', route => {if(new URL(route.request().url()).pathname==='/app') loads++;return route.fulfill({contentType:'text/html',body:`<main>Inbox fixture</main><output></output><input aria-label="draft"><script>window.addEventListener('message',e=>{if(e.source===parent && e.data?.nonce==='fixture' && e.data.visible && e.data.conversation) document.querySelector('output').textContent=e.data.conversation;});parent.postMessage({type:'steamharness:web-app-ready',nonce:'fixture'},'*');</script>`});});
    await page.route('http://127.0.0.1:4321/settings-fixture.js',route=>route.fulfill({contentType:'text/javascript',body:settingsJs}));
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
    await page.evaluate(({language,enhanced})=>{
      window._VSCODE_NLS_LANGUAGE=language; window.enhanced=enhanced; window.actions=[]; window.events={};
      window.vscode={ipcRenderer:{on:(id,fn)=>window.events[id]=fn,removeListener:id=>delete window.events[id]},
        webUtils:{getPathForFile:file=>'/projects/'+file.name}};
    },{language,enhanced});
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
    await page.evaluate(()=>window.startLaunchpad());
    const rows=page.locator('.lp-project-row'); await rows.first().waitFor({timeout:5000}).catch(error=>{throw new Error(errors.join('\n') || error.message);});
    const selected=page.locator('.lp-project-row[aria-selected=true]');
    assert.equal(await selected.count(),0,'no project is selected when history first renders');
    assert.equal(await rows.locator('.lp-project-type').count(),0,'first run has not inspected these folders yet');
    await page.evaluate(()=>window.activateProjects());
    await rows.locator('.lp-project-avatar').first().waitFor();
    await page.evaluate(()=>{window.stopLaunchpad();window.delayProjects();window.startLaunchpad();});
    await rows.locator('.lp-project-avatar').first().waitFor();
    assert.equal(await rows.locator('.lp-project-type').count(),2,'second launch paints types and avatar before extension activation');
    await page.evaluate(()=>window.activateProjects());
    await checkEditorSashes(page, false);
    const historyOrder=['Sample.code-workspace','Project 8','folder.code-workspace','Project 6','Project 5','Project 4','Project 3','Project 2','Project 1'];
    const historyNames=rows.locator('.lp-project-heading strong');
    assert.deepEqual(await historyNames.allTextContents(),historyOrder.slice(0,5),'collapsed history follows native recency, including entries without a timestamp');
    assert.equal(await page.locator('.part.editor').evaluate(el=>el.inert),true);
    assert.equal(await rows.locator('.lp-project-avatar').count(),1,`${language}: recent project avatar`);
    assert.ok((await rows.locator('.lp-project-avatar').getAttribute('src'))?.startsWith('data:image/svg+xml,'),`${language}: avatar data URL is preserved`);
    assert.deepEqual(await page.locator('.lp-project-type').allTextContents(),[language==='zh-cn'?'工作流':'Workflow', 'Bot'],`${language}: recent project types`);
    assert.deepEqual(await page.locator('.lp-plate-kind').allTextContents(), [language==='zh-cn'?'工作流':'Workflow', 'Bot', language==='zh-cn'?'文件夹':'Folder']);
    assert.equal(await page.locator('.lp-plate-kind .codicon-hubot').count(),1,'the Bot label uses its project glyph');
    const zh = language === 'zh-cn';
    const labels = zh ? ['未打开','已打开','未打开','已打开','已打开'] : ['Not open','Open','Not open','Open','Open'];
    assert.deepEqual(await rows.locator('.lp-state-label').allTextContents(), labels);
    assert.equal(await rows.getByRole('gridcell').locator('.lp-state-detail').textContent(), zh ? '未保存' : 'Unsaved');
    assert.equal(await page.evaluate(()=>window.projectReads.stats),0,'initial statuses need no per-project filesystem check');
    assert.equal(await page.locator('.studio-launchpad').evaluate(el=>getComputedStyle(el).outlineStyle),'none',`${language}: launchpad container must not draw a focus outline`);
    if (enhanced) {
      await page.getByText('Review',{exact:true}).waitFor();
      const avatars = page.locator('img.lp-chat-avatar');
      assert.deepEqual(await avatars.evaluateAll(images=>Promise.all(images.map(async img=>{await img.decode();return img.naturalWidth>0;}))), [true,true],`${language}: user and group avatars actually decode`);
      assert.equal(await page.locator('.lp-account').getAttribute('title'),'My account');
    }
    assert.equal(await page.locator('.lp-store').isVisible(),enhanced);
    const stem = `${language}-${enhanced?'enhanced':'local'}-${light?'light':'dark'}`;
    assert.equal(await rows.first().evaluate(el=>getComputedStyle(el).boxShadow),'none','the first row has no selection highlight');
    await page.screenshot({path:fileURLToPath(new URL(`${stem}.png`,proof))});
    assert.equal(await page.locator('.lp-primary').evaluate(el=>getComputedStyle(el).backgroundColor), 'rgb(0, 122, 204)', 'primary action inherits the Studio theme');
    assert.equal(await page.locator('.action-toolbar-container').isVisible(),false,'layout controls must not overlap Web console');
    const bounds=async selector=>page.locator(selector).first().boundingBox();
    if(enhanced){assert.ok((await bounds('.lp-inbox')).x>(await bounds('.lp-projects')).x);assert.equal((await bounds('.lp-inbox')).x,(await bounds('.lp-store')).x);}
    const status=await bounds('.lp-statusbar');assert.equal(status.y+status.height,680);
    const section=page.locator('.lp-history'), searchLabel=zh?'搜索项目':'Search projects';
    assert.deepEqual(await section.locator('header button').allTextContents(),[searchLabel],'search is the only history header action');
    const find=section.getByRole('button',{name:searchLabel,exact:true}), search=page.getByRole('combobox');
    await find.focus(); await page.keyboard.press('Tab');
    assert.equal(await rows.first().evaluate(el=>el===document.activeElement),true,'history remains reachable by keyboard');
    assert.equal(await selected.count(),0,'tab focus does not select a project');
    const foot=page.locator('.lp-foot button'); await foot.click(); assert.equal(await foot.evaluate(el=>getComputedStyle(el).outlineStyle),'none',`${language}: pointer focus must not draw a blue outline`);
    assert.deepEqual(await historyNames.allTextContents(),historyOrder,'expanded history keeps the same most-recent-first order');
    assert.equal(await selected.count(),0,'expanding history does not select a project');
    await find.click(); await search.fill('no-match'); assert.ok(await page.locator('.lp-quick-empty').isVisible());
    await search.press('Escape'); assert.ok(await find.evaluate(el=>el===document.activeElement));
    await page.keyboard.press('Control+p'); await search.fill('projects folder.code'); assert.equal(await page.getByRole('option').count(),1); await search.press('Enter');
    await page.locator('.lp-command-center').click(); await search.fill('sample.code'); await page.getByRole('option').click();
    await page.keyboard.press('F1'); await page.getByRole('option',{name:language==='zh-cn'?'打开文件夹…':'Open folder…',exact:true}).click();
    await page.locator('.lp-live-project').first().click(); await page.locator('.lp-actions .lp-outline').click(); await page.locator('.lp-choice').nth(1).click();
    await page.locator('.lp-statusbar button').click(); await page.locator('.lp-quick-foot button').click(); assert.equal(await search.inputValue(),'');
    await search.press('ArrowDown'); assert.equal(await search.getAttribute('aria-activedescendant'),'lp-option-1'); await page.keyboard.press('Escape');
    await rows.nth(1).click(); assert.equal(await rows.nth(1).getAttribute('aria-selected'),'true');
    await rows.nth(1).press('ArrowDown'); assert.equal(await rows.nth(2).getAttribute('aria-selected'),'true');
    assert.notEqual(await rows.nth(2).evaluate(el=>getComputedStyle(el).outlineStyle),'none','keyboard navigation keeps focus visible');
    // An older window snapshot (waiting on history) must not undo a live edit. Edits and saves do not reread projects.
    const workflow=rows.filter({hasText:'Project 8'}), third=rows.filter({hasText:'Project 5'});
    await page.evaluate(()=>{window.delayHistory=true; window.closeProject(25);}); await page.waitForFunction(()=>!!window.resumeHistory);
    const reads=await page.evaluate(()=>window.projectReads);
    await page.evaluate(()=>window.editProject(23,true)); await workflow.locator('.lp-state-detail').waitFor();
    await page.evaluate(()=>window.resumeHistory()); await third.locator('[data-state=closed]').waitFor();
    assert.ok(await workflow.locator('.lp-state-detail').isVisible());
    await page.evaluate(()=>window.editProject(23,false)); await workflow.locator('.lp-state-detail').waitFor({state:'detached'});
    assert.deepEqual(await page.evaluate(()=>window.projectReads),reads);
    await page.evaluate(()=>window.duplicateProject(23,26)); await workflow.locator('.lp-state-detail').waitFor();
    await workflow.press('Enter'); assert.deepEqual(await page.evaluate(()=>window.actions.at(-1)),['focus',26],'switch to the window with unsaved work');
    await page.evaluate(()=>window.closeProject(26)); await workflow.locator('.lp-state-detail').waitFor({state:'detached'});
    const missing=rows.filter({hasText:'folder.code-workspace'}), lastOpened=await missing.locator('time').textContent();
    assert.notEqual(lastOpened,'—');
    await page.evaluate(()=>window.missingPath='/projects/folder.code-workspace'); await missing.dblclick();
    const msg=page.locator('.native-message'); await msg.getByRole('button').last().click();
    const missingCell=missing.getByRole('gridcell').nth(1);
    assert.equal(await missingCell.textContent(),zh?'路径失效':'Not found');
    assert.equal(await missing.locator('time').textContent(),lastOpened,'cancelled relocation keeps both the history and its timestamp');
    await foot.click();
    assert.deepEqual(await historyNames.allTextContents(),historyOrder.slice(0,5),'returning to recent keeps the same most-recent-first order');
    for (const width of [1120,768,480,360]) {
      await page.setViewportSize({width,height:680}); await checkStatusLayout(page);
      assert.deepEqual(await section.locator('.lp-state-label > .codicon').evaluateAll(icons=>icons.map(el=>el.className.split(' ').at(-1))), ['codicon-history','codicon-window','codicon-warning','codicon-window','codicon-history']);
      if (width===1120 || width===360) await section.screenshot({path:fileURLToPath(new URL(`${stem}-history-${width}.png`,proof))});
    }
    await page.setViewportSize({width:1120,height:680});
    const hc=light?'hc-light':'hc-black', host=page.locator('.monaco-workbench');
    await host.evaluate((el,hc)=>el.classList.add(hc),hc);
    assert.ok(await section.locator('.lp-state-label').evaluateAll(labels=>labels.every(el=>getComputedStyle(el).borderTopColor===getComputedStyle(el).color)),'honor the high-contrast theme border');
    await host.evaluate((el,hc)=>el.classList.remove(hc),hc);
    await missing.locator('.lp-row-more').click();
    assert.equal(await page.locator('.lp-choice').first().textContent(),zh?'打开或重新定位…':'Open or locate project…');
    await page.locator('.lp-choice').last().click(); await msg.getByRole('button').last().click(); assert.ok(await missing.isVisible());
    await page.evaluate(()=>window.newLocation='/projects/relocated'); await missing.press('Enter'); await msg.getByRole('button').first().click(); await missing.waitFor({state:'detached'});
    assert.equal(await selected.count(),0,'when the selected row disappears, no other project is selected automatically');
    await page.locator('.lp-primary').click(); const modal=page.locator('.studio-create-dialog'); await modal.waitFor({timeout:5000});
    assert.equal(await modal.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}),true);
    await page.keyboard.press('Escape'); await modal.waitFor({state:'detached'});
    assert.equal(await page.getByRole('button', {name:'IDE'}).count(), 0);
    assert.equal(await page.locator('.window-controls-container').isVisible(), true);
    assert.equal(await page.locator('.studio-launchpad-back').count(), 0);
    if (enhanced) {
      const home = page.locator('.studio-launchpad'), open = page.locator('.lp-inbox header .lp-link'), editor = page.locator('.part.editor');
      assert.equal(await page.evaluate(()=>window.prewarm()),true);
      assert.equal(await home.isVisible(),true); assert.equal(await page.locator('.studio-launchpad-app').isVisible(),false);
      await page.evaluate(() => window.imError = 'Service offline');
      await open.click(); const warning = page.locator('.native-message'); await warning.waitFor();
      assert.ok((await warning.textContent()).includes(language === 'zh-cn' ? '无法打开 IM' : 'Could not open IM'));
      assert.ok((await warning.textContent()).includes('Service offline'));
      assert.equal(await home.isVisible(), true); assert.equal(await editor.isVisible(), false);
      assert.equal(await page.locator('.studio-launchpad-app').isVisible(), false);
      await warning.getByRole('button').click(); await warning.waitFor({state:'detached'});
      // Cancelling a pending open (e.g. from the tray) must not let a late preview replace home.
      await page.evaluate(() => { window.imError = ''; window.delayOpen = true; });
      await open.click(); await page.waitForFunction(() => !!window.finishOpening);
      await page.evaluate(() => { window.showHome(); window.finishOpening(); window.delayOpen = false; });
      await page.waitForFunction(() => window.actions.some(([id])=>id==='opened'));
      assert.equal(await home.isVisible(), true); assert.equal(await warning.count(), 0);
      await page.locator('.lp-chat').first().click();
      const frame = page.frameLocator('.studio-launchpad-app iframe').frameLocator('#project-frame');
      await frame.getByText('Inbox fixture').waitFor();
      await frame.getByText('group-team',{exact:true}).waitFor();
      await frame.getByLabel('draft').fill('keep draft');
      assert.equal(await home.isVisible(), false); assert.equal(await editor.isVisible(), false);
      assert.equal(await editor.evaluate(el=>el.inert), true);
      await page.evaluate(() => window.openInbox());
      assert.equal(await page.locator('.studio-launchpad-app').count(), 1);
      for (const [width, height] of [[1120,680],[640,820]]) {
        await page.setViewportSize({width,height});
        await checkEditorSashes(page, false);
        const title = await page.locator('.part.titlebar').boundingBox();
        assert.deepEqual(await page.frameLocator('.studio-launchpad-app iframe').locator('#project-frame').boundingBox(),
          { x:0, y:title.height, width, height:height-title.height });
      }
      await page.getByRole('button',{name: language==='zh-cn'?'关闭 IM':'Close IM'}).click();
      await checkEditorSashes(page, false);
      assert.equal(await home.isVisible(), true); assert.equal(await editor.isVisible(), false);
      assert.equal(await open.evaluate(el=>el===document.activeElement), true);
      const accountButton = page.getByRole('button',{name:zh?'Studio 账号':'Studio account',exact:true});
      const accountDialog = page.getByRole('dialog',{name:zh?'Studio 账号':'Studio account'});
      const profile = accountDialog.locator('.lp-account-profile');
      const settings = accountDialog.getByRole('button',{name:zh?'打开 Studio 设置':'Open Studio Settings'});
      const closeSettings = page.getByRole('button',{name:zh?'关闭 设置':'Close Settings'});
      await accountButton.click();
      assert.equal(await profile.getByText('My account',{exact:true}).count(),1);
      assert.equal(await profile.getByText('me@example.test',{exact:true}).count(),1);
      assert.equal(await profile.getByText('https://studio.example.test',{exact:true}).count(),1);
      assert.equal(await profile.getByText(zh?'服务器已连接':'Server Connected',{exact:true}).count(),1);
      await profile.locator('img').evaluate(img=>img.decode());
      const avatarUrl = await profile.locator('img').getAttribute('src');
      assert.equal(await settings.evaluate(el=>getComputedStyle(el).outlineStyle),'none','pointer-open does not highlight the first action');
      await accountDialog.screenshot({path:fileURLToPath(new URL(`${stem}-account.png`,proof))});
      await page.setViewportSize({width:360,height:640});
      await page.evaluate(()=>window.updateAccount({email:'a'.repeat(80)+'@example.test',avatarUrl:'data:image/png;base64,invalid'}));
      await profile.locator('.codicon-account').waitFor();
      assert.equal(await profile.locator('.lp-account-email').textContent(),'a'.repeat(80)+'@example.test');
      assert.equal(await profile.evaluate(el=>el.scrollWidth<=el.clientWidth),true,'long account information wraps inside the dialog');
      await page.evaluate(avatarUrl=>window.updateAccount({email:'me@example.test',avatarUrl}),avatarUrl);
      await page.keyboard.press('Escape');
      assert.equal(await accountButton.evaluate(el=>el===document.activeElement),true);
      await accountButton.press('Enter');
      assert.notEqual(await settings.evaluate(el=>getComputedStyle(el).outlineStyle),'none','keyboard-open retains focus feedback');
      await page.setViewportSize({width:1120,height:680});
      await settings.click();
      assert.deepEqual(await page.evaluate(()=>window.settingsDestination),{section:'account',target:'user'});
      const settingsFrame = page.frameLocator('.webview-overlay-content iframe');
      await settingsFrame.locator('#profile #display-name').waitFor();
      assert.equal(await settingsFrame.locator('#profile #display-name').textContent(),'My account');
      assert.equal(await settingsFrame.locator('#settings-navigation [data-section=account]').getAttribute('aria-current'),'page');
      assert.equal(await home.isVisible(),false);
      assert.equal(await editor.isVisible(),false);
      assert.equal(await editor.evaluate(el=>el.inert),true);
      assert.equal(await page.locator('.studio-launchpad-app').isVisible(),false,'settings does not reveal the resident IM');
      assert.equal(await closeSettings.evaluate(el=>getComputedStyle(el).outlineStyle),'none','pointer-open does not draw a focus border around Back');
      await checkEditorSashes(page,false);
      await page.screenshot({path:fileURLToPath(new URL(`${stem}-account-settings.png`,proof))});
      await settingsFrame.locator('#settings-navigation [data-section=editor]').click();
      assert.equal(await settingsFrame.locator('#settings-editor').isVisible(),true);
      assert.equal(await settingsFrame.locator('[data-settings-action=json-current]').count(),0,'launchpad settings have no editor-only command');
      await closeSettings.click();
      assert.equal(await page.locator('.studio-launchpad-settings').count(),0);
      assert.equal(await page.locator('.webview-overlay-content').count(),0);
      assert.equal(await home.isVisible(),true);
      assert.equal(await accountButton.evaluate(el=>el===document.activeElement),true);
      await accountButton.click();
      await accountDialog.getByRole('button',{name:zh?'打开 Web 控制台':'Open Web console'}).click();
      assert.deepEqual(await page.evaluate(()=>window.actions.at(-1)),['studio.openLaunchpadResource','server']);
      for(const [index,id] of [[1,'solo'],[0,'group-team']]) {
        await page.locator('.lp-chat').nth(index).click(); await frame.getByText(id,{exact:true}).waitFor();
        assert.equal(await frame.getByLabel('draft').inputValue(),'keep draft');
        await page.getByRole('button',{name: language==='zh-cn'?'关闭 IM':'Close IM'}).click();
      }
      assert.equal(loads,1,'prewarm, A, B and A use the same document');
      assert.equal(await page.evaluate(()=>window.actions.filter(([id,title])=>id==='setHtml' && title==='IM').length),1);
      await page.evaluate(()=>window.settingsError=true);
      await accountButton.click(); await settings.click();
      await warning.waitFor();
      assert.ok((await warning.textContent()).includes(zh?'无法打开 Studio 设置':'Could not open Studio Settings'));
      assert.equal(await home.isVisible(),true); assert.equal(await editor.isVisible(),false);
      await warning.getByRole('button').click(); await warning.waitFor({state:'detached'});
      await page.evaluate(()=>window.settingsError=false);
      await accountButton.click();
      await page.evaluate(()=>{window.signOut();window.guest=true;window.refreshInbox();});
      await profile.getByText(zh?'尚未登录':'Not signed in',{exact:true}).waitFor();
      assert.equal(await profile.locator('.lp-account-email').count(),0,'sign out clears account details in the open dialog');
      assert.equal(await accountDialog.getByRole('button',{name:zh?'打开 Web 控制台':'Open Web console'}).count(),0);
      await accountDialog.getByRole('button',{name:zh?'在浏览器中登录':'Sign in with browser'}).click();
      await accountButton.press('Enter'); await settings.press('Enter');
      await settingsFrame.locator('#account-sign-in').waitFor();
      assert.notEqual(await closeSettings.evaluate(el=>getComputedStyle(el).outlineStyle),'none','keyboard-open shows the Back button focus');
      await closeSettings.press('Enter');
      await page.locator('.lp-connection[data-state=guest]').waitFor();
      assert.equal(await page.locator('.lp-account img').count(),0,'sign out clears the titlebar avatar');
      assert.equal(await page.locator('.studio-launchpad-app').count(),0,'sign out destroys the hidden view');
    } else {
      assert.equal(await page.locator('.lp-account').isVisible(),false); assert.equal(await page.locator('.lp-side').isVisible(),false);
    }
    const actions=await page.evaluate(()=>window.actions);
    assert.ok(!actions.some(([id])=>id==='studio.internalEnterIdeMode'||id==='studio.builtinIm.focus'));
    for(const expected of [['open','folderUri',true],['open','workspaceUri',true],['focus',23],['pickFolder',true],['pickWorkspace',true]]) assert.ok(actions.some(a=>JSON.stringify(a)===JSON.stringify(expected)),JSON.stringify(expected));
    if(enhanced) assert.ok(actions.some(([id])=>id==='studio.launchpadSignIn'));
    for(const width of [768,480,360]){await page.setViewportSize({width,height:640});assert.ok(await page.locator('.lp-home').evaluate(el=>el.scrollWidth<=el.clientWidth),`${language} at ${width}`);
      if(width===360){await page.screenshot({path:fileURLToPath(new URL(`${stem}-narrow.png`,proof))});}}
    await page.evaluate(()=>{window.closeProject();window.clearHistory();}); await page.locator('.lp-live-project').first().waitFor({state:'detached'}); await rows.first().waitFor({state:'detached'});
    assert.ok(await page.locator('.lp-history-list .lp-empty').isVisible());
    await checkProjectDrop(page,language);
    await page.evaluate(()=>window.cleanup()); assert.deepEqual(errors,[]); await page.close(); console.log(`${language}: launchpad layout, keyboard actions, window changes, drag and drop, creation${enhanced?', account and settings':''} passed`);
  }
} finally { await browser.close(); }
