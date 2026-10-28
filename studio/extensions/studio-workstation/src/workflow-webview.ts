export interface ProjectWindowChrome { active: boolean; projectUri?: string; height: number; left: number; right: number; revision: number }

export function projectFrameHtml(url: string, title: string, projectUri: string, theme: 'light' | 'dark', nonce: string, language = 'en', windowChrome?: ProjectWindowChrome, conversationView?: 'new' | 'restore', projectSetup = false): string {
  const address = new URL(url);
  if (address.protocol !== 'http:' && address.protocol !== 'https:') { throw new Error('Invalid SteamHarness Web URL.'); }
  const locale = language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
  address.searchParams.set('projectLocale', locale);
  const escape = (value: string): string => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
  const literal = (value: string | ProjectWindowChrome | undefined): string => (JSON.stringify(value) ?? 'undefined').replace(/</g, '\\u003c');
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${escape(address.origin)}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <style nonce="${nonce}">html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:var(--vscode-editor-background)}iframe{display:block;width:100%;height:100%;border:0}</style></head>
    <body><iframe id="workflow-frame" title="${escape(title)}" allow="clipboard-read; clipboard-write" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-modals"></iframe>
    <script nonce="${nonce}">
      const vscode=acquireVsCodeApi(),frame=document.getElementById('workflow-frame'),origin=${literal(address.origin)};
      let theme=${literal(theme)},windowChrome=${literal(windowChrome)},editCommands=false,contextMenu=false;
      const entryRoutes=new Map(),dropRoutes=new Map();let activeRoute;
      const postHost=(message,frameId)=>frame.contentWindow.postMessage(frameId?{type:'workflow-entry-host',version:1,frameId,message}:message,origin);
      const clearDragRegions=()=>vscode.postMessage({type:'studio-window-drag-regions',version:1,width:1,height:1,regions:[]});
      const entryId=${literal(decodeURIComponent(address.pathname.match(/\/entries\/([^/]+)/)?.[1] ?? ''))};
      const saved=vscode.getState?.(),state={...(saved?.projectUri===${literal(projectUri)}&&saved?.entryId===entryId?saved:{}),projectUri:${literal(projectUri)},entryId};
      let frameUrl=${literal(address.href)};
      ${conversationView ? `
      const validId=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
      const viewId=validId(state.conversationView?.id)?state.conversationView.id:${literal(globalThis.crypto.randomUUID())};
      const previous=state.conversationView?.conversation;
      state.conversationView={id:viewId,conversation:validId(previous?.id)?previous:${conversationView === 'new' ? '{id:viewId,create:true}' : 'undefined'}};
      const address=new URL(frameUrl);address.searchParams.set('projectView',viewId);
      if(state.conversationView.conversation){address.searchParams.set('conversationId',state.conversationView.conversation.id);if(state.conversationView.conversation.create===true)address.searchParams.set('createConversation','1');}
      frameUrl=address.href;` : ''}
      vscode.setState(state);
      addEventListener('vscode-webview-exec-command',event=>{
        const command=typeof event.detail==='string'?event.detail:event.detail?.command;
        if(!editCommands||document.activeElement!==frame&&!contextMenu||!['paste','copy','cut','selectAll','undo','redo'].includes(command))return;
        event.preventDefault();postHost({type:'workflow-host',editCommand:command,...(contextMenu?{restoreFocus:true}:{}),...(command==='paste'&&event.detail?.clipboard?{clipboardData:event.detail.clipboard}:{})},activeRoute);contextMenu=false;
      });
      frame.addEventListener('load',()=>{if(windowChrome?.active)clearDragRegions();editCommands=false;contextMenu=false;activeRoute=undefined;entryRoutes.clear();dropRoutes.clear();vscode.postMessage({type:'workflow-drop-target',version:1});postHost({type:'workflow-host',theme,windowChrome,locale:${literal(locale)},traceVersion:1,clipboardVersion:1,nativePasteVersion:document.documentElement.dataset.vscodeNativeClipboard==='1'?1:0,resourceVersion:1,${projectSetup ? 'projectSetupVersion:1,' : ''}recoveryVersion:1,dropVersion:1,pathPickerVersion:1,pathOpenVersion:1,userSettingsVersion:1,fileIconsVersion:1,entryWindowVersion:1});vscode.postMessage({type:'workflow-frame-ready'});});
      addEventListener('message',event=>{
        if(event.source===frame.contentWindow){
          if(event.origin!==origin)return;
          let message=event.data,route;
          if(message?.type==='workflow-entry-focus'&&message.version===1){activeRoute=entryRoutes.has(message.frameId)?message.frameId:undefined;return;}
          if(message?.type==='workflow-entry-message'&&message.version===1){
            if(typeof message.frameId!=='string'||!(/^[a-f0-9-]{36}$/i).test(message.frameId)||typeof message.entryId!=='string'||!(/^[a-z][a-z0-9_-]{0,63}$/).test(message.entryId)||typeof message.projectId!=='string'||!message.message||message.message.version!==1)return;
            route={frameId:message.frameId,entryId:message.entryId,projectId:message.projectId};
            const previous=entryRoutes.get(route.frameId);
            if(previous&&(previous.entryId!==route.entryId||previous.projectId!==route.projectId)||!previous&&entryRoutes.size>=64)return;
            entryRoutes.set(route.frameId,route);message=message.message;
            if(message.type==='workflow-entry-dispose'){
              entryRoutes.delete(route.frameId);for(const [target,frameId]of dropRoutes)if(frameId===route.frameId)dropRoutes.delete(target);
              if(activeRoute===route.frameId)activeRoute=undefined;
              vscode.postMessage({type:'workflow-entry-message',version:1,...route,message});return;
            }
          }
          ${conversationView ? `
          if(!route&&message?.type==='workflow-navigation'&&message.version===1&&validId(message.id)&&typeof message.create==='boolean'){
            state.conversationView.conversation={id:message.id,create:message.create};vscode.setState(state);
          }` : ''}
          if(!route&&message?.type==='workflow-window-drag'&&message.version===1&&windowChrome?.active===true){
            const {width,height,regions}=message;vscode.postMessage({type:'studio-window-drag-regions',version:1,width,height,regions});
          }
          if(message?.type==='workflow-edit'&&message.version===1){editCommands=true;if(message.command)activeRoute=route?.frameId;}
          if(message?.type==='workflow-edit'&&message.version===1&&message.command==='paste'&&document.activeElement===frame&&document.documentElement.dataset.vscodeNativeClipboard==='1'){
            contextMenu=false;
            frame.dispatchEvent(new Event('vscode-webview-paste',{bubbles:true}));
          }
          if(message?.type==='workflow-contextmenu'&&message.version===1&&editCommands&&document.activeElement===frame){
            const {x,y,editable,selection}=message,rect=frame.getBoundingClientRect();
            if((editable===true||selection===true)&&Number.isFinite(x)&&Number.isFinite(y)&&x>=0&&y>=0&&x<=rect.width&&y<=rect.height){
              frame.setAttribute('data-vscode-context',JSON.stringify({preventDefaultContextMenuItems:editable!==true,studioFrameSelection:selection===true}));
              activeRoute=route?.frameId;contextMenu=true;frame.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:rect.left+x,clientY:rect.top+y}));
            }
          }
          if(message?.type==='workflow-drop-target'&&message.version===1){if(typeof message.target==='string')dropRoutes.set(message.target,route?.frameId);vscode.postMessage(message);}
          else if(['workflow-open-entry','workflow-trace','workflow-account','workflow-clipboard','workflow-resource','workflow-reconnect','workflow-path-picker','workflow-path-open','workflow-user-settings','workflow-file-icons',...(route?['workflow-frame-ready']:[]),...(${projectSetup}?['workflow-project-upload']:[])].includes(message?.type)&&message.version===1)vscode.postMessage(route?{type:'workflow-entry-message',version:1,...route,message}:message);
          return;
        }
        if(event.data?.type==='workflow-entry-host'&&event.data.version===1&&entryRoutes.has(event.data.frameId)&&event.data.message?.type==='workflow-host'){postHost(event.data.message,event.data.frameId);return;}
        if(event.data?.type!=='workflow-host')return;
        if(event.data.theme==='dark'||event.data.theme==='light')theme=event.data.theme;
        if(event.data.windowChrome){windowChrome=event.data.windowChrome;if(!windowChrome.active)clearDragRegions();}
        const frameId=event.data.drop?dropRoutes.get(event.data.drop.target):event.data.editCommand?activeRoute:undefined;
        postHost(event.data,frameId);
      });
      frame.src=frameUrl;
    </script></body></html>`;
}
