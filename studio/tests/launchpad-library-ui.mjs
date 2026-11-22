import assert from 'node:assert/strict';
import { checkProfileSections } from './launchpad-profile-ui.mjs';
import { checkStoreExperience } from './launchpad-store-ui.mjs';
import { checkLaunchpadContrast } from './launchpad-contrast-ui.mjs';
import { checkLaunchpadBackButton } from './launchpad-back-button-ui.mjs';

export async function checkLibraryExperience({ page, language, enhanced, checkEditorSashes, checkProjectDrop, screenshot, loads }) {
  const zh = language === 'zh-cn', t = (en, cn) => zh ? cn : en;
  const home = page.locator('.studio-launchpad'), library = home.locator('#lp-page-library');
  const tab = name => home.locator(`#lp-tab-${name}`), cards = library.locator('.lp-all .lp-library-card');
  const createLabel=t('New project','新建项目'), importLabel=t('Import project','导入项目');
  const create=library.getByRole('button',{name:createLabel,exact:true}), importProject=library.getByRole('button',{name:importLabel,exact:true});
  const checkActionsHidden=async()=>{
    for (const name of [createLabel,importLabel]) assert.equal(await home.getByRole('button',{name,exact:true}).count(),0);
  };
  const header=home.locator('.lp-titlebar'), resources=header.getByRole('group',{name:t('Resources','资源')});
  const searchLabel=t('Search projects or commands','搜索项目或命令');
  const center=header.getByRole('button',{name:searchLabel,exact:true});
  page.setDefaultTimeout(6000);
  await cards.first().waitFor();
  assert.equal(await tab('library').getAttribute('aria-selected'), 'true');
  assert.equal(await home.getByRole('tab').count(), 4);
  assert.equal(await library.locator('[aria-selected=true]').count(), 0);
  assert.ok(await create.isDisabled()); assert.ok(await importProject.isEnabled());
  assert.deepEqual((await cards.locator('strong').allTextContents()).slice(0, 3), ['Sample.code-workspace','Project 8','folder.code-workspace']);
  await page.evaluate(() => window.activateProjects());
  await checkLaunchpadContrast({page,t,enhanced});
  const source = cards.filter({hasText:'Project 8'}), downloaded = cards.filter({hasText:'Project 6'});
  await source.getByText(t('Source · IDE','源码 · IDE')).waitFor();
  await downloaded.getByText(t('Downloaded source · Steam','已下载源码 · Steam')).waitFor();
  assert.equal(await source.locator('.lp-art-stack img').count(),2);
  const ratio = await source.locator('.lp-artwork').evaluate(el=>el.querySelector('.lp-art-stack').offsetWidth/el.offsetWidth);
  assert.ok(ratio>0.35 && ratio<0.5);
  assert.equal(await cards.filter({hasText:'Project 5'}).locator('.lp-art-file').count(),3);
  await page.evaluate(()=>{window.stopLaunchpad();window.delayProjects();window.startLaunchpad();});
  await downloaded.getByText(t('Downloaded source · Steam','已下载源码 · Steam')).waitFor();
  await page.evaluate(()=>window.activateProjects());
  const names=[t('Documentation','文档'),'GitHub',...(enhanced?[t('Web console','Web 控制台')]:[])];
  assert.deepEqual(await resources.getByRole('button').allTextContents(),names);
  for (const name of names) {
    const resource=resources.getByRole('button',{name,exact:true}); assert.ok(await resource.getByText(name,{exact:true}).isVisible()); await resource.click();
  }
  assert.deepEqual(await page.evaluate(()=>window.actions.filter(([id])=>['external','studio.openLaunchpadResource'].includes(id))),[
    ['studio.openLaunchpadResource','docs'],['external','https://github.com/steamharness/steamharness',true],...(enhanced?[['studio.openLaunchpadResource','server']]:[])]);
  const logo=await header.locator('.lp-brand img').boundingBox(), avatar=await header.locator('.lp-avatar').boundingBox();
  assert.deepEqual([logo.width,logo.height,avatar.width,avatar.height],[36,36,32,32]);
  await checkEditorSashes(page,false);
  await library.locator('.lp-recent .lp-cover').evaluate(img => img.decode());
  await screenshot('library');
  const detail = library.locator('.lp-project-details'), row = name => library.locator('.lp-index').getByRole('button',{name,exact:true});
  const openCount = () => page.evaluate(()=>window.actions.filter(([id])=>id==='focus'||id==='open').length);
  // The workbench menu intentionally ignores mouseup for 100 ms after it first appears.
  const choose = (en,cn) => page.getByRole('menuitem',{name:t(en,cn),exact:true}).click({delay:150});
  const before = await openCount();
  await source.click(); await detail.getByRole('heading',{name:'Project 8',exact:true}).waitFor();
  const productAction=detail.getByRole('button',{name:t('Fixture action','示例操作'),exact:true});
  if(enhanced){await productAction.click();assert.ok(await page.evaluate(()=>window.actions.some(([id,uri,key])=>id==='studio.runLibraryProjectAction' && uri.startsWith('file:') && key==='fixture')));}
  else {assert.equal(await productAction.count(),0);assert.equal(await page.evaluate(()=>window.actions.some(([id])=>id==='studio.listLibraryProjectActions')),false);}
  await checkActionsHidden();
  assert.equal(await row('Project 8').getAttribute('aria-current'),'page');
  for (const text of [t('Source · IDE','源码 · IDE'),'1.2.0','/projects/Project 8','294b1eec-23fa-42cf-9fd3-2417f71c0570','Main workflow',t('Default','默认入口')]) await detail.getByText(text,{exact:true}).waitFor();
  await row('Project 6').click({button:'right'}); await choose('Copy path','复制路径');
  await page.waitForFunction(()=>window.actions.some(([id,path])=>id==='copy' && path==='/projects/Project 6'));
  await row('Project 6').focus(); await page.keyboard.press('Shift+F10'); await choose('Show in file manager','在文件管理器中显示');
  await page.waitForFunction(()=>window.actions.some(([id,path])=>id==='reveal' && path==='/projects/Project 6'));
  await row('Project 6').click({button:'right'}); await choose('View details','查看详情'); await detail.getByText(t('Downloaded source · Steam','已下载源码 · Steam')).waitFor();
  await row('Project 8').press('Enter'); await page.evaluate(()=>window.editProject(23,true)); await detail.getByText(t('Unsaved','未保存')).waitFor();
  await page.evaluate(()=>window.editProject(23,false)); await detail.getByText(t('Open','已打开'),{exact:true}).waitFor();
  assert.equal(await openCount(),before,'browsing the library must not open or focus a project');
  await screenshot('project-details');
  const request = () => page.evaluate(()=>window.openRequests.at(-1));
  const expectEntry = async (path, studioProjectEntry) => assert.deepEqual(await request(), {openables:[{kind:'folderUri',path}],forceNewWindow:true,studioProjectEntry});
  await detail.getByRole('button',{name:t('Switch to window','切换到项目窗口')}).click(); await expectEntry('/projects/Project 8',{});
  await detail.getByRole('button',{name:t('Run project','运行项目'),exact:true}).click(); await expectEntry('/projects/Project 8',{});
  await detail.getByRole('button',{name:`${t('Open entry','打开入口')}: Chat`,exact:true}).click(); await expectEntry('/projects/Project 8',{entryId:'chat'});
  await tab('library').click(); assert.equal(await library.locator('[aria-current=page]').count(),0);
  await library.locator('.lp-recent .lp-library-card').first().click(); await detail.getByText(t('Workspace','工作区'),{exact:true}).waitFor();
  assert.equal(await openCount(),before+3);
  await detail.getByRole('button',{name:t('Open in new window','在新窗口打开')}).click(); assert.deepEqual(await page.evaluate(()=>window.actions.at(-1)),['open','workspaceUri',true]);
  await row('folder.code-workspace').click(); await detail.getByRole('button',{name:t('Open in IDE','在 IDE 中打开')}).click();
  await expectEntry('/projects/folder.code-workspace',{});
  await row('Project 4').click(); await detail.getByText(t('Release · Steam','发行版 · Steam')).waitFor();
  await detail.getByRole('button',{name:t('Open in Steam mode','在 Steam 模式打开')}).click();
  await expectEntry('/projects/Project 4',{});
  await detail.getByRole('button',{name:`${t('Open entry','打开入口')}: Release board`,exact:true}).click(); await expectEntry('/projects/Project 4',{entryId:'board'});
  await row('Project 1').click(); await row('Project 1').click({button:'right'}); await choose('Remove from history…','移除打开记录…');
  await page.locator('.native-message').getByRole('button',{name:t('Remove record','移除记录'),exact:true}).click();
  await cards.first().waitFor(); await row('Project 1').waitFor({state:'detached'}); assert.equal(await detail.count(),0);
  const find = library.getByRole('searchbox'); await find.fill('Project 8'); assert.equal(await cards.count(),1);
  await tab('community').click(); await home.getByText(t('Coming soon','暂未开放')).waitFor();
  await checkActionsHidden(); await home.press('F1'); await home.locator('dialog[open] [role=listbox]').waitFor();
  for (const name of [createLabel,importLabel]) assert.equal(await home.getByRole('option',{name,exact:true}).count(),0);
  await page.keyboard.press('Escape');
  await tab('library').click(); assert.equal(await find.inputValue(),'Project 8'); await find.fill('');
  await library.getByRole('button',{name:t('Installed','已安装'),exact:true}).click(); assert.equal(await cards.count(),2);
  const linked = library.getByRole('button',{name:t('Linked projects','已关联项目'),exact:true});
  if (enhanced) {
    const members = library.locator('.lp-product .lp-library-card strong');
    await linked.click();
    assert.deepEqual(await members.allTextContents(), ['Project 6','Project 4']);
    await find.fill('Project 4'); assert.deepEqual(await members.allTextContents(), ['Project 4']);
    await find.fill('Project 8'); await library.getByText(t('No matching projects.','没有匹配的项目。')).waitFor();
    await find.fill('');
    await page.evaluate(()=>window.setLibraryCategory(['Project 4']));
    await members.filter({hasText:'Project 6'}).waitFor({state:'detached'});
    assert.deepEqual(await members.allTextContents(), ['Project 4']);
    const viewport = page.viewportSize();
    await page.setViewportSize({width:360,height:640}); await linked.click({trial:true});
    assert.ok(await library.evaluate(el=>el.scrollWidth<=el.clientWidth));
    await screenshot('linked-projects'); await page.setViewportSize(viewport);
    await page.evaluate(()=>{window.holdLibraryCategory=true;window.setLibraryCategory(['Project 6']);});
    await page.waitForFunction(()=>typeof window.resumeLibraryCategory==='function');
    await page.evaluate(()=>window.updateAccount({scopeKey:'b'.repeat(64)}));
    assert.equal(await members.count(),0, 'switching accounts clears the old category immediately');
    await linked.click();
    const empty = library.getByText(t('No linked projects.','没有已关联的项目。'));
    await empty.waitFor();
    await page.evaluate(()=>window.resumeLibraryCategory());
    assert.ok(await empty.isVisible(), 'an old result cannot repopulate the new account');
    await page.evaluate(()=>window.updateAccount({scopeKey:'a'.repeat(64)}));
    await linked.waitFor();
  } else {
    assert.equal(await linked.count(),0);
    assert.equal(await page.evaluate(()=>window.actions.some(([id])=>id==='studio.getLibraryProjectCategory')),false);
  }
  await library.getByRole('button',{name:t('All','全部'),exact:true}).click();
  await checkStoreExperience({page,t,enhanced,screenshot});
  await checkActionsHidden();
  await tab('profile').click(); await checkActionsHidden();
  assert.ok(await center.getByText(searchLabel, { exact:true }).isVisible());
  const quick = home.getByRole('dialog', { name:t('Command center','命令中心') });
  const previousOpens = await openCount();
  await center.click(); await quick.getByRole('combobox').waitFor();
  await screenshot('command-center');
  assert.equal(await center.getAttribute('aria-expanded'), 'true');
  await quick.getByRole('combobox').fill('/projects/Project 8');
  await quick.getByRole('option', { name:/Project 8/ }).click();
  await detail.getByRole('heading', { name:'Project 8', exact:true }).waitFor();
  assert.equal(await openCount(), previousOpens, 'a picker result shows details without opening or focusing a project window');
  await page.keyboard.press('Control+Shift+p');
  await quick.getByRole('combobox', { name:t('Find a command','查找命令') }).waitFor();
  await page.keyboard.press('Escape');
  assert.deepEqual(await center.evaluate(el => [el.getAttribute('aria-expanded'), el === document.activeElement]), ['false', true]);
  await tab('library').click(); await home.getByRole('button',{name:t('Open project…','打开项目…'),exact:true}).click();
  await home.getByRole('button',{name:t('Open folder…','打开文件夹…')}).click();
  assert.deepEqual(await page.evaluate(()=>window.actions.at(-1)),['pickFolder',true]);
  await home.press('Control+o'); await home.getByRole('button',{name:t('Open workspace…','打开工作区…')}).click();
  assert.deepEqual(await page.evaluate(()=>window.actions.at(-1)),['pickWorkspace',true]);
  await page.keyboard.press('Control+p'); await home.locator('dialog[open] input').fill('Project 6'); const searches = await openCount(); await page.keyboard.press('Enter');
  await detail.getByRole('heading',{name:'Project 6'}).waitFor(); assert.equal(await openCount(),searches); await tab('library').click();
  await create.click(); await page.getByRole('dialog').waitFor(); await page.keyboard.press('Escape');
  const oldOpens=await openCount(); await find.fill('no matching folder'); await importProject.click();
  assert.deepEqual(await page.evaluate(()=>window.actions.filter(([id])=>id==='pickPaths').at(-1)[1]),{
    title:importLabel,openLabel:t('Import','导入'),canSelectFolders:true,canSelectFiles:false,canSelectMany:true,availableFileSystems:['file']});
  assert.equal(await find.inputValue(),'no matching folder'); assert.equal(await page.evaluate(()=>window.actions.some(([id])=>id==='import')),false);
  await page.evaluate(()=>{window.selectedPaths=['/projects/Imported folder'];window.delayHistory=true;}); await importProject.click();
  await page.waitForFunction(()=>typeof window.resumeHistory==='function'); await page.evaluate(()=>window.resumeHistory());
  await detail.getByRole('heading',{name:'Imported folder',exact:true}).waitFor(); assert.equal(await find.inputValue(),'');
  await tab('library').click(); await importProject.click(); await detail.getByRole('heading',{name:'Imported folder',exact:true}).waitFor();
  assert.equal(await openCount(),oldOpens,'import and reimport do not launch or focus a project');
  await detail.getByRole('button',{name:t('Open in new window','在新窗口打开')}).click();
  assert.deepEqual(await page.evaluate(()=>window.openRequests.at(-1)),{openables:[{kind:'folderUri',path:'/projects/Imported folder'}],forceNewWindow:true});
  await tab('library').click(); assert.equal(await cards.filter({hasText:'Imported folder'}).count(),1);
  if (enhanced) {
    await page.evaluate(()=>{window.notify('Account A only');});
    const list=()=>page.evaluate(()=>window.localNotices());
    assert.deepEqual((await list()).map(n=>n.title),['Account A only']);
    const [notice]=await list(); await page.evaluate(()=>window.updateAccount({scopeKey:'b'.repeat(64)}));
    assert.equal((await list()).length,0); await page.evaluate(id=>window.readNotice(id),notice.id);
    await page.evaluate(()=>window.updateAccount({scopeKey:'a'.repeat(64)})); assert.equal((await list())[0].read,false);
    await page.evaluate(id=>window.readNotice(id),notice.id); assert.equal((await list())[0].read,true);
    await page.evaluate(()=>window.prewarm()); assert.equal(page.context().pages().length,1);
    await page.evaluate(()=>window.imError='offline'); await home.locator('.lp-chat-launch').click();
    const warning=page.locator('.native-message'); await warning.getByText(/offline/).waitFor(); await warning.getByRole('button').click();
    assert.equal(await page.locator('.part.editor').isVisible(),false); assert.equal(page.context().pages().length,1);
    await page.evaluate(()=>{window.imError='';window.socialFailure='unsupported';window.socialGate=new Promise(resolve=>window.resumeSocial=resolve);});
    await tab('profile').click(); const profile=home.locator('#lp-page-profile');
    await profile.getByRole('tab',{name:t('Recent chats','最近会话'),exact:true}).click();
    const team=profile.locator('.lp-social-row').filter({hasText:'Team'});
    await team.locator('.lp-avatar img').evaluate(img=>img.decode());
    const opened=page.waitForEvent('popup'); await team.getByRole('button').click(); const popup=await opened;
    const frame=popup.frameLocator('iframe').frameLocator('#project-frame'); await frame.getByText('group-team',{exact:true}).waitFor();
    assert.ok(await home.isVisible()); await frame.getByLabel('draft').fill('kept');
    assert.deepEqual(await profile.locator('.lp-profile-identity small').allTextContents(), ['me@example.test']);
    assert.equal(await profile.getByText(t('Server Connected','服务器已连接'),{exact:true}).count(),0);
    await checkProfileSections({page,profile,frame,t,screenshot}); assert.equal(loads(),1);
    await profile.getByRole('button',{name:t('Settings','设置'),exact:true}).click(); await page.locator('.studio-launchpad-settings').waitFor();
    assert.equal(await home.isVisible(),false); assert.equal(await page.locator('.part.editor').evaluate(el=>el.inert),true);
    await checkLaunchpadBackButton(page); await screenshot('settings-back-button');
    const settings=page.frameLocator('.webview-overlay-content iframe'); await settings.locator('#profile #display-name').getByText('My account').waitFor();
    await page.locator('.studio-launchpad-app-close').click(); await home.waitFor();
    const closed=popup.waitForEvent('close'); await page.evaluate(()=>{window.guest=true;window.signOut();}); await closed;
    assert.equal(await profile.getByText('Saved message').count(),0); await profile.getByRole('button',{name:t('Sign in','登录'),exact:true}).click();
  } else {
    assert.ok(!await home.locator('.lp-chat-launch').isVisible()); await tab('profile').click();
    const profile=home.locator('#lp-page-profile'); assert.equal(await profile.getByRole('tab').count(),1);
    assert.equal(await profile.getByRole('tab',{name:'Notifications',exact:true}).getAttribute('aria-selected'),'true');
    await profile.getByRole('heading',{name:'Notifications',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.actions.filter(([id])=>id==='studio.getSocialSnapshot').length),0);
  }
  await tab('library').click();
  for (const width of [768,480,360]) {
    await page.setViewportSize({width,height:640}); assert.ok(await find.isVisible());
    for (const name of names) {
      const item=resources.getByRole('button',{name,exact:true}); assert.equal(await item.getAttribute('title'),name);
      if(width<=480) assert.equal(await item.getByText(name,{exact:true}).isVisible(),false);
      await item.click({trial:true});
    }
    await importProject.click({trial:true}); await create.click({trial:true});
    const overflow=await home.evaluate(el=>[el.scrollWidth,el.clientWidth,Array.from(el.querySelectorAll('*')).filter(c=>{if(c.getBoundingClientRect().right<=innerWidth)return false;for(let p=c.parentElement;p&&p!==el;p=p.parentElement)if(/hidden|scroll|auto|clip/.test(getComputedStyle(p).overflowX))return false;return true;}).map(c=>[c.className,c.textContent.slice(0,40)])]);
    assert.ok(overflow[0]<=overflow[1],`overflow at ${width}: ${JSON.stringify(overflow)}`);
  }
  for (const width of [1120,768,360]) {
    await page.setViewportSize({width,height:640});
    for (const side of ['right','left']) {
      await page.evaluate(side=>window.placeWindowControls(side),side);
      const controls=page.locator('.window-controls-container'), nativeBox=await controls.boundingBox();
      const edge=await header.locator(side==='left'?'.lp-brand img':'.lp-account').boundingBox();
      assert.ok(side==='left'?edge.x>=nativeBox.x+nativeBox.width:edge.x+edge.width<=nativeBox.x,`header must clear ${side} window controls`);
      const [brand, search, tools] = await Promise.all([header.locator('.lp-brand').boundingBox(), center.boundingBox(), resources.boundingBox()]);
      assert.ok(search.width >= 24 && brand.x + brand.width <= search.x && search.x + search.width <= tools.x, `command center overlaps at ${width} with ${side} controls`);
      if (width >= 768) assert.ok(Math.abs(search.x + search.width / 2 - width / 2) <= 1, `command center is not centered at ${width} with ${side} controls`);
      await controls.click({trial:true});
      for (const button of await header.getByRole('button').all()) await button.click({trial:true});
    }
  }
  await create.hover(); assert.notEqual(await create.evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)'); await page.mouse.move(0,0);
  await screenshot('narrow');
  await cards.filter({hasText:'Project 8'}).click(); await detail.getByRole('button',{name:t('Switch to window','切换到项目窗口')}).waitFor();
  assert.ok(await detail.evaluate(el=>el.scrollWidth<=el.clientWidth && el.getBoundingClientRect().right<=innerWidth));
  await detail.getByText(t('Default','默认入口')).scrollIntoViewIfNeeded(); await tab('library').click();
  await page.evaluate(()=>{window.closeProject();window.clearHistory();}); await cards.first().waitFor({state:'detached'});
  await library.locator('.lp-empty').waitFor(); await checkProjectDrop(page,language);
  assert.ok(!await page.evaluate(()=>window.actions.some(([id])=>id==='studio.internalEnterIdeMode'||id==='studio.builtinIm.focus')));
}
