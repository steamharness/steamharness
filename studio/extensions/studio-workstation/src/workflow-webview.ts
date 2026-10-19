export function workflowFrameHtml(url: string, title: string, projectUri: string, theme: 'light' | 'dark', nonce: string, language = 'en'): string {
  const address = new URL(url);
  if (address.protocol !== 'http:' && address.protocol !== 'https:') { throw new Error('Invalid SteamHarness Web URL.'); }
  const locale = language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
  address.searchParams.set('workflowLocale', locale);
  const escape = (value: string): string => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
  const literal = (value: string): string => JSON.stringify(value).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${escape(address.origin)}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <style nonce="${nonce}">html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:var(--vscode-editor-background)}iframe{display:block;width:100%;height:100%;border:0}</style></head>
    <body><iframe id="workflow-frame" title="${escape(title)}" allow="clipboard-read; clipboard-write" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-modals"></iframe>
    <script nonce="${nonce}">
      const vscode=acquireVsCodeApi(),frame=document.getElementById('workflow-frame'),origin=${literal(address.origin)};
      let theme=${literal(theme)},editCommands=false,contextMenu=false;
      vscode.setState({projectUri:${literal(projectUri)}});
      addEventListener('vscode-webview-exec-command',event=>{
        const command=typeof event.detail==='string'?event.detail:event.detail?.command;
        if(!editCommands||document.activeElement!==frame&&!contextMenu||!['paste','copy','cut','selectAll','undo','redo'].includes(command))return;
        event.preventDefault();frame.contentWindow.postMessage({type:'workflow-host',editCommand:command,...(contextMenu?{restoreFocus:true}:{}),...(command==='paste'&&event.detail?.clipboard?{clipboardData:event.detail.clipboard}:{})},origin);contextMenu=false;
      });
      frame.addEventListener('load',()=>{editCommands=false;contextMenu=false;frame.contentWindow.postMessage({type:'workflow-host',theme,locale:${literal(locale)},traceVersion:1,clipboardVersion:1,nativePasteVersion:document.documentElement.dataset.vscodeNativeClipboard==='1'?1:0,resourceVersion:1},origin);vscode.postMessage({type:'workflow-frame-ready'});});
      addEventListener('message',event=>{
        if(event.source===frame.contentWindow){
          if(event.origin===origin&&event.data?.type==='workflow-edit'&&event.data.version===1)editCommands=true;
          if(event.origin===origin&&event.data?.type==='workflow-edit'&&event.data.version===1&&event.data.command==='paste'&&document.activeElement===frame&&document.documentElement.dataset.vscodeNativeClipboard==='1'){
            contextMenu=false;
            frame.dispatchEvent(new Event('vscode-webview-paste',{bubbles:true}));
          }
          if(event.origin===origin&&event.data?.type==='workflow-contextmenu'&&event.data.version===1&&editCommands&&document.activeElement===frame){
            const {x,y}=event.data,rect=frame.getBoundingClientRect();
            if(Number.isFinite(x)&&Number.isFinite(y)&&x>=0&&y>=0&&x<=rect.width&&y<=rect.height){contextMenu=true;frame.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:rect.left+x,clientY:rect.top+y}));}
          }
          if(event.origin===origin&&['workflow-trace','workflow-account','workflow-clipboard','workflow-resource'].includes(event.data?.type)&&event.data.version===1)vscode.postMessage(event.data);
          return;
        }
        if(event.data?.type!=='workflow-host')return;
        if(event.data.theme==='dark'||event.data.theme==='light')theme=event.data.theme;
        frame.contentWindow.postMessage(event.data,origin);
      });
      frame.src=${literal(address.href)};
    </script></body></html>`;
}
