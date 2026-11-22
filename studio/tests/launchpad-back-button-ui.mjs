import assert from 'node:assert/strict';

export async function checkLaunchpadBackButton(page) {
  const button = page.locator('.studio-launchpad-app-close'), icon = button.locator(':scope > .codicon');
  const geometry = await button.evaluate(element => {
    const button = element.getBoundingClientRect(), icon = element.querySelector(':scope > .codicon').getBoundingClientRect();
    const range = document.createRange(); range.selectNodeContents(element.lastChild); const text = range.getBoundingClientRect();
    return { button:button.toJSON(), icon:icon.toJSON(), text:text.toJSON(), display:getComputedStyle(element).display, align:getComputedStyle(element).alignItems };
  });
  assert.equal(geometry.display, 'flex');
  assert.equal(geometry.align, 'center');
  assert.ok(Math.abs(geometry.icon.y + geometry.icon.height / 2 - geometry.text.y - geometry.text.height / 2) <= .5);
  assert.ok(geometry.icon.y >= geometry.button.y && geometry.icon.bottom <= geometry.button.bottom);
}
