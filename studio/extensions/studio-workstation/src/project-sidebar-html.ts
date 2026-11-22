import type { HostedSidebarPreview } from './project-sidebar-types';

const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const newNonce = () => globalThis.crypto.randomUUID().replaceAll('-', '');

export function sidebarStatusDocument(lang: string, message: string, label?: string): string {
  const nonce = newNonce();
  return `<!doctype html><html lang="${escape(lang)}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
<style nonce="${nonce}">body{margin:0;padding:16px;font:var(--vscode-font-size) var(--vscode-font-family);color:var(--vscode-descriptionForeground)}p{margin:0 0 10px;overflow-wrap:anywhere;white-space:pre-wrap}button{font:inherit;padding:5px 9px;border:1px solid transparent;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}</style>
<p role="status">${escape(message)}</p>${label ? `<button id="action" type="button">${escape(label)}</button><script nonce="${nonce}">const host=acquireVsCodeApi();document.getElementById('action').addEventListener('click',()=>host.postMessage({type:'studio-sidebar-action'}));</script>` : ''}</html>`;
}

export function hostedSidebarHtml(lang: string, title: string, preview: HostedSidebarPreview, resident = false): string {
  const nonce = newNonce(), url = new URL(preview.url), origin = url.origin;
  if (resident) url.searchParams.set('studio-language', lang);
  return `<!doctype html><html lang="${escape(lang)}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; frame-src ${escape(origin)}">
<style nonce="${nonce}">html,body{width:100%;height:100%;margin:0;padding:0;overflow:hidden}body.vscode-light,body.vscode-high-contrast-light{color-scheme:light}body.vscode-dark,body.vscode-high-contrast:not(.vscode-high-contrast-light){color-scheme:dark}iframe{display:block;border:0;width:100%;height:100%;background:var(--vscode-sideBar-background)}</style>
<iframe id="project-frame" title="${escape(title)}" sandbox="allow-scripts allow-forms allow-downloads allow-same-origin" allow="${preview.microphone ? 'microphone' : "microphone 'none'"}" referrerpolicy="no-referrer" src="${escape(resident ? url.href : preview.url)}"></iframe>
<script nonce="${nonce}">const host=acquireVsCodeApi(),frame=document.getElementById('project-frame'),origin=${JSON.stringify(origin)},nonce=${JSON.stringify(preview.nonce)};
window.addEventListener('message',event=>{
  if(event.source===frame.contentWindow){
    if(event.origin!==origin||event.data?.nonce!==nonce)return;
    if(event.data.type==='steamharness:web-app-account')host.postMessage({type:'studio-sidebar-account'});
    ${resident ? `if(event.data.type==='steamharness:web-app-ready')host.postMessage({type:'studio-launchpad-ready'});
    if(event.data.type==='steamharness:web-app-social'&&['people','favorites'].includes(event.data.section))host.postMessage({type:'studio-launchpad-social',section:event.data.section});` : ''}
  }${resident ? `else if(event.origin===window.origin&&event.data?.type==='studio-launchpad-view'&&typeof event.data.visible==='boolean'){
    frame.contentWindow.postMessage({type:'steamharness:web-app-view',nonce,visible:event.data.visible,conversation:event.data.conversation},origin);
  }` : ''}
});</script></html>`;
}
