import { t } from './localization';

const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export function dependencyProgressHtml(language: string): string {
  const nonce = globalThis.crypto.randomUUID();
  return `<!doctype html><html lang="${escape(language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'">
<title>${escape(t('Dependency Details'))}</title>
<style nonce="${nonce}">
*,*::before,*::after{box-sizing:border-box}
body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font:var(--vscode-font-size,13px) var(--vscode-font-family,sans-serif)}
main{display:flex;flex-direction:column;gap:12px;height:100dvh;max-width:1120px;margin:auto;padding:clamp(12px,3vw,24px)}
h1,h2,p,pre{margin:0;overflow-wrap:anywhere}h1{font-size:1.25em}h2{font-size:1em}
#directory,#message,#truncated,pre:empty::before{color:var(--vscode-descriptionForeground);white-space:pre-wrap}
#message{max-height:20vh;overflow:auto}
.actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
button,select{font:inherit;padding:4px 8px;min-height:26px;max-width:100%;border:1px solid var(--vscode-contrastBorder,transparent);border-radius:3px}
button{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);cursor:pointer}
button:hover{background:var(--vscode-button-secondaryHoverBackground)}
select{color:var(--vscode-dropdown-foreground);background:var(--vscode-dropdown-background);border-color:var(--vscode-dropdown-border,transparent)}
:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}
#state{font-weight:600}progress{width:min(180px,100%);height:6px;accent-color:var(--vscode-progressBar-background)}
pre{flex:1;min-height:4em;overflow:auto;padding:10px 12px;border:1px solid var(--vscode-panel-border);border-radius:4px;white-space:pre-wrap;user-select:text;
font:var(--vscode-editor-font-size,13px)/1.55 var(--vscode-editor-font-family,monospace)}
pre:empty::before{content:attr(data-empty)}
body,pre,#message{scrollbar-width:thin;scrollbar-color:transparent transparent}
:is(body,pre,#message):hover{scrollbar-color:var(--vscode-scrollbarSlider-background) transparent}
[hidden]{display:none!important}
</style></head><body><main>
<select id="operations" aria-label="${escape(t('Dependency Operations'))}" hidden></select>
<h1 id="title">${escape(t('Dependency Details'))}</h1><p id="directory"></p>
<div class="actions"><span id="state" role="status"></span><progress id="progress" aria-label="${escape(t('Dependencies in progress'))}" hidden></progress>
<button type="button" id="cancel" hidden>${escape(t('Cancel'))}</button><button type="button" id="retry" hidden>${escape(t('Retry Project Setup'))}</button></div>
<p id="message" hidden></p><h2 id="log-title">${escape(t('Installation Log'))}</h2>
<p id="truncated" hidden>${escape(t('Showing the most recent installation output.'))}</p>
<pre id="log" tabindex="0" aria-labelledby="log-title" data-empty="${escape(t('No installation output yet.'))}"></pre>
</main><script nonce="${nonce}">
const host=acquireVsCodeApi(), byId=id=>document.getElementById(id);
const operations=byId('operations'), log=byId('log'), cancel=byId('cancel'), retry=byId('retry');
let id, signature, output='';
const text=(name,value)=>{const node=byId(name);if(node.textContent!==value)node.textContent=value;};
operations.addEventListener('change',()=>host.postMessage({type:'select',id:Number(operations.value)}));
cancel.addEventListener('click',()=>host.postMessage({type:'cancel',id}));
retry.addEventListener('click',()=>host.postMessage({type:'retry',id}));
addEventListener('message',({data})=>{
  if(data?.type!=='dependency-progress')return;
  const switched=id!==data.id, follow=switched||log.scrollHeight-log.scrollTop-log.clientHeight<8;
  id=data.id;
  const nextSignature=JSON.stringify(data.operations);
  if(signature!==nextSignature){
    signature=nextSignature;
    operations.replaceChildren(...data.operations.map(entry=>new Option(entry.title+' / '+entry.directory+' / '+entry.state,String(entry.id))));
  }
  operations.hidden=data.operations.length<2;operations.value=String(id);
  text('title',data.title);text('directory',data.directory);text('state',data.state);text('message',data.message||'');
  byId('message').hidden=!data.message;byId('progress').hidden=!data.active;byId('truncated').hidden=!data.truncated;
  cancel.hidden=!data.canCancel;retry.hidden=!data.canRetry;
  if(switched||output!==data.log){
    if(!switched&&log.firstChild&&data.log.startsWith(output))log.firstChild.appendData(data.log.slice(output.length));
    else log.textContent=data.log;
    output=data.log;
    if(follow)log.scrollTop=log.scrollHeight;
  }
});
host.postMessage({type:'ready'});
</script></body></html>`;
}
