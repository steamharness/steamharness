import assert from 'node:assert/strict';

export function storeFixture(zh) {
  const t = (en, cn) => zh ? cn : en;
  const checklist = { id:'checklist', name:t('Release checklist','发布检查清单'), projectType:'workflow', version:'0.1.0',
    summary:t('Turn release tasks into a Markdown checklist.','将发布事项整理成一份可逐项核对的 Markdown 清单。'),
    description:t('Enter one task per line. The workflow groups your tasks into a **Markdown checklist** for the release review.\n\n## Usage\n\n1. Open the workflow entry.\n2. Add the tasks and run the workflow.\n3. Review the output before publishing.',
      '每行输入一项发布事项。工作流会把这些事项整理成一份 **Markdown 检查清单**，供发布前核对。\n\n## 使用方法\n\n1. 打开工作流入口。\n2. 逐行填写本次发布事项并运行。\n3. 在结果中逐项检查，确认后再发布。'),
    entryTypes:['workflow'], projectEntries:[{ name:t('Generate checklist','生成检查清单'), type:'workflow', primary:true }], updatedAt:'2026-11-18T05:00:00Z',
    images:['/store-preview/workflow-result.png','/store-preview/start.png'] };
  const items = [{ id:'notes', name:t('Notes assistant','笔记助手'), projectType:'bot', version:'1.0.0', description:'**Notes**' },
    { id:'board', name:t('Task board','任务看板'), projectType:'kanban', version:'1.1.0', description:'', images:[] }, checklist];
  return { items, recommendations:[checklist, items[1]].map(({id,name,summary})=>({id,name,description:summary})) };
}

export async function checkStoreExperience({ page, t, enhanced, screenshot }) {
  const store = page.locator('#lp-page-store'), tab = page.locator('#lp-tab-store'), feature = store.locator('.lp-store-feature');
  const card = id => store.locator(`.lp-store-grid button[data-listing="${id}"]`);
  const details = store.locator('article'), query = store.getByRole('searchbox');
  const acquireLabel = enhanced ? t('Get agent','获取 Agent') : t('Create from example','从示例创建');
  const acquire = details.getByRole('button',{name:acquireLabel,exact:true});
  const back = details.getByRole('button',{name:enhanced?t('Back to Store','返回商店'):t('Back to catalog','返回目录')});
  const acquisitionCalls = () => page.evaluate(()=>window.actions.filter(([id])=>['studio.getStoreListing','studio.createExample','studio.openLogin'].includes(id)));
  await tab.click(); await card('notes').waitFor();
  assert.equal(await store.getByRole('button',{name:acquireLabel,exact:true}).count(),0);
  await feature.getByRole('button',{name:t('Next item','下一个')}).click(); await feature.getByRole('heading',{name:t('Task board','任务看板')}).waitFor();
  await feature.getByRole('button',{name:t('Previous item','上一个')}).click();
  await feature.locator('.lp-artwork').click();
  assert.equal(await query.isVisible(),false); assert.equal(await store.locator('.lp-store-grid').isVisible(),false);
  const title = details.getByRole('heading',{level:1, name:enhanced?t('Release checklist','发布检查清单'):t('Notes assistant','笔记助手'),exact:true});
  await title.waitFor(); assert.ok(await title.evaluate(el=>el===document.activeElement));
  await details.getByRole('heading',{name:t('About this project','项目介绍')}).waitFor();
  if (enhanced) {
    assert.equal(await card('checklist').count(),0,'featured listing need not be on this catalog page');
    assert.equal(await details.locator('.lp-listing-prose ol li').count(),3);
    await details.getByRole('heading',{name:t('Usage','使用方法')}).waitFor();
    await details.getByText(t('Default','默认入口'),{exact:true}).waitFor();
    await details.getByText('0.1.0',{exact:true}).waitFor();
    await details.locator('.lp-listing-frame img').evaluate(img=>img.decode()); await screenshot('store-details');
    await details.getByRole('button',{name:t('Next screenshot','下一张截图')}).click(); await details.getByText('2 / 2',{exact:true}).waitFor();
    await details.getByRole('button',{name:t('Previous screenshot','上一张截图')}).click(); await details.getByText('1 / 2',{exact:true}).waitFor();
    await page.setViewportSize({width:360,height:640}); await acquire.click({trial:true});
    assert.ok(await details.evaluate(el=>el.scrollWidth===el.clientWidth)); await screenshot('store-details-narrow'); await page.setViewportSize({width:1120,height:680});
  } else {
    assert.equal(await details.getByRole('heading',{name:t('Screenshots','项目截图')}).count(),0);
    assert.equal(await page.evaluate(()=>window.actions.some(([id])=>id==='studio.getStoreListingDetails')),false);
  }
  assert.deepEqual(await acquisitionCalls(),[]); await acquire.click();
  const expected = [[enhanced?'studio.getStoreListing':'studio.createExample', enhanced?'checklist':'notes']];
  assert.deepEqual(await acquisitionCalls(),expected); await back.click();
  const view = feature.getByRole('button',{name:t('View details','查看详情')}); assert.ok(await view.evaluate(el=>el===document.activeElement));
  await store.getByRole('button',{name:t('Next','下一页'),exact:true}).click(); await card('checklist').click(); await back.click();
  assert.match(await store.locator('.lp-pager').textContent(),/2 \/ 2/); assert.ok(await card('checklist').evaluate(el=>el===document.activeElement));
  await store.getByRole('button',{name:t('Kanban','看板'),exact:true}).click(); await query.fill(t('board','看板')); await card('board').focus(); await page.keyboard.press('Enter');
  await details.getByText(t('No description provided.','暂无项目介绍。')).waitFor(); await page.keyboard.press('Escape');
  assert.equal(await query.inputValue(),t('board','看板')); assert.equal(await store.getByRole('button',{name:t('Kanban','看板'),exact:true}).getAttribute('aria-pressed'),'true');
  assert.ok(await card('board').evaluate(el=>el===document.activeElement));
  await query.fill('not found'); await store.getByText(t('No matching items.','没有匹配的内容。')).waitFor(); await query.fill('');
  await store.getByRole('button',{name:t('All items','全部'),exact:true}).click(); await view.waitFor();
  const catalog = store.locator('.lp-store-content').first(); await card('notes').scrollIntoViewIfNeeded();
  const beforeScroll = await catalog.evaluate(el=>el.scrollTop); assert.ok(beforeScroll>0);
  await card('notes').press('Enter'); await back.click(); assert.equal(await catalog.evaluate(el=>el.scrollTop),beforeScroll);
  if (enhanced) {
    await page.evaluate(()=>window.storeFailure=true); await view.click();
    await details.getByText(t('Project details unavailable.','暂时无法读取项目详情。')).waitFor(); assert.ok(await acquire.isDisabled());
    await page.evaluate(()=>window.storeFailure=false); await details.getByRole('button',{name:t('Retry','重试')}).click();
    await details.getByRole('heading',{name:t('About this project','项目介绍')}).waitFor(); await tab.click();
    await page.evaluate(()=>{window.storePending=new Promise(resolve=>window.resumeStore=resolve);}); await view.click();
    await details.getByText(t('Loading project details…','正在加载项目详情…')).waitFor(); assert.ok(await acquire.isDisabled()); await back.click();
    await page.evaluate(()=>{delete window.storePending;}); await card('notes').click(); await details.getByText('Notes',{exact:true}).waitFor();
    await page.evaluate(()=>window.resumeStore()); assert.equal(await details.locator('h1').textContent(),t('Notes assistant','笔记助手')); await back.click();
  }
  assert.deepEqual(await acquisitionCalls(),expected); await screenshot('store');
}
