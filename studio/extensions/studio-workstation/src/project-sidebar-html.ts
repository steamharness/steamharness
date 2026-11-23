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

export function hostedSidebarHtml(lang: string, title: string, preview: HostedSidebarPreview, route?: string, titlebarOverlay = false): string {
  const nonce = newNonce(), url = new URL(preview.url), origin = url.origin;
  if (route !== undefined) {
    if (!route.startsWith('/') || route.startsWith('//')) throw new Error('Invalid hosted application route');
    url.searchParams.set('studio-language', lang);
    url.hash = route;
  }
  return `<!doctype html><html lang="${escape(lang)}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; frame-src ${escape(origin)}">
<style nonce="${nonce}">html,body{width:100%;height:100%;margin:0;padding:0;overflow:hidden}body.vscode-light,body.vscode-high-contrast-light{color-scheme:light}body.vscode-dark,body.vscode-high-contrast:not(.vscode-high-contrast-light){color-scheme:dark}iframe{display:block;border:0;width:100%;height:100%;background:var(--vscode-sideBar-background)}</style>
<iframe id="project-frame" title="${escape(title)}" sandbox="allow-scripts allow-forms allow-downloads allow-same-origin" allow="${preview.microphone ? 'microphone' : "microphone 'none'"}" referrerpolicy="no-referrer" src="${escape(url.href)}"></iframe>
<script nonce="${nonce}">const host=acquireVsCodeApi(),frame=document.getElementById('project-frame'),origin=${JSON.stringify(origin)},nonce=${JSON.stringify(preview.nonce)};
window.addEventListener('message',event=>{
  if(event.source===frame.contentWindow){
    if(event.origin!==origin||event.data?.nonce!==nonce)return;
    if(event.data.type==='steamharness:web-app-account')host.postMessage({type:'studio-sidebar-account'});
    ${titlebarOverlay ? `if(event.data.type==='steamharness:web-app-titlebar-request')host.postMessage({type:'studio-launchpad-titlebar-request'});
    if(event.data.type==='steamharness:web-app-titlebar-controls'){
      const {width,left,height,controls}=event.data;
      if(width===frame.clientWidth&&Array.isArray(controls)&&controls.length<=32){
        host.postMessage({type:'studio-launchpad-titlebar-controls',width,left,height,controls});
      }
    }` : ''}
    ${route !== undefined ? `
    if(event.data.type==='steamharness:web-app-ready')host.postMessage({type:'studio-launchpad-ready'});
    if(event.data.type==='steamharness:web-app-close')host.postMessage({type:'studio-launchpad-close'});
    if(event.data.type==='steamharness:web-app-open-conversation'){
      const {conversation,user}=event.data;
      if(typeof conversation==='string'&&conversation.length>0&&conversation.length<=256)host.postMessage({type:'studio-launchpad-open-conversation',conversation,...(event.data.closeSource===true?{closeSource:true}:{})});
      else if(typeof user==='string'&&user.length>0&&user.length<=100)host.postMessage({type:'studio-launchpad-open-conversation',user});
    }` : ''}
  }${titlebarOverlay ? `else if(event.origin===window.origin&&event.data?.type==='studio-launchpad-titlebar'){
    const {left,height}=event.data;
    if(Number.isFinite(left)&&left>=0&&left<=1024&&Number.isFinite(height)&&height>=32&&height<=256){
      frame.contentWindow?.postMessage({type:'steamharness:web-app-titlebar',nonce,left,height},origin);
    }
  }` : ''}
});</script></html>`;
}
