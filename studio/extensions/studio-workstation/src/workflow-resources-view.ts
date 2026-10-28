import { t } from './localization';
import { localizationHtml } from './localization-host';
import { webviewContextMenu } from './webview-context-menu';
import * as vscode from 'vscode';
import { projectDisplayName, projectWindowKey, type Project } from './workflow-types';
import type { Launcher } from './workflow-cli-types';
import type { AccountController } from './workflow-auth';
import type { ResourceKind, ResourceRequest } from './workflow-resources-types';
interface Selection { key:string; project:Project; alias:string; databaseId:string }
export class ResourceViews implements vscode.Disposable {
  private selections:Selection[]=[];
  private selected?:Selection;
  private preferredKey?:string;
  private generation=0;
  private controller=new AbortController();
  private readonly views=new Map<ResourceKind,vscode.WebviewView>();
  private readonly published=new Map<ResourceKind,string>();
  private readonly busy=new Set<ResourceKind>();
  private connectionKey?:string;
  constructor(private readonly context:vscode.ExtensionContext,private readonly launcher:Launcher,
    private readonly account:AccountController,private readonly output:vscode.OutputChannel,
    register=true,subscriptions:vscode.Disposable[]=context.subscriptions){
    this.connectionKey=JSON.stringify(account.getConnection());
    subscriptions.push(this,...(register?(['kv','knowledge'] as const).map(kind=>vscode.window.registerWebviewViewProvider(`studio.${kind}`,{resolveWebviewView:view=>this.resolve(kind,view)},{webviewOptions:{retainContextWhenHidden:true}})):[]),
      ...(register?[vscode.commands.registerCommand('studio.refreshResources',()=>this.reset())]:[]),
      account.onDidChange(()=>{const key=JSON.stringify(account.getConnection());if(key!==this.connectionKey){this.connectionKey=key;this.reset();}}));
  }
  update(projects:Project[],preferred?:Project):void{
    this.selections=projects.filter(project=>!project.assistant).flatMap(project=>project.databases.map(database=>({key:`${projectWindowKey(project)}:database=${database.alias}`,project,alias:database.alias,databaseId:database.databaseId})));
    const preferredKey=preferred&&projectWindowKey(preferred);
    const changedPreferred=preferredKey!==this.preferredKey;this.preferredKey=preferredKey;
    const selected=(changedPreferred?this.selections.find(item=>projectWindowKey(item.project)===preferredKey):this.selections.find(item=>item.key===this.selected?.key))??this.selections[0];
    const changed=JSON.stringify(selected)!==JSON.stringify(this.selected);this.selected=selected;
    void vscode.commands.executeCommand('setContext','studio.projectResourcesAvailable',!!selected);
    if(changed)this.reset();else this.publish();
  }
  private reset():void{this.controller.abort();this.controller=new AbortController();this.busy.clear();++this.generation;this.publish();}
  private publish(forceKind?:ResourceKind):void{
    for(const[kind,view]of this.views){
      view.description=this.selected&&`${projectDisplayName(this.selected.project)} / ${this.selected.alias}`;
      const state={type:'resources-state',kind,generation:this.generation,selected:this.selected?.key,
        projects:this.selections.map(item=>({uri:item.key,id:item.project.id,entryId:item.project.entryId,name:`${projectDisplayName(item.project)} / ${item.alias}`,folderPath:item.project.folderPath})),
        authenticated:!!this.account.getConnection(),readOnly:false};
      const signature=JSON.stringify(state);if(kind!==forceKind&&signature===this.published.get(kind))continue;
      this.published.set(kind,signature);void view.webview.postMessage(state);
    }
  }
  resolve(kind:ResourceKind,view:vscode.WebviewView):void{
    this.views.set(kind,view);this.published.delete(kind);
    view.webview.options={enableScripts:true,localResourceRoots:[vscode.Uri.joinPath(this.context.extensionUri,'dist')]};view.webview.html=this.html(kind,view);
    const listener=view.webview.onDidReceiveMessage(message=>void this.receive(kind,view,message));
    const visibility=view.onDidChangeVisibility(()=>{if(view.visible)this.publish(kind);});
    const disposal=view.onDidDispose(()=>{listener.dispose();visibility.dispose();disposal.dispose();if(this.views.get(kind)===view){this.views.delete(kind);this.published.delete(kind);}});this.publish();
  }
  private async receive(kind:ResourceKind,view:vscode.WebviewView,message:{type?:string;id?:number;generation?:number;projectUri?:string;input?:ResourceRequest;text?:string}):Promise<void>{
    if(message.type==='ready'){this.publish(kind);return;}if(message.type==='login'){this.account.open();return;}
    if(message.type==='select'){const selected=this.selections.find(item=>item.key===message.projectUri);if(selected&&selected.key!==this.selected?.key){this.selected=selected;this.reset();}return;}
    if(message.type==='copy'){if(message.generation===this.generation&&message.projectUri===this.selected?.key&&typeof message.text==='string')await vscode.env.clipboard.writeText(message.text);return;}
    const selected=this.selected,input=message.input;
    if(message.type!=='request'||!Number.isSafeInteger(message.id)||!input||!selected||message.generation!==this.generation||message.projectUri!==selected.key)return;
    const generation=this.generation,signal=this.controller.signal;
    let mutation=false;
    try{
      if(!vscode.workspace.isTrusted||!this.launcher.resource)throw new Error(t('Trust the current workspace first.'));
      if(!['list','get','save','delete'].includes(input.action)||JSON.stringify(input).length>1024*1024)throw new Error(t('Invalid resource operation.'));
      if(['save','delete'].includes(input.action)){if(this.busy.has(kind))throw new Error(t('A data operation is in progress.'));this.busy.add(kind);mutation=true;}
      if(input.action==='delete'){
        const remove=t('Delete');const result=await vscode.window.showWarningMessage(t('Delete "{0}"?',input.key??input.documentId??''),{modal:true},remove);
        if(result!==remove){await view.webview.postMessage({type:'resources-result',id:message.id,generation,value:{cancelled:true}});return;}
      }
      signal.throwIfAborted();
      const value=await this.launcher.resource(selected.project,{...input,source:undefined,kind,database:selected.alias,expectedDatabaseId:selected.databaseId},signal);
      if(generation===this.generation)await view.webview.postMessage({type:'resources-result',id:message.id,generation,value});
    }catch(error){
      if(generation!==this.generation)return;const detail=error instanceof Error?error.message:String(error);this.output.appendLine(`Database ${kind}: ${detail}`);
      await view.webview.postMessage({type:'resources-result',id:message.id,generation,error:detail});
    }finally{if(mutation&&generation===this.generation)this.busy.delete(kind);}
  }
  private html(kind: ResourceKind, view: vscode.WebviewView): string {
    const webview = view.webview;
    const nonce = globalThis.crypto.randomUUID().replace(/-/g, '');
    const asset = (name: string): string => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', name)).toString();
    return `<!DOCTYPE html><html lang="${vscode.env.language}"><head>${webviewContextMenu(this.context, view)}<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}';">
      <link rel="stylesheet" href="${asset('codicons/codicon.css')}"><link rel="stylesheet" href="${asset('resources-ui.css')}">
      </head><body data-resource-kind="${kind}"><div id="resources-app"></div>${localizationHtml(nonce)}<script nonce="${nonce}" src="${asset('resources-ui.js')}"></script></body></html>`;
  }

  dispose():void{++this.generation;this.controller.abort();this.views.clear();this.published.clear();}
}
