import { t } from './localization';
import { localizationHtml } from './localization-host';
import { webviewContextMenu } from './webview-context-menu';
import * as vscode from 'vscode';
import { projectWindowKey, type Project } from './workflow-types';
import type { Launcher } from './workflow-cli-types';
import type { AccountController } from './workflow-auth';
import type { ResourceKind, ResourceRequest, ResourceSource } from './workflow-resources-types';
import type { HostDatabaseCatalog } from './workflow-databases-types';
interface Selection { key:string; project:Project; alias:string; databaseId:string; identity:string; source?:ResourceSource }
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
  private catalog?:HostDatabaseCatalog;
  private catalogController=new AbortController();
  private catalogEpoch=0;
  private catalogTimer?:ReturnType<typeof setTimeout>;
  private referenceKey='';
  private disposed=false;
  constructor(private readonly context:vscode.ExtensionContext,private readonly launcher:Launcher,
    private readonly account:AccountController,private readonly output:vscode.OutputChannel,
    register=true,subscriptions:vscode.Disposable[]=context.subscriptions){
    this.connectionKey=JSON.stringify(account.getConnection());
    subscriptions.push(this,...(register?(['kv','knowledge'] as const).map(kind=>vscode.window.registerWebviewViewProvider(`studio.${kind}`,{resolveWebviewView:view=>this.resolve(kind,view)},{webviewOptions:{retainContextWhenHidden:true}})):[]),
      ...(register?[vscode.commands.registerCommand('studio.refreshResources',()=>{this.reset();this.scheduleCatalog();})]:[]),
      account.onDidChange(()=>{const key=JSON.stringify(account.getConnection());if(key!==this.connectionKey){this.connectionKey=key;
        ++this.catalogEpoch;this.catalogController.abort();this.catalogController=new AbortController();this.catalog=undefined;
        for(const selection of this.selections)selection.source=undefined;
        this.reset();this.scheduleCatalog();}}));
  }
  update(projects:Project[],preferred?:Project):void{
    const references=projects.filter(project=>!project.assistant).flatMap(project=>project.databases.map(database=>({key:database.databaseId,project,alias:database.alias,databaseId:database.databaseId,
      identity:JSON.stringify([projectWindowKey(project),project.id,project.folderPath,database.alias,database.databaseId])})));
    const previous=new Map(this.selections.map(selection=>[selection.key,selection]));
    this.selections=[...new Set(references.map(item=>item.key))].map(key=>{
      const consumers=references.filter(item=>item.key===key),old=previous.get(key);
      const current=consumers.find(item=>item.identity===old?.identity)??consumers.find(item=>projectWindowKey(item.project)=== (preferred&&projectWindowKey(preferred)))??consumers[0];
      return {...current,source:current.identity===old?.identity?old?.source:undefined};
    });
    const preferredKey=preferred&&projectWindowKey(preferred);
    const changedPreferred=preferredKey!==this.preferredKey;this.preferredKey=preferredKey;
    const preferredIds=new Set(preferred?.databases.map(database=>database.databaseId));
    const retained=this.selections.find(item=>item.key===this.selected?.key);
    const selected=(changedPreferred?(retained&&preferredIds.has(retained.databaseId)?retained:this.selections.find(item=>preferredIds.has(item.databaseId))):retained)??this.selections[0];
    const changed=selected?.identity!==this.selected?.identity;this.selected=selected;
    void vscode.commands.executeCommand('setContext','studio.projectResourcesAvailable',!!selected);
    if(changed)this.reset();else this.publish();
    const referenceKey=JSON.stringify(references.map(item=>item.identity));
    if(referenceKey!==this.referenceKey){this.referenceKey=referenceKey;this.scheduleCatalog();}
  }
  private scheduleCatalog():void{
    clearTimeout(this.catalogTimer);
    if(!this.disposed&&this.views.size&&this.launcher.database)this.catalogTimer=setTimeout(()=>void this.refreshCatalog(),100);
  }
  async refreshCatalog():Promise<void>{
    clearTimeout(this.catalogTimer);
    if(this.disposed||!this.launcher.database||!vscode.workspace.isTrusted)return;
    const epoch=++this.catalogEpoch,signal=this.catalogController.signal;
    try{const catalog=await this.launcher.database({kind:'host',action:'catalog'},signal);
      if(!this.disposed&&!signal.aborted&&epoch===this.catalogEpoch){this.catalog=catalog;this.publish();}
    }catch(error){if(!signal.aborted&&epoch===this.catalogEpoch)this.output.appendLine(`Database catalog: ${error instanceof Error?error.message:String(error)}`);}
  }
  private databaseName(selection:Selection):string{
    const catalogs=[this.catalog?.local,this.catalog?.server].filter(catalog=>!!catalog);
    const authorized=catalogs.find(catalog=>catalog.bindings.some(binding=>binding.spaceId===selection.databaseId&&binding.projectId===selection.project.id&&binding.entryId===selection.project.entryId&&catalog.grants.some(grant=>grant.grantId===binding.grantId&&!grant.revokedAt)));
    const spaces=(authorized?[authorized]:catalogs).flatMap(catalog=>catalog.spaces);
    return spaces.find(space=>space.spaceId===selection.databaseId&&(!selection.source||space.host===selection.source))?.name??selection.databaseId;
  }
  private reset():void{this.controller.abort();this.controller=new AbortController();this.busy.clear();++this.generation;this.publish();}
  private publish(forceKind?:ResourceKind):void{
    for(const[kind,view]of this.views){
      view.description=this.selected&&this.databaseName(this.selected);
      const state={type:'resources-state',kind,generation:this.generation,selected:this.selected?.key,
        databases:this.selections.map(item=>({key:item.key,databaseId:item.databaseId,name:this.databaseName(item)})),source:this.selected?.source,
        authenticated:!!this.account.getConnection(),readOnly:false};
      const signature=JSON.stringify(state);if(kind!==forceKind&&signature===this.published.get(kind))continue;
      this.published.set(kind,signature);void view.webview.postMessage(state);
    }
  }
  resolve(kind:ResourceKind,view:vscode.WebviewView):void{
    this.views.set(kind,view);this.published.delete(kind);
    view.webview.options={enableScripts:true,localResourceRoots:[vscode.Uri.joinPath(this.context.extensionUri,'dist')]};view.webview.html=this.html(kind,view);
    const listener=view.webview.onDidReceiveMessage(message=>void this.receive(kind,view,message));
    const visibility=view.onDidChangeVisibility(()=>{if(view.visible){this.publish(kind);this.scheduleCatalog();}});
    const disposal=view.onDidDispose(()=>{listener.dispose();visibility.dispose();disposal.dispose();if(this.views.get(kind)===view){this.views.delete(kind);this.published.delete(kind);}});this.publish();this.scheduleCatalog();
  }
  private async receive(kind:ResourceKind,view:vscode.WebviewView,message:{type?:string;id?:number;generation?:number;databaseKey?:string;input?:ResourceRequest;text?:string}):Promise<void>{
    if(message.type==='ready'){this.publish(kind);this.scheduleCatalog();return;}if(message.type==='login'){this.account.open();return;}
    if(message.type==='refresh'){this.scheduleCatalog();return;}
    if(message.type==='select'){const selected=this.selections.find(item=>item.key===message.databaseKey);if(selected&&selected.key!==this.selected?.key){this.selected=selected;this.reset();}return;}
    if(message.type==='copy'){if(message.generation===this.generation&&message.databaseKey===this.selected?.key&&typeof message.text==='string')await vscode.env.clipboard.writeText(message.text);return;}
    const selected=this.selected,input=message.input;
    if(message.type!=='request'||!Number.isSafeInteger(message.id)||!input||!selected||message.generation!==this.generation||message.databaseKey!==selected.key)return;
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
      const value=await this.launcher.resource(selected.project,{...input,source:selected.source,kind,database:selected.alias,expectedDatabaseId:selected.databaseId},signal);
      if(generation===this.generation){
        if(value&&typeof value==='object'&&'source'in value&&(value.source==='local'||value.source==='server')){this.selected!.source=value.source;this.publish();}
        await view.webview.postMessage({type:'resources-result',id:message.id,generation,value});
      }
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

  dispose():void{this.disposed=true;++this.generation;++this.catalogEpoch;clearTimeout(this.catalogTimer);this.catalogController.abort();this.controller.abort();this.views.clear();this.published.clear();}
}
