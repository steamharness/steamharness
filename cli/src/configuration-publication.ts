import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createPublicationDraft,ProjectConfigurationError,type ProjectConfigurationAction,type ProjectConfigurationState} from '@steamharness/project-configuration';
import { readProjectManifest, selectProjectEntry } from '@steamharness/project-manifest';

/** Personal local values stay local. Only an explicit author draft is sent to Server. */
export async function configurationPublication(projectDir:string,state:ProjectConfigurationState,call:ProjectConfigurationAction,connection:{serverUrl:string;accessToken:string}|undefined,entryId?:string):Promise<ProjectConfigurationState> {
  if(call.action.startsWith('publication.')&&call.revision!==undefined&&call.revision!==state.revision)throw new ProjectConfigurationError('Configuration changed. Refresh before saving your draft.','CONFIGURATION_CONFLICT');
  if(!connection) {
    if(call.action.startsWith('publication.'))throw new Error('Official configuration publication requires an online connection.');
    return state;
  }
  const manifest=JSON.parse(await readFile(path.join(projectDir,'package.json'),'utf8'));
  const entry=selectProjectEntry(readProjectManifest(manifest),entryId);
  const address=`${connection.serverUrl}/api/projects/${encodeURIComponent(manifest.id)}/configurations?entryId=${encodeURIComponent(entry.entryId)}`;
  const request=async(body?:unknown)=>{
    const response=await fetch(body?address:`${address}&target=draft`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${connection.accessToken}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(body?20_000:5_000)});
    const result=await response.json() as {errCode:number;errMessage:string;data:ProjectConfigurationState};
    if(!response.ok||result.errCode!==0)throw Object.assign(new Error(result.errMessage||'Configuration request failed.'),{code:(result.data as ProjectConfigurationState & {code?:string}|undefined)?.code??(response.status===409?'CONFIGURATION_CONFLICT':undefined)});return result.data;
  };
  let remote:ProjectConfigurationState;
  try {remote=await request();} catch(error) {if(call.action==='get')return {...state,canManagePublication:false};throw error;}
  if(call.action.startsWith('publication.')) {
    remote=await request({target:'draft',call:{...call,revision:remote.revision}});
  }
  const publication=remote.canManagePublication && (!remote.publication || !remote.publication.revision) ? createPublicationDraft(state) : remote.publication;
  return {...state,canManagePublication:remote.canManagePublication,publication,...(call.action==='publication.preview'?{publicationPreview:remote.publicationPreview}:{})};
}
