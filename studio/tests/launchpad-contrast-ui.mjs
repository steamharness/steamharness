import assert from 'node:assert/strict';

async function contrast(locator) {
  const colors = await locator.evaluate(element => {
    const background = (node) => {
      for (let current = node; current; current = current.parentElement) {
        const color = getComputedStyle(current).backgroundColor, parts = color.match(/[\d.]+/g)?.map(Number) ?? [];
        if ((parts[3] ?? 1) > .9) return color;
      }
      return getComputedStyle(document.querySelector('.monaco-workbench')).backgroundColor;
    };
    return { icon:getComputedStyle(element).color, background:background(element) };
  });
  const parsed = value => value.match(/[\d.]+/g).slice(0, 3).map(Number);
  const luminance = rgb => rgb.map(value => { const channel = value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const a = luminance(parsed(colors.icon)), b = luminance(parsed(colors.background));
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

export async function checkLaunchpadContrast({ page, t, enhanced }) {
  const home = page.locator('.studio-launchpad'), library = home.locator('#lp-page-library');
  const create = library.getByRole('button',{name:t('New project','新建项目'),exact:true}).locator('.codicon-add');
  assert.ok(await contrast(create) >= 3, 'the primary action icon remains legible against its button');
  for (const icon of await home.locator('.lp-titlebar .lp-tool > .codicon').all()) assert.ok(await contrast(icon) >= 3, 'toolbar icons remain legible');
  for (const icon of await home.locator('.lp-search-field > .codicon').all()) assert.ok(await contrast(icon) >= 3, 'search icons remain legible');
  const store = home.locator('#lp-page-store'), storeTab = home.locator('#lp-tab-store');
  await storeTab.click(); await store.locator('.lp-store-grid button').first().waitFor();
  const controls = store.locator('.lp-feature-controls').first();
  for (const icon of await controls.locator('.codicon').all()) assert.ok(await contrast(icon) >= 3, 'Store actions and pagination remain legible');
  if (enhanced) {
    await store.locator('.lp-store-grid button').first().click();
    await store.locator('article .lp-primary .codicon').waitFor();
    assert.ok(await contrast(store.locator('article .lp-primary .codicon')) >= 3, 'the acquire action remains legible');
    for (const icon of await store.locator('article .lp-screen-controls .codicon').all()) assert.ok(await contrast(icon) >= 3, 'screenshot controls remain legible');
  }
  await home.locator('#lp-tab-profile').click();
  for (const icon of await home.locator('.lp-profile-tool > .codicon').all()) assert.ok(await contrast(icon) >= 3, 'profile tools remain legible');
  for (const icon of await home.locator('#lp-page-profile .lp-profile-nav .codicon').all()) assert.ok(await contrast(icon) >= 3, 'profile navigation remains legible');
  await home.locator('#lp-tab-library').click();
}
