import assert from 'node:assert/strict';
import { checkProfileSections } from './launchpad-profile-ui.mjs';
import { checkStoreExperience } from './launchpad-store-ui.mjs';
import { checkLaunchpadContrast } from './launchpad-contrast-ui.mjs';
import { checkLaunchpadBackButton } from './launchpad-back-button-ui.mjs';

export const primaryFolderBotName = 'Folder Bot 1 · Standard agent development';

async function checkDetailActionLayout(page, detail, screenshot) {
  const viewport = page.viewportSize();
  try {
    for (const width of [1440, 360]) {
      await page.setViewportSize({ ...viewport, width });
      const layout = await detail.evaluate(article => {
        const frame = article.parentElement.getBoundingClientRect(), content = article.getBoundingClientRect();
        const headerActions = [...article.querySelectorAll('.lp-detail-actions > button')];
        const actions = headerActions.map(button => button.getBoundingClientRect());
        const controls = [...headerActions, ...article.querySelectorAll('.lp-detail-secondary button')].map(button => button.getBoundingClientRect());
        const mark = article.querySelector('.lp-detail-mark').getBoundingClientRect();
        const identity = article.querySelector('.lp-detail-identity').getBoundingClientRect();
        const isSingleLine = heading => heading.offsetHeight <= Math.ceil(parseFloat(getComputedStyle(heading).lineHeight));
        return {
          gutters: [content.left - frame.left, frame.right - content.right],
          oneLineTitle: isSingleLine(article.querySelector('h1')),
          oneLineGroupLabels: [...article.querySelectorAll('.lp-detail-action-group:not([hidden]) > h2')].every(isSingleLine),
          equalActionHeights: actions.every(rect => rect.height === actions.at(-1).width),
          sameRow: actions.every(rect => rect.top === actions[0].top),
          actionsBelowTitle: actions.every(rect => rect.top >= Math.max(mark.bottom, identity.bottom)),
          fit: controls.every(rect => rect.left >= content.left - 1 && rect.right <= content.right + 1),
          headingPaired: mark.right <= identity.left && mark.bottom > identity.top && identity.bottom > mark.top,
        };
      });
      const [left, right] = layout.gutters;
      assert.ok(left >= -1 && right >= -1 && Math.abs(left - right) <= 1, `Details must be centered at ${width}px: ${left}, ${right}`);
      assert.ok(layout.fit && layout.headingPaired && layout.equalActionHeights && layout.oneLineGroupLabels, `Actions and title must fit at ${width}px: ${JSON.stringify(layout)}`);
      if (width === 1440) {
        assert.ok(left > 0 && layout.sameRow && layout.oneLineTitle, 'Wide details must leave room for the heading and keep header actions in a single row');
      } else {
        assert.ok(layout.actionsBelowTitle, 'Narrow details must wrap the action group below the title and icon');
      }
      await screenshot?.(width);
    }
  } finally {
    await page.setViewportSize(viewport);
  }
}

export async function checkFolderBotStartup({ page, enhanced }) {
  const library = page.locator('#lp-page-library');
  const index = library.locator('.lp-index');
  const ordinary = index.getByRole('button', { name: '035a4096-66aa-496b-8ebc-f94288f3bc76.code-workspace', exact: true });
  await index.getByRole('button', { name: 'Project 2', exact: true }).waitFor();
  await ordinary.waitFor();
  if (enhanced) {
    await page.waitForFunction(() => typeof window.resumeFolderBotStartup === 'function');
    const ids = library.getByText(/b488125a-b8f6-478c-9cbd-c0f37d26a549|56941969-b1e9-4858-986a-ccccccecc7bc/);
    assert.equal(await ids.count(), 0, 'native history and the running window must not flash a generated workspace ID');
    await page.evaluate(() => { window.holdFolderBotStartup = false; window.resumeFolderBotStartup(); });
    const branch = index.locator('.lp-index-branch').filter({ has: page.getByRole('button', { name: 'Project 2', exact: true }) });
    const bot = branch.locator('.lp-index-children').getByRole('button', { name: 'Project 2 · Local assistant', exact: true });
    await bot.waitFor();
    assert.equal(await bot.locator('img[src^="data:image/svg+xml,"]').count(), 1);
    assert.equal(await branch.locator('.lp-index-toggle').getAttribute('aria-expanded'), 'true');
    assert.equal(await ids.count(), 0, 'removed instances must not return as native history entries');
  } else {
    assert.equal(await page.evaluate(() => window.actions.some(([id]) => id === 'studio.listLibraryExtraProjects')), false);
  }
  await page.evaluate(() => window.clearFolderBotStartup());
  await ordinary.waitFor({ state: 'detached' });
  await index.getByRole('button', { name: 'Project 2 · Local assistant', exact: true }).waitFor({ state: 'detached' });
}

export async function checkFolderBotBranches({ page, language, enhanced, screenshot }) {
  const t = (en, zh) => language === 'zh-cn' ? zh : en;
  const home = page.locator('.studio-launchpad'), library = home.locator('#lp-page-library');
  const index = library.locator('.lp-index'), row = name => index.getByRole('button', { name, exact: true });
  const detail = library.locator('.lp-project-details');
  const action = name => detail.getByRole('button', { name, exact: true });
  const botName = number => number === 1 ? primaryFolderBotName : `Folder Bot ${number}`;
  const botGroup = detail.getByRole('region', { name: t('Bot instances', 'Bot 分身'), exact: true });
  const imGroup = detail.getByRole('region', { name: t('IM integration', 'IM 集成'), exact: true });
  const withBot = botGroup.getByRole('button', { name: t('Open with Bot…', '用 Bot 打开…'), exact: true });
  const libraryTab = home.locator('#lp-tab-library');
  const choose = (en, zh) => page.getByRole('menuitem', { name: t(en, zh), exact: true }).click({ delay: 150 });
  await row('Project 8').click();
  await detail.getByText(t('Source · IDE', '源码 · IDE'), { exact: true }).waitFor();
  assert.deepEqual(await detail.locator('.lp-detail-actions > button').allTextContents(), [t('Run project', '运行项目'), t('Switch to window', '切换到项目窗口'), '']);
  await checkDetailActionLayout(page, detail);
  if (!enhanced) {
    assert.equal(await botGroup.count(), 0);
    assert.equal(await imGroup.count(), 0);
    assert.equal(await index.locator('.lp-index-toggle').count(), 0);
    await libraryTab.click();
    return;
  }

  // Local creation does not require IM sign-in or an eligible Bot entry in the target project.
  await page.evaluate(() => { window.guest = true; window.signOut(); });
  for (const name of ['Project 6', 'folder.code-workspace', 'Project 8']) {
    await row(name).click();
    await withBot.waitFor();
    const glyph = withBot.locator('.codicon-steamharness-bot');
    assert.equal(await glyph.getAttribute('aria-hidden'), 'true');
    assert.match(decodeURIComponent(await glyph.evaluate(node => getComputedStyle(node, '::before').maskImage)), /M12 8V4H8/u);
    assert.equal(await withBot.locator('.codicon').count(), 1);
  }
  assert.equal(await imGroup.count(), 0, 'IM actions require a signed-in account but local Bot actions do not');
  const workspace = number => `/profile/Folder Bot ${number}.code-workspace`;
  const create = async (parent, number) => {
    await row(parent).click();
    await withBot.click();
    const instance = row(botName(number));
    await instance.waitFor();
    assert.equal(await instance.locator('xpath=..').getAttribute('aria-labelledby'), await row(parent).getAttribute('id'));
    assert.ok((await instance.boundingBox()).x > (await row(parent).boundingBox()).x);
    assert.deepEqual(await page.evaluate(() => window.openRequests.at(-1)), {
      openables: [{ kind: 'workspaceUri', path: workspace(number) }], forceNewWindow: true,
    });
  };
  await create('Project 2', 1);
  await create('Project 2', 2);
  const branch = index.locator('.lp-index-branch').filter({ has: page.getByRole('button', { name: 'Project 2', exact: true }) });
  const toggle = branch.locator('.lp-index-toggle');
  assert.equal(await toggle.getAttribute('aria-label'), `${t('Collapse Bot instances', '折叠 Bot 分身')}: Project 2`);
  const [parentBox, toggleBox] = await Promise.all([row('Project 2').boundingBox(), toggle.boundingBox()]);
  assert.ok(toggleBox.x >= parentBox.x + parentBox.width && toggleBox.y === parentBox.y);
  const opens = () => page.evaluate(() => window.actions.filter(([id]) => id === 'open' || id === 'focus').length);
  const before = await opens();
  await toggle.press('Enter');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await toggle.getAttribute('aria-label'), `${t('Expand Bot instances', '展开 Bot 分身')}: Project 2`);
  assert.equal(await row(botName(1)).count(), 0);
  assert.equal(await opens(), before);
  await detail.getByRole('heading', { name: 'Project 2', exact: true }).waitFor();

  await create('Project 8', 3);
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'unrelated updates preserve the collapsed branch');
  const find = library.getByRole('searchbox');
  await find.fill('Folder Bot 1');
  assert.equal(await branch.locator('.lp-index-children').getByRole('button').count(), 1);
  assert.ok(await row(botName(1)).isVisible());
  await find.fill('');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'clearing the query restores the previous collapse state');
  await toggle.click();
  await row(botName(1)).click();
  assert.equal(await withBot.count(), 0);
  const focused = await opens();
  await action(t('Switch to window', '切换到项目窗口')).click();
  await page.waitForFunction(count => window.actions.filter(([id]) => id === 'open' || id === 'focus').length === count + 1, focused);
  assert.deepEqual(await page.evaluate(() => window.openRequests.flatMap(req => req.openables.filter(item => item.path.startsWith('/profile/Folder Bot ')))),
    [1, 2, 3].map(number => ({ kind: 'workspaceUri', path: workspace(number) })));

  await libraryTab.click();
  const filter = (en, zh) => library.getByRole('button', { name: t(en, zh), exact: true });
  await filter('Folders', '文件夹').click();
  assert.ok(await row(botName(1)).isVisible());
  assert.equal(await row('Folder Bot 3').count(), 0);
  await filter('Source', '源码').click();
  assert.ok(await row('Folder Bot 3').isVisible());
  assert.equal(await row(botName(1)).count(), 0);

  await page.evaluate(name => {
    window.updateAccount({ status: 'authenticated', hasAccount: true, scopeKey: 'a'.repeat(64) });
    window.setLibraryCategory([name]);
  }, botName(1));
  await filter('Linked projects', '已关联项目').click();
  await library.locator('.lp-product .lp-library-card').getByText(botName(1), { exact: true }).waitFor();
  assert.deepEqual(await index.locator('.lp-index-row').allTextContents(), ['Project 2', botName(1)]);
  assert.equal(await library.locator('.lp-product .lp-library-card').count(), 1, 'the parent is context, not itself linked');
  await filter('All', '全部').click();

  await row(botName(2)).click();
  await imGroup.getByRole('button', { name: t('Add to IM contacts', '添加到 IM 通讯录'), exact: true }).waitFor();

  await row(botName(1)).click();
  const review = imGroup.getByRole('button', { name: t('Review IM permissions…', '确认 IM 权限…'), exact: true });
  await review.waitFor();
  assert.deepEqual(await imGroup.getByRole('button').allTextContents(), [
    t('Open Bot chat', '打开 Bot 对话'), t('Review IM permissions…', '确认 IM 权限…'), t('Unlink from IM…', '解除 IM 绑定…'),
  ]);
  assert.equal(await botGroup.count(), 0, 'an existing instance has an IM section but no create-Bot section');
  assert.deepEqual(await detail.locator('.lp-detail-actions > button').allTextContents(), [t('Switch to window', '切换到项目窗口'), '']);
  await checkDetailActionLayout(page, detail, width => screenshot(`folder-bot-details-${width}`));
  await review.click();
  await page.waitForFunction(() => window.actions.some(([id, uri, action]) => id === 'studio.runLibraryProjectAction' && uri.endsWith('/Folder%20Bot%201.code-workspace') && action === 'review-folder-permission'));

  await row('Project 2').click({ button: 'right' });
  await choose('Remove from history…', '移除打开记录…');
  await page.locator('.native-message').getByRole('button', { name: t('Remove record', '移除记录'), exact: true }).click();
  await row('Project 2').waitFor({ state: 'detached' });
  for (const number of [1, 2]) assert.ok(await index.locator(':scope > .lp-index-row').getByText(botName(number), { exact: true }).isVisible());
  for (const number of [1, 2, 3]) {
    await row(botName(number)).click({ button: 'right' });
    await choose('Remove folder Bot…', '移除分身…');
    await row(botName(number)).waitFor({ state: 'detached' });
  }
  assert.equal(await index.locator('.lp-index-toggle').count(), 0);
  await libraryTab.click();
}

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
  const settingsLabel=t('Settings','设置'), settingsButton=header.getByRole('button',{name:settingsLabel,exact:true});
  page.setDefaultTimeout(6000);
  await cards.first().waitFor();
  assert.equal(await tab('library').getAttribute('aria-selected'), 'true');
  assert.deepEqual(await header.locator('.lp-utilities > button').evaluateAll(buttons=>buttons.map(button=>button.getAttribute('aria-label'))), [
    t('Studio notifications','Studio 通知'), settingsLabel, t('Studio account','Studio 账号'),
  ]);
  assert.equal(await settingsButton.getAttribute('title'),settingsLabel);
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
  const productAction=detail.getByRole('region',{name:t('IM integration','IM 集成'),exact:true}).getByRole('button',{name:t('Fixture action','示例操作'),exact:true});
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
  if (enhanced) await productAction.waitFor();
  assert.deepEqual(await detail.locator('.lp-detail-actions > button').allTextContents(), [t('Run project','运行项目'),t('Switch to window','切换到项目窗口'),'']);
  await checkDetailActionLayout(page, detail, async width => {
    if (width === 1440) await screenshot('project-details');
  });
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
  await page.evaluate(()=>{
    window.selectedPaths=['/projects/Imported folder'];window.delayHistory=true;
    if (window.enhanced) window.folderDetailImGate=new Promise(resolve=>window.resumeFolderDetailIm=resolve);
  }); await importProject.click();
  await page.waitForFunction(()=>typeof window.resumeHistory==='function'); await page.evaluate(()=>window.resumeHistory());
  await detail.getByRole('heading',{name:'Imported folder',exact:true}).waitFor(); assert.equal(await find.inputValue(),'');
  if (enhanced) {
    const withBot = detail.getByRole('region',{name:t('Bot instances','Bot 分身'),exact:true}).getByRole('button',{name:t('Open with Bot…','用 Bot 打开…'),exact:true});
    await page.waitForFunction(()=>window.actions.some(([id,project])=>id==='studio.listLibraryProjectActions' && project.name==='Imported folder'));
    await withBot.waitFor(); // The account action has not resolved.
    await withBot.focus();
    await page.evaluate(()=>{window.holdFolderActions=true;window.updateAccount({scopeKey:'b'.repeat(64)});});
    await page.waitForFunction(()=>typeof window.resumeFolderActions==='function');
    assert.ok(await withBot.isVisible());
    assert.equal(await withBot.evaluate(button=>document.activeElement===button),true);
    await page.evaluate(()=>{
      window.holdFolderActions=false;window.resumeFolderActions();window.resumeFolderDetailIm();
      window.updateAccount({scopeKey:'a'.repeat(64)});
    });
  }
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
    const latest = home.locator('.lp-latest-notice');
    await latest.getByText('Team: Review the plan').waitFor();
    assert.equal(await home.locator('.lp-chat-launch').count(), 0);
    await page.evaluate(()=>window.imError='offline'); await latest.click();
    const warning=page.locator('.native-message'); await warning.getByText(/offline/).waitFor(); await warning.getByRole('button').click();
    assert.equal(await page.locator('.part.editor').isVisible(),false); assert.equal(page.context().pages().length,1);
    await page.evaluate(()=>{window.imError='';window.socialFailure='unsupported';window.socialGate=new Promise(resolve=>window.resumeSocial=resolve);});
    await tab('profile').click(); const profile=home.locator('#lp-page-profile');
    await profile.getByRole('tab',{name:t('Recent chats','最近会话'),exact:true}).click();
    const team=profile.locator('.lp-profile-entry').filter({hasText:'Team'});
    await team.locator('.lp-avatar img').evaluate(img=>img.decode());
    assert.equal(await team.locator('button').count(), 0);
    assert.equal(await team.locator('.lp-conversation-meta time').count(), 1);
    await team.click({button:'right'});
    await choose('Remove star','取消星标');
    assert.deepEqual(await page.evaluate(() => window.actions.findLast(([id]) => id === 'studio.changeLaunchpadConversation')?.[1]), { id: 'group-team', setting: 'star', value: false });
    await team.locator('.codicon-star-full').waitFor({state:'detached'});
    await profile.locator('.lp-conversation-meta .lp-social-badge').getByText('Bot').waitFor();
    const opened=page.waitForEvent('popup'); await team.click(); const popup=await opened;
    const frame=popup.frameLocator('iframe').frameLocator('#project-frame'); await frame.getByText('group-team',{exact:true}).waitFor();
    assert.ok(await home.isVisible()); await frame.getByLabel('draft').fill('kept');
    assert.deepEqual(await profile.locator('.lp-profile-identity small').allTextContents(), ['me@example.test']);
    assert.equal(await profile.getByText(t('Server Connected','服务器已连接'),{exact:true}).count(),0);
    await checkProfileSections({page,profile,frame,t,screenshot}); assert.equal(loads(),7);
    assert.equal(await profile.getByRole('button',{name:settingsLabel,exact:true}).count(),0);
    await settingsButton.press('Enter'); await page.locator('.studio-launchpad-settings').waitFor();
    assert.deepEqual(await page.evaluate(()=>window.settingsDestination),{section:'account',target:'user'});
    assert.equal(await home.isVisible(),false); assert.equal(await page.locator('.part.editor').evaluate(el=>el.inert),true);
    await checkLaunchpadBackButton(page); await screenshot('settings-back-button');
    const settings=page.frameLocator('.webview-overlay-content iframe'); await settings.locator('#profile #display-name').getByText('My account').waitFor();
    await page.locator('.studio-launchpad-app-close').click(); await home.waitFor();
    assert.equal(await settingsButton.evaluate(button=>button===document.activeElement),true);
    const closed=popup.waitForEvent('close'); await page.evaluate(()=>{window.guest=true;window.signOut();}); await closed;
    assert.equal(await latest.isVisible(),false);
    assert.equal(await profile.getByText('Saved message').count(),0); await profile.getByRole('button',{name:t('Sign in','登录'),exact:true}).click();
    await tab('library').click();
    await checkFolderBotBranches({ page, language, enhanced, screenshot });
  } else {
    assert.ok(!await home.locator('.lp-latest-notice').isVisible()); await tab('profile').click();
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
      assert.ok(side==='left'?edge.x>=nativeBox.x+nativeBox.width:edge.x+edge.width<=nativeBox.x,`header must clear ${side} window controls at ${width}px`);
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
