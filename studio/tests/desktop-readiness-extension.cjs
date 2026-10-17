const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');

exports.activate = async context => {
  let state;
  try {
    const studio = vscode.extensions.getExtension('studio.studio-workstation');
    if (!studio) { throw new Error('The Studio extension was not loaded.'); }
    await studio.activate();
    state = { ready: studio.isActive };
  } catch (error) {
    state = { error: error instanceof Error ? error.message : String(error) };
  }
  const file = path.join(context.extensionPath, 'ready.json');
  await fs.writeFile(`${file}.tmp`, JSON.stringify(state));
  await fs.rename(`${file}.tmp`, file);
};
