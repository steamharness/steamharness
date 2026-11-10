import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { installProjectCopyBridge, type KanbanConversationViewTarget } from '@steamharness/kanban-project';

export interface ConversationView {
  html: string;
  request(message: Record<string, any>): Promise<Record<string, any>[]>;
  close(): void;
}
export type OpenConversationView = (source: { projectId: string; entryId: string; clientId: string; userId?: string },
  target: KanbanConversationViewTarget & { viewId: string }, emit: (messages: Record<string, any>[]) => void) => Promise<ConversationView>;

/** The same authenticated page/view keeps its writer identity through SSE recovery. */
export function conversationViewClientId(entryId: string, parentClientId: string, viewId: string): string {
  const hash = createHash('sha256').update(JSON.stringify([entryId, parentClientId, viewId])).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

// Only conversation controls cross the sandbox. Project configuration, account,
// resource and arbitrary entry operations keep their existing host boundaries.
const actions = new Set(['ready', 'navigate', 'resolve', 'send', 'stop', 'resume', 'tool-policy', 'agent-command',
  'command', 'retry', 'project-server-check', 'project-skills', 'project-mention-files', 'view-ui', 'queue-edit', 'queue-remove', 'queue-promote', 'queue-cancel-edit', 'queue-run', 'queue-reorder', 'trace', 'logs', 'usage']);
const passive = new Set(['trace-active', 'drop-target', 'file-icons', 'aggregate-ready', 'project-configurations-ready']);
export function scopeConversationViewMessage(message: Record<string, any>, conversationId: string, projectUri: string, clientId: string): Record<string, any> {
  if (!message || typeof message !== 'object' || !actions.has(message.type) && !passive.has(message.type)) throw new Error('This action is unavailable in an embedded conversation.');
  if (message.projectUri !== undefined && message.projectUri !== projectUri || message.sessionId !== undefined && message.sessionId !== conversationId) throw new Error('The conversation view target changed.');
  if (message.type === 'agent-command' && (message.command?.type !== 'cancel' || !['foreground', 'all'].includes(message.command.scope))) throw new Error('A conversation view can only stop its own agent.');
  if (message.type === 'navigate' && (message.id !== conversationId || !Array.isArray(message.updates) || message.updates.some((update: any) => update?.id !== conversationId || update.create))) throw new Error('A conversation view cannot navigate to another session.');
  return { ...message, clientId, projectUri, sessionId: conversationId };
}
export const passiveConversationViewMessage = (type: string) => passive.has(type);

const assetCache = new Map<string, Promise<{ js: string; css: string }>>();
export async function conversationViewHtml(assets: string, viewId: string, conversationId: string, language: string, textOnly = false): Promise<string> {
  let pending = assetCache.get(assets);
  if (!pending) {
    pending = (async () => {
      const [js, style, theme, icons, font] = await Promise.all(['workflow-ui.js', 'workflow-ui.css', 'theme.css', 'codicons/codicon.css', 'codicons/codicon.ttf'].map(file => readFile(path.join(assets, file))));
      return { js: js!.toString().replace(/<\/script/gi, '<\\/script'), css: `${icons!.toString().replace(/url\([^)]*codicon\.ttf[^)]*\)/g, `url(data:font/ttf;base64,${font!.toString('base64')})`)}\n${style}\n${theme}`.replace(/<\/style/gi, '<\\/style') };
    })();
    assetCache.set(assets, pending);
    pending.catch(() => assetCache.delete(assets));
  }
  const { js, css } = await pending;
  const json = (value: string) => JSON.stringify(value).replace(/</g, '\\u003c');
  const attribute = (value: string) => value.replace(/[&"<>]/g, char => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[char]!);
  return `<!doctype html><html lang="${attribute(language)}" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="steamharness-conversation-view" content="${attribute(conversationId)}"><meta name="steamharness-conversation-text-only" content="${textOnly}"><style>${css}\n#app>.toolbar,#project-menu,.aggregate-toolbar{display:none!important}#app{grid-template-rows:minmax(0,1fr)!important;grid-template-areas:'main'!important;grid-template-columns:minmax(0,1fr)!important}main{grid-row:1!important;grid-column:1/-1!important}html,body,#app{height:100%;min-height:0}#app{--toolbar-height:0px}</style></head><body data-surface="editor" data-account-host="true"><div id="app"></div><script nonce="__STEAMHARNESS_KANBAN_NONCE__">
(()=>{const viewId=${json(viewId)};let saved,editHost=false,sequence=0;const copyDocument=Date.now().toString(36)+"-"+Math.random().toString(36).slice(2);const copies=new Map();const postMessage=message=>{
if(message.type==='copy')return new Promise(resolve=>{const requestId='copy-'+copyDocument+'-'+(++sequence);const timer=setTimeout(()=>{copies.delete(requestId);resolve(false);},10000);copies.set(requestId,{resolve,timer});parent.postMessage({type:'steamharness:conversation-request',viewId,message:{type:'copy',requestId,text:String(message.text??'')}},'*');});
parent.postMessage({type:'steamharness:conversation-request',viewId,message},'*');};
const copyBridge=(${installProjectCopyBridge.toString()})(window,{enabled:()=>editHost,writeText:text=>postMessage({type:'copy',text}),contextMenu:value=>postMessage({type:'view-contextmenu',...value})});
Object.defineProperty(globalThis,'acquireVsCodeApi',{value:()=>({postMessage,getState:()=>saved,setState:value=>{saved=value;}})});
addEventListener('message',event=>{if(event.source!==parent||event.data?.viewId!==viewId||event.data.type!=='steamharness:conversation-message')return;const message=event.data.message;
if(message?.type==='conversation-edit-host'){editHost=message.enabled===true;return;}
if(message?.type==='conversation-edit'&&['copy','cut','paste','selectAll','undo','redo'].includes(message.command)){copyBridge.command(message.command,message.restoreFocus===true,message.clipboardData);return;}
if(message?.type==='conversation-copy-result'){const pending=copies.get(message.requestId);if(pending){copies.delete(message.requestId);clearTimeout(pending.timer);pending.resolve(message.ok===true);if(!message.ok)dispatchEvent(new MessageEvent('message',{data:{type:'error',requestType:'copy',message:${json(language === 'zh-CN' ? '复制失败，请重试。' : 'Copy failed. Try again.')}}}));}return;}
if(message?.type==='conversation-theme'){document.documentElement.dataset.theme=message.theme;return;}if(message?.type==='preview'){const dialog=document.createElement('dialog');dialog.className='conversation-dialog';const header=document.createElement('header'),title=document.createElement('h2'),close=document.createElement('button'),body=document.createElement('pre');title.textContent=message.title;close.className='icon-button';close.textContent='×';close.ariaLabel=${json(language === 'zh-CN' ? '关闭' : 'Close')};close.onclick=()=>dialog.close();header.append(title,close);body.className='dialog-body web-preview';body.textContent=typeof message.content==='string'?message.content:JSON.stringify(message.content,null,2);dialog.append(header,body);document.body.append(dialog);dialog.onclose=()=>dialog.remove();dialog.showModal();return;}dispatchEvent(new MessageEvent('message',{data:message}));});
addEventListener('pagehide',()=>{copyBridge.dispose();for(const pending of copies.values()){clearTimeout(pending.timer);pending.resolve(false);}copies.clear();},{once:true});
addEventListener('DOMContentLoaded',()=>postMessage({type:'view-ready'}),{once:true});})();
</script><script nonce="__STEAMHARNESS_KANBAN_NONCE__">${js}</script></body></html>`;
}
