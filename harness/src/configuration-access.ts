import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {isProjectRole} from '@steamharness/project-access';
import type {ConfigurationAccess} from '@steamharness/project-configuration';
import {currentPlatformConnections,type PlatformConnection} from './platform-connections';

export type ConfigurationConnection = PlatformConnection;
const refreshes=new Map<string,Promise<ConfigurationAccess>>();

/** Requires a Server connection for protected roles. Without it, only the local guest profile is available. */
export async function resolveProjectConfigurationAccess(projectDir:string,connection?:ConfigurationConnection|null,_fresh=false,_options:{cacheDir?:string}={}):Promise<ConfigurationAccess> {
  const fallback:ConfigurationAccess={subject:'local:guest',role:'guest',online:false};
  connection=connection===undefined?currentPlatformConnections()?.project:connection;
  if(!connection)return fallback;
  const manifest=JSON.parse(await readFile(path.join(projectDir,'steamharness.json'),'utf8')) as {id?:string};
  if(!manifest.id)return fallback;
  const origin=connection.serverUrl.replace(/\/+$/,'');
  const key=createHash('sha256').update(JSON.stringify([origin,connection.accessToken,manifest.id])).digest('hex');
  const pending=refreshes.get(key);
  if(pending)return pending;
  const refresh=refreshAccess();
  refreshes.set(key,refresh);
  try{return await refresh;}finally{if(refreshes.get(key)===refresh)refreshes.delete(key);}
  async function refreshAccess(){
  try{
    const get=async(route:string)=>{
      // Concurrent agents share an in-flight check, never a stale grant. Retry
      // transient reads inside the original deadline; explicit denials fail now.
      const deadline=Date.now()+30_000;
      for(let attempt=0;;attempt++){
        let denied=false;
        try{
          const response=await fetch(origin+route,{headers:{Authorization:'Bearer '+connection!.accessToken},redirect:'error',signal:AbortSignal.timeout(Math.max(1,deadline-Date.now()))});
          if(!response.ok){
            denied=![408,429].includes(response.status)&&response.status<500;
            await response.body?.cancel();
            throw new Error('Project role unavailable.');
          }
          const result=await response.json() as {errCode:number;data:any};
          if(result.errCode!==0){denied=true;throw new Error('Project role unavailable.');}
          return result.data;
        }catch(error){
          if(denied||attempt>=2||Date.now()>=deadline)throw error;
          await new Promise(resolve=>setTimeout(resolve,Math.min(250*(attempt+1),deadline-Date.now())));
        }
      }
    };
    const [account,project]=await Promise.all([get('/api/auth/me'),get('/api/projects/'+encodeURIComponent(manifest.id!))]);
    const role=project?.access?.effectiveRole;
    const userId=account?.profile?.userId;
    if(!isProjectRole(role)||typeof userId!=='string'||!userId)throw new Error('Project role unavailable.');
    return {subject:JSON.stringify([origin,userId]),role,online:true} satisfies ConfigurationAccess;
  }catch{return fallback;}
  }
}
