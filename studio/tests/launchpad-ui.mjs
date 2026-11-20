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
  import { Event } from './src/vs/base/common/event.ts';
  import { CommandsRegistry } from './src/vs/platform/commands/common/commands.ts';
  const state = { canCreate: true, platform: window.enhanced, recent: [], recommendations: window.enhanced ? { items: [{ id:'checklist', name:'Checklist', description:'Verify a release' }] } : undefined };
  const root = document.querySelector('.monaco-workbench');
  const layout = { mainContainer:root, activeContainer:root, getContainer:()=>root.querySelector('.statusbar'), mainContainerOffset:{top:36}, onDidLayoutMainContainer: Event.None };
  const chats = { items:[{name:'Team',preview:'Review',unread:2}] };
  const commands = { async executeCommand(id, ...args) {
    window.actions.push([id,...args]);
    if (id === 'studio.getLaunchpadInbox') return chats;
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
  state.recent = folders.map(uri=>({uri:uri.toString(),lastOpened:1700000000000}));
  const windows = [{ id:23, workspace:{id:'folder',uri:folders[0]} }];
  const native = {getWindows:async()=>windows, focusWindow:async o=>window.actions.push(['focus',o.targetWindowId]),
    openWindow:async ([open],opts)=>window.actions.push(['open',Object.keys(open)[0],opts.forceNewWindow])};
  const start = { state, onDidChange: Event.None, setVisible(){} };
  const dialogs = { pickFolderAndOpen:async opts=>window.actions.push(['pickFolder',opts.forceNewWindow]), pickWorkspaceAndOpen:async opts=>window.actions.push(['pickWorkspace',opts.forceNewWindow]) };
  const controller = new StudioLaunchpad(start,native,{getRecentlyOpened:async()=>recent,onDidChangeRecentlyOpened:Event.None},layout,commands,dialogs,{error:e=>{throw e;}},{});
  window.closeProject=()=>{ windows.length=0; window.events['vscode:studioProjectWindowsChanged'](); };
  window.showHome=()=>CommandsRegistry.getCommand('studio.internalShowLaunchpad').handler();
  window.cleanup=()=>controller.dispose();
` }, tsconfig: `${kernel}/src/tsconfig.json`, bundle: true, write: false, outdir: 'out', target: 'es2022',
  loader: { '.svg':'dataurl', '.ttf':'dataurl', '.png':'dataurl' } });
const js = bundle.outputFiles.find(file=>file.path.endsWith('.js')).text;
const css = bundle.outputFiles.find(file=>file.path.endsWith('.css')).text;
const proof = new URL('../.studio/launchpad-ui/', import.meta.url);
await mkdir(proof, {recursive:true});
const hostFocusCss = '.monaco-workbench [tabindex=\"-1\"]:focus, .monaco-workbench button:focus { outline: 2px solid #007acc; outline-offset: -1px; }';
const codicons = new URL('../node_modules/@vscode/codicons/dist/', import.meta.url);
const iconCss = (await readFile(new URL('codicon.css',codicons),'utf8')).replace(/url\([^)]+\)/,`url(data:font/ttf;base64,${(await readFile(new URL('codicon.ttf',codicons))).toString('base64')})`);
const browser = await chromium.launch({ headless:true, executablePath:process.env.STUDIO_START_TEST_BROWSER_PATH || undefined });
try {
  for (const [language, enhanced] of [['zh-cn',true],['en',false]]) {
    const page = await browser.newPage({viewport:{width:1120,height:680}});
    const errors=[]; page.on('pageerror', e=>errors.push(e.message));
    await page.setContent(`<style>
      :root{--vscode-foreground:#d4d4d4;--vscode-editor-background:#1f1f1f;--vscode-sideBar-background:#252526;--vscode-panel-border:#3a3a3a;--vscode-textLink-foreground:#68b6ed;--vscode-button-background:#007acc;--vscode-button-foreground:white;--vscode-descriptionForeground:#aaa;--vscode-focusBorder:#007acc;--vscode-badge-background:#38383c;--vscode-badge-foreground:#eee;--vscode-list-hoverBackground:#303030;--vscode-input-background:#272727;--vscode-input-foreground:#ddd;--vscode-charts-yellow:#dcbd85;}
      main,body{margin:0}.monaco-workbench{position:fixed;inset:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);font:13px system-ui}.part.statusbar{height:22px}.part.titlebar{padding:8px;height:20px;background:var(--vscode-sideBar-background)}
      </style><div class="monaco-workbench"><div class="part titlebar">SteamHarness Studio</div><div class="part editor"><button>Editor</button></div><div class="part statusbar"></div></div>`);
    if (!enhanced) await page.addStyleTag({content:':root{--vscode-foreground:#262626;--vscode-editor-background:#fff;--vscode-sideBar-background:#f6f6f6;--vscode-panel-border:#ccc;--vscode-descriptionForeground:#565656;--vscode-input-background:#fafafa;--vscode-input-foreground:#333}'});
    await page.evaluate(({language,enhanced})=>{ window._VSCODE_NLS_LANGUAGE=language; window.enhanced=enhanced; window.actions=[]; window.events={}; window.vscode={ipcRenderer:{on:(id,fn)=>window.events[id]=fn,removeListener:id=>delete window.events[id]}}; },{language,enhanced});
    await page.addStyleTag({content:hostFocusCss}); await page.addStyleTag({content:css+'\n'+iconCss}); await page.addScriptTag({content:js});
    const rows=page.locator('.lp-project-row'); await rows.first().waitFor({timeout:5000}).catch(error=>{throw new Error(errors.join('\n') || error.message);});
    assert.equal(await rows.count(),5); assert.equal(await page.locator('.part.editor').evaluate(el=>el.inert),true);
    assert.equal(await page.locator('.studio-launchpad').evaluate(el=>getComputedStyle(el).outlineStyle),'none',`${language}: launchpad container must not draw a focus outline`);
    if (enhanced) await page.getByText('Review',{exact:true}).waitFor();
    assert.equal(await page.locator('.lp-store').isVisible(),enhanced);
    await page.screenshot({path:fileURLToPath(new URL(`${language}.png`,proof))});
    const foot=page.locator('.lp-foot button'); await foot.click(); assert.equal(await foot.evaluate(el=>getComputedStyle(el).outlineStyle),'none',`${language}: pointer focus must not draw a blue outline`); assert.equal(await rows.count(),9);
    const search=page.locator('.lp-search'); await search.fill('folder.code'); assert.equal(await rows.count(),1); await rows.first().press('Enter');
    await search.fill('sample.code'); await rows.first().click(); await search.fill('');
    await page.locator('.lp-live-project').click(); await page.locator('.lp-actions .lp-outline').first().click(); await page.locator('.lp-workspace').click();
    await page.locator('.lp-primary').click(); const modal=page.locator('.studio-create-dialog'); await modal.waitFor({timeout:5000});
    assert.equal(await modal.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}),true);
    await page.keyboard.press('Escape'); await modal.waitFor({state:'detached'});
    if(enhanced){ await page.locator('.lp-inbox .lp-link').click(); assert.equal(await page.locator('.studio-launchpad').isVisible(),false); await page.locator('.studio-launchpad-back').click(); }
    const actions=await page.evaluate(()=>window.actions);
    for(const expected of [['open','folderUri',true],['open','workspaceUri',true],['focus',23],['pickFolder',true],['pickWorkspace',true]]) assert.ok(actions.some(a=>JSON.stringify(a)===JSON.stringify(expected)),JSON.stringify(expected));
    await page.evaluate(()=>window.closeProject()); await page.locator('.lp-live-project').waitFor({state:'detached'});
    for(const width of [768,480,360]){await page.setViewportSize({width,height:640});assert.ok(await page.locator('.studio-launchpad').evaluate(el=>el.scrollWidth<=el.clientWidth),`${language} at ${width}`);}
    await page.evaluate(()=>window.cleanup()); assert.deepEqual(errors,[]); await page.close(); console.log(`${language}: launchpad layout, keyboard actions, window changes and create dialog passed`);
  }
} finally { await browser.close(); }
