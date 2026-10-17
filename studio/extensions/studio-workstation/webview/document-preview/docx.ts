import { parseAsync, renderDocument } from 'docx-preview';
import DOMPurify from 'dompurify';
import { element, type PreviewRenderer } from './view';
import { prepareDocxPageFields, resolveDocxPageFields, type DocxDocument } from './docx-fields';

const render: PreviewRenderer = async (bytes, context, signal, name) => {
  const body = element('div'), styles = element('div');
  const options = { renderAltChunks: false, useBase64URL: true, renderComments: false, ignoreLastRenderedPageBreak: false };
  const wordDocument = await parseAsync(bytes, options) as DocxDocument;
  const fields = await prepareDocxPageFields(wordDocument); signal.throwIfAborted();
  for (const node of await renderDocument(wordDocument, options)) { (node.nodeName === 'STYLE' ? styles : body).append(node); }
  resolveDocxPageFields(body, fields);
  signal.throwIfAborted();
  const content = DOMPurify.sanitize(body.innerHTML, { FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input'], FORBID_ATTR: ['target'] });
  const css = Array.from(styles.querySelectorAll('style')).map(style => style.textContent ?? '').join('\n').replace(/<\/style/gi, '');
  const frame = element('iframe', 'preview-frame'); frame.title = name; frame.setAttribute('sandbox', 'allow-scripts');
  const nonce = document.querySelector<HTMLScriptElement>('script[type="module"]')!.nonce;
  const background = getComputedStyle(document.body).backgroundColor;
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; font-src data: blob:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <style>html{background:${background};scrollbar-color:transparent transparent}html:hover{scrollbar-color:#79797980 transparent}body{margin:0;user-select:text}a{pointer-events:none}.docx-wrapper{background:transparent;padding:16px}::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-thumb{background:transparent}html:hover::-webkit-scrollbar-thumb{background:#79797980}</style>
    <style>${css}</style></head><body>${content}<script nonce="${nonce}">
    const nonce=document.currentScript.nonce;let restoring=true;
    addEventListener('message',async event=>{if(event.source!==parent||event.data?.nonce!==nonce||event.data.type!=='restore')return;
      await document.fonts.ready;scrollTo({top:event.data.top,left:event.data.left});restoring=false;});
    addEventListener('scroll',()=>{if(!restoring)parent.postMessage({nonce,type:'scroll',top:scrollY,left:scrollX},'*');});
    </script></body></html>`;
  const receive = (event: MessageEvent): void => {
    if (event.source !== frame.contentWindow || event.data?.nonce !== nonce || event.data.type !== 'scroll') { return; }
    const { top, left } = event.data;
    if (Number.isFinite(top) && top >= 0 && Number.isFinite(left) && left >= 0) { context.state.top = top; context.state.left = left; context.save(); }
  };
  frame.addEventListener('load', () => frame.contentWindow?.postMessage({ nonce, type: 'restore', top: context.state.top, left: context.state.left }, '*'));
  window.addEventListener('message', receive);
  return { element: frame, dispose: () => { window.removeEventListener('message', receive); frame.remove(); } };
};
export default render;
