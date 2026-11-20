import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';

// Render the desktop controller and its actual project-creation dialog with isolated host services.
const kernel = fileURLToPath(new URL('../upstream/vscode/', import.meta.url));
const bundle = await build({ stdin: { resolveDir: kernel, contents: `
  import { StudioLaunchpad } from './src/vs/workbench/electron-browser/studioLaunchpad.ts';
  import { StudioProjectCreateDialog } from './src/vs/workbench/contrib/studioStart/browser/studioProjectCreateDialog.ts';
  import { URI } from './src/vs/base/common/uri.ts';
  import { Emitter, Event } from './src/vs/base/common/event.ts';
  import { Sash, Orientation } from './src/vs/base/browser/ui/sash/sash.ts';
  import './src/vs/base/browser/ui/splitview/splitview.css';
  import './src/vs/workbench/contrib/modernUI/browser/media/sashHandles.css';
  import { CommandsRegistry } from './src/vs/platform/commands/common/commands.ts';
  import { FileOperationError, FileOperationResult } from './src/vs/platform/files/common/files.ts';
  import { hostedSidebarHtml } from '../../extensions/studio-workstation/src/project-sidebar-html.ts';
  const state = { canCreate: true, platform: window.enhanced, recent: [], recommendations: window.enhanced ? { items: [{ id:'checklist', name:'Checklist', description:'Verify a release' }] } : undefined };
  const root = document.querySelector('.monaco-workbench');
  const [outer, inner] = root.querySelectorAll('.sash-container');
  const sashes = [new Sash(outer, {getHorizontalSashTop:()=>365}, {orientation:Orientation.HORIZONTAL}),
    new Sash(inner, {getVerticalSashLeft:()=>400}, {orientation:Orientation.VERTICAL})];
  window.sashDrags = [];
  sashes.forEach(sash=>sash.onDidStart(()=>window.sashDrags.push(sash.orientation)));
  const layout = { mainContainer:root, activeContainer:root, getContainer:()=>root.querySelector('.titlebar'), mainContainerOffset:{top:36}, onDidLayoutMainContainer: Event.None };
  const chatAvatar = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#16a34a"/></svg>');
  const chats = { connection:'connected', items:[{id:'group-team',group:true,time:Date.now(),name:'Team',preview:'Review',unread:2,avatarUrl:chatAvatar},{id:'solo',name:'Solo',preview:'Hi',unread:0,avatarUrl:'data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path fill="#345" d="M0 0h32v32H0z"/></svg>')}] };
  const account = { status:'authenticated', name:'My account', avatarUrl:chatAvatar };
  const commandEvent = new Emitter();
  window.signOut = () => commandEvent.fire({commandId:'studio.internalUpdateAccountMenuState', args:[{status:'signed-out',name:'Signed out'}]});
  const commands = { onDidExecuteCommand:commandEvent.event, async executeCommand(id, ...args) {
    window.actions.push([id,...args]);
    if (id === 'studio.internalGetAccountMenuState') return account;
    if (id === 'studio.getLaunchpadInbox') return window.guest ? {items:[],message:'Signed out',connection:'guest'} : chats;
    if (id === 'studio.openLaunchpadInbox') {
      if (window.imError) return window.imError;
      if (window.delayOpen) await new Promise(resolve => window.finishOpening = resolve);
      const preview = { url:'http://127.0.0.1:4321/app' + (args[1] ? '#/?conversation_id='+encodeURIComponent(args[1]) : ''), nonce:'fixture', microphone:false };
      await CommandsRegistry.getCommand('studio.internalShowLaunchpadApp').handler(undefined, args[0],
        { title:'IM', port:4321, html:hostedSidebarHtml('en','IM',preview) });
      window.actions.push(['released', args[0]]);
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
  state.recent = folders.map((uri,i)=>({uri:uri.toString(),lastOpened:1700000000000,...(i===0?{projectType:'workflow',avatarUrl:avatar}:i===2?{projectType:'bot'}:{})}));
  const windows = [{ id:23, workspace:{id:'folder',uri:folders[0]} },{id:24,workspace:{id:'bot',uri:folders[2]}},{id:25,workspace:{id:'third',uri:folders[3]}}];
  const native = {getWindows:async()=>windows, focusWindow:async o=>window.actions.push(['focus',o.targetWindowId]),
    async showMessageBox({message,detail,buttons}) {
      const dialog = document.createElement('dialog'); dialog.className = 'native-message';
      dialog.append(message, detail ?? ''); document.body.append(dialog);
      const response = await new Promise(resolve => {
        buttons.forEach((label, i) => { const b=document.createElement('button'); b.textContent=label; b.onclick=()=>resolve(i); dialog.append(b); }); dialog.showModal();
      }); dialog.remove(); return {response};
    },
    openWindow:async ([open],opts)=>window.actions.push(['open',Object.keys(open)[0],opts.forceNewWindow])};
  const start = { state, onDidChange: Event.None, setVisible(){} };
  const dialogs = { pickFolderAndOpen:async opts=>window.actions.push(['pickFolder',opts.forceNewWindow]), pickWorkspaceAndOpen:async opts=>window.actions.push(['pickWorkspace',opts.forceNewWindow]),
    showOpenDialog: async opts=>{ window.actions.push(['relocate',opts.canSelectFolders]); return window.newLocation && [URI.file(window.newLocation)]; } };
  const files = { stat: async uri=>{ if(uri.path===window.missingPath) throw new FileOperationError('Missing',FileOperationResult.FILE_NOT_FOUND); return {isFile:uri.path===workspace.path,isDirectory:uri.path!==workspace.path}; } };
  const webviews = { createWebviewElement({title}) {
    const frame = document.createElement('iframe'); frame.title = title; frame.style.cssText = 'width:100%;height:100%;border:0;display:block';
    return { onMessage:Event.None, onFatalError:Event.None, mountTo:parent=>parent.append(frame), setHtml:html=>frame.srcdoc=html,
      focus:()=>frame.focus(), dispose:()=>frame.remove() };
  } };
  const changed = () => window.events['vscode:studioProjectWindowsChanged']();
  window.startLaunchpad = () => {
    root.classList.add('studio-launchpad-window');
    const controller = new StudioLaunchpad(start,native,{getRecentlyOpened:async()=>recent,onDidChangeRecentlyOpened:Event.None,removeRecentlyOpened:async ([uri])=>{
      window.actions.push(['forget',uri.path]); recent.workspaces=recent.workspaces.filter(row=>(row.folderUri??row.workspace.configPath).path!==uri.path); changed();
    }},layout,commands,dialogs,{error:e=>{throw e;}},{},webviews,files);
    window.clearHistory=()=>{recent.workspaces=[];changed();};
    window.refreshInbox=()=>CommandsRegistry.getCommand('studio.internalLaunchpadInboxChanged').handler(undefined,true);
    window.closeProject=()=>{ windows.length=0; window.events['vscode:studioProjectWindowsChanged'](); };
    window.showHome=()=>CommandsRegistry.getCommand('studio.internalShowLaunchpad').handler();
    window.openInbox=()=>CommandsRegistry.getCommand('studio.internalOpenLaunchpadInbox').handler();
    window.cleanup=()=>{ controller.dispose(); sashes.forEach(sash=>sash.dispose()); commandEvent.dispose(); };
  };
` }, tsconfig: `${kernel}/src/tsconfig.json`, bundle: true, write: false, outdir: 'out', target: 'es2022',
  loader: { '.svg':'dataurl', '.ttf':'dataurl', '.png':'dataurl' } });
const js = bundle.outputFiles.find(file=>file.path.endsWith('.js')).text;
const css = bundle.outputFiles.find(file=>file.path.endsWith('.css')).text;
const proof = new URL('../.studio/launchpad-ui/', import.meta.url);
await mkdir(proof, {recursive:true});
const hostFocusCss = '.monaco-workbench [tabindex=\"-1\"]:focus, .monaco-workbench button:focus { outline: 2px solid #007acc; outline-offset: -1px; }';
const codicons = new URL('../node_modules/@vscode/codicons/dist/', import.meta.url);
const iconCss = (await readFile(new URL('codicon.css',codicons),'utf8')).replace(/url\([^)]+\)/,`url(data:font/ttf;base64,${(await readFile(new URL('codicon.ttf',codicons))).toString('base64')})`);
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
const browser = await chromium.launch({ headless:true, executablePath:process.env.STUDIO_START_TEST_BROWSER_PATH || undefined });
try {
  for (const [language, enhanced, light] of [['zh-cn',true,true],['en',true,false],['en',false,true]]) {
    const page = await browser.newPage({viewport:{width:1120,height:680}});
    const errors=[]; page.on('pageerror', e=>errors.push(e.message));
    await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ postMessage() {} }); });
    await page.route('http://127.0.0.1:4321/**', route => route.fulfill({contentType:'text/html',body:'<main>Inbox fixture</main>'}));
    await page.goto('http://127.0.0.1:4321/');
    await page.setContent(`<style>
      :root{--vscode-foreground:#d4d4d4;--vscode-editor-background:#1f1f1f;--vscode-sideBar-background:#252526;--vscode-panel-border:#3a3a3a;--vscode-textLink-foreground:#68b6ed;--vscode-button-background:#007acc;--vscode-button-foreground:white;--vscode-descriptionForeground:#aaa;--vscode-focusBorder:#007acc;--vscode-badge-background:#38383c;--vscode-badge-foreground:#eee;--vscode-list-hoverBackground:#303030;--vscode-input-background:#272727;--vscode-input-foreground:#ddd;--vscode-charts-yellow:#dcbd85;}
      main,body{margin:0}.monaco-workbench{position:fixed;inset:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);font:13px system-ui}.part.statusbar{height:22px}.part.titlebar{height:44px}.titlebar-container{display:flex;align-items:center;justify-content:space-between;height:100%}.titlebar-right{display:flex}.monaco-workbench .part.titlebar>.titlebar-container>.titlebar-right>.action-toolbar-container:not(.has-no-actions){display:flex}
      .monaco-grid-view {position:absolute;inset:0}
      .part.titlebar {position:relative}.titlebar-drag-region {position:absolute;inset:0;-webkit-app-region:drag}.window-controls-container {position:relative}
      </style><div class="monaco-workbench modern-ui ${light?'vs':'vs-dark'}"><div class="monaco-grid-view"><div class="monaco-split-view2 vertical"><div class="sash-container"></div><div class="monaco-split-view2 horizontal"><div class="sash-container"></div>
      <div class="part titlebar"><div class="titlebar-container"><div class="titlebar-drag-region"></div><div class="titlebar-left"><button>IDE</button><button class="window-controls-container" style="width:66px">×</button></div><div class="titlebar-right"><div class="action-toolbar-container"><button>Layout</button></div></div></div></div><div class="part editor"><button>Editor</button></div><div class="part statusbar"></div></div></div></div></div>`);
    if (light) await page.addStyleTag({content:':root{--vscode-foreground:#262626;--vscode-editor-background:#fff;--vscode-sideBar-background:#f6f6f6;--vscode-panel-border:#d9d9d9;--vscode-descriptionForeground:#565656;--vscode-input-background:#fafafa;--vscode-input-foreground:#333;--vscode-textLink-foreground:#005fb8;--vscode-list-hoverBackground:#ededed;--vscode-badge-background:#dedede;--vscode-badge-foreground:#333}'});
    await page.evaluate(({language,enhanced})=>{ window._VSCODE_NLS_LANGUAGE=language; window.enhanced=enhanced; window.actions=[]; window.events={}; window.vscode={ipcRenderer:{on:(id,fn)=>window.events[id]=fn,removeListener:id=>delete window.events[id]}}; },{language,enhanced});
    await page.addStyleTag({content:hostFocusCss}); await page.addStyleTag({content:css+'\n'+iconCss}); await page.addScriptTag({content:js});
    await checkEditorSashes(page, true);
    for (const [x,y] of sashPoints) { await page.mouse.move(x,y); await page.mouse.down(); await page.mouse.move(x+10,y+10); await page.mouse.up(); }
    assert.equal(await page.evaluate(()=>new Set(window.sashDrags).size),2,'both resize directions still work in a project window');
    await page.evaluate(()=>window.startLaunchpad());
    const rows=page.locator('.lp-project-row'); await rows.first().waitFor({timeout:5000}).catch(error=>{throw new Error(errors.join('\n') || error.message);});
    await checkEditorSashes(page, false);
    assert.equal(await rows.count(),5); assert.equal(await page.locator('.part.editor').evaluate(el=>el.inert),true);
    assert.equal(await rows.locator('.lp-project-avatar').count(),1,`${language}: recent project avatar`);
    assert.ok((await rows.locator('.lp-project-avatar').getAttribute('src'))?.startsWith('data:image/svg+xml,'),`${language}: avatar data URL is preserved`);
    assert.deepEqual(await page.locator('.lp-project-type').allTextContents(),[language==='zh-cn'?'工作流':'Workflow', 'Bot'],`${language}: recent project types`);
    assert.deepEqual(await page.locator('.lp-plate-kind').allTextContents(), [language==='zh-cn'?'工作流':'Workflow', 'Bot', language==='zh-cn'?'文件夹':'Folder']);
    assert.equal(await page.locator('.lp-plate-kind .codicon-hubot').count(),1,'the Bot label uses its project glyph');
    assert.equal(await page.locator('.studio-launchpad').evaluate(el=>getComputedStyle(el).outlineStyle),'none',`${language}: launchpad container must not draw a focus outline`);
    if (enhanced) {
      await page.getByText('Review',{exact:true}).waitFor();
      const avatars = page.locator('img.lp-chat-avatar');
      assert.deepEqual(await avatars.evaluateAll(images=>Promise.all(images.map(async img=>{await img.decode();return img.naturalWidth>0;}))), [true,true],`${language}: user and group avatars actually decode`);
      assert.equal(await page.locator('.lp-account').getAttribute('title'),'My account');
    }
    assert.equal(await page.locator('.lp-store').isVisible(),enhanced);
    const stem = `${language}-${enhanced?'enhanced':'local'}-${light?'light':'dark'}`;
    await page.screenshot({path:fileURLToPath(new URL(`${stem}.png`,proof))});
    assert.equal(await page.locator('.lp-primary').evaluate(el=>getComputedStyle(el).backgroundColor), 'rgb(0, 122, 204)', 'primary action inherits the Studio theme');
    assert.equal(await page.locator('.action-toolbar-container').isVisible(),false,'layout controls must not overlap Web console');
    const bounds=async selector=>page.locator(selector).first().boundingBox();
    if(enhanced){assert.ok((await bounds('.lp-inbox')).x>(await bounds('.lp-projects')).x);assert.equal((await bounds('.lp-inbox')).x,(await bounds('.lp-store')).x);}
    const status=await bounds('.lp-statusbar');assert.equal(status.y+status.height,680);
    const foot=page.locator('.lp-foot button'); await foot.click(); assert.equal(await foot.evaluate(el=>getComputedStyle(el).outlineStyle),'none',`${language}: pointer focus must not draw a blue outline`); assert.equal(await rows.count(),9);
    const find=page.locator('.lp-find'), search=page.getByRole('combobox'); await find.click(); await search.fill('no-match'); assert.ok(await page.locator('.lp-quick-empty').isVisible());
    await search.press('Escape'); assert.ok(await find.evaluate(el=>el===document.activeElement));
    await page.keyboard.press('Control+p'); await search.fill('projects folder.code'); assert.equal(await page.getByRole('option').count(),1); await search.press('Enter');
    await page.locator('.lp-command-center').click(); await search.fill('sample.code'); await page.getByRole('option').click();
    await page.keyboard.press('F1'); await page.getByRole('option',{name:language==='zh-cn'?'打开文件夹…':'Open folder…',exact:true}).click();
    await page.locator('.lp-live-project').first().click(); await page.locator('.lp-actions .lp-outline').click(); await page.locator('.lp-choice').nth(1).click();
    await page.locator('.lp-statusbar button').click(); await page.locator('.lp-quick-foot button').click(); assert.equal(await search.inputValue(),'');
    await search.press('ArrowDown'); assert.equal(await search.getAttribute('aria-activedescendant'),'lp-option-1'); await page.keyboard.press('Escape');
    await rows.nth(1).click(); await rows.nth(1).press('ArrowDown'); assert.equal(await rows.nth(2).getAttribute('aria-selected'),'true');
    assert.notEqual(await rows.nth(2).evaluate(el=>getComputedStyle(el).outlineStyle),'none','keyboard navigation keeps focus visible');
    await page.locator('.lp-history-tools .lp-tool').click(); await page.locator('.lp-choice').nth(1).click();
    const missing=rows.filter({hasText:'Project 1'}); await page.evaluate(()=>window.missingPath='/projects/Project 1'); await missing.dblclick();
    const msg=page.locator('.native-message'); await msg.getByRole('button').first().click(); assert.ok(await missing.locator('.lp-missing').isVisible(),'cancelled relocation keeps history');
    await missing.locator('.lp-row-more').click(); await page.locator('.lp-choice').last().click(); await msg.getByRole('button').last().click(); assert.ok(await missing.isVisible());
    await page.evaluate(()=>window.newLocation='/projects/relocated'); await missing.press('Enter'); await msg.getByRole('button').first().click(); await missing.waitFor({state:'detached'});
    await page.locator('.lp-primary').click(); const modal=page.locator('.studio-create-dialog'); await modal.waitFor({timeout:5000});
    assert.equal(await modal.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}),true);
    await page.keyboard.press('Escape'); await modal.waitFor({state:'detached'});
    assert.equal(await page.getByRole('button', {name:'IDE'}).count(), 0);
    assert.equal(await page.locator('.window-controls-container').isVisible(), true);
    assert.equal(await page.locator('.studio-launchpad-back').count(), 0);
    if (enhanced) {
      const home = page.locator('.studio-launchpad'), open = page.locator('.lp-inbox header .lp-link'), editor = page.locator('.part.editor');
      await page.evaluate(() => window.imError = 'Service offline');
      await open.click(); const warning = page.locator('.native-message'); await warning.waitFor();
      assert.ok((await warning.textContent()).includes(language === 'zh-cn' ? '无法打开 IM' : 'Could not open IM'));
      assert.ok((await warning.textContent()).includes('Service offline'));
      assert.equal(await home.isVisible(), true); assert.equal(await editor.isVisible(), false);
      assert.equal(await page.locator('.studio-launchpad-app').count(), 0);
      await warning.getByRole('button').click(); await warning.waitFor({state:'detached'});
      // Cancelling a pending open (e.g. from the tray) must not let a late preview replace home.
      await page.evaluate(() => { window.imError = ''; window.delayOpen = true; });
      await open.click(); await page.waitForFunction(() => !!window.finishOpening);
      await page.evaluate(() => { window.showHome(); window.finishOpening(); window.delayOpen = false; });
      await page.waitForFunction(() => window.actions.some(([id])=>id==='released'));
      assert.equal(await home.isVisible(), true); assert.equal(await warning.count(), 0);
      await page.locator('.lp-chat').first().click();
      const frame = page.frameLocator('.studio-launchpad-app iframe').frameLocator('#project-frame');
      await frame.getByText('Inbox fixture').waitFor();
      assert.ok((await page.frameLocator('.studio-launchpad-app iframe').locator('#project-frame').getAttribute('src')).endsWith('#/?conversation_id=group-team'));
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
      await page.evaluate(()=>{window.signOut();window.guest=true;window.refreshInbox();}); await page.locator('.lp-chat-list > button').click(); assert.equal(await page.locator('.lp-connection').getAttribute('data-state'),'guest');
      assert.equal(await page.locator('.lp-account img').count(),0,'sign out clears the titlebar avatar');
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
    await page.evaluate(()=>window.cleanup()); assert.deepEqual(errors,[]); await page.close(); console.log(`${language}: launchpad layout, keyboard actions, window changes and create dialog passed`);
  }
} finally { await browser.close(); }
