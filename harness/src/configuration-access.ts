import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {isProjectRole} from '@steamharness/project-access';
import type {ConfigurationAccess} from '@steamharness/project-configuration';
import {readProjectCliAuthConfigSync} from './auth-config';

export interface ConfigurationConnection {serverUrl:string;accessToken:string}
const cache=new Map<string,{time:number;access:ConfigurationAccess}>();
const refreshes=new Map<string,Promise<ConfigurationAccess>>();

/** Only Server responses grant an elevated project role. Failures never reuse an elevated role. */
export async function resolveProjectConfigurationAccess(projectDir:string,connection?:ConfigurationConnection|null,fresh=false,options:{cacheDir?:string}={}):Promise<ConfigurationAccess> {
  const manifest=JSON.parse(await readFile(path.join(projectDir,'steamharness.json'),'utf8')) as {id?:string};
  if(connection===undefined){
    const saved=readProjectCliAuthConfigSync();
    const serverUrl=process.env.STEAMHARNESS_SERVER_URL??saved.serverUrl;
    const accessToken=process.env.STEAMHARNESS_SERVER_ADMIN_KEY??saved.apiKey;
    connection=serverUrl&&accessToken?{serverUrl,accessToken}:null;
  }
  const origin=connection?.serverUrl.replace(/\/+$/,'')??'local';
  if(!connection||!manifest.id)return {subject:origin+':guest',role:'guest',online:false};
  const key=createHash('sha256').update(JSON.stringify([origin,connection.accessToken,manifest.id])).digest('hex');
  const filename=path.join(options.cacheDir??path.join(os.homedir(),'.steamharness','configuration-access'),`${key}.json`);
  let previous=cache.get(key);
  if(!previous){
    try{
      const saved=JSON.parse(await readFile(filename,'utf8')) as {time:number;access:ConfigurationAccess};
      if(Number.isSafeInteger(saved.time)&&saved.time<=Date.now()&&typeof saved.access?.subject==='string'&&isProjectRole(saved.access.role)&&typeof saved.access.online==='boolean')previous=saved;
    }catch{/* Missing or incomplete metadata grants no role. */}
  }
  if(!fresh&&previous&&Date.now()-previous.time<10_000)return previous.access;
  const fallback:ConfigurationAccess={subject:previous?.access.subject??origin+':guest',role:'guest',online:false};
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
    const access:ConfigurationAccess={subject:JSON.stringify([origin,userId]),role,online:true};
    await remember(access);return access;
  }catch{
    await remember(fallback);return fallback;
  }
  }
  async function remember(access:ConfigurationAccess){
    const value={time:Date.now(),access};cache.set(key,value);
    // Workers share verified identity metadata, never credentials. Privileged operations always refresh online.
    const temporary=`${filename}.${randomUUID()}.tmp`;
    try{
      await mkdir(path.dirname(filename),{recursive:true,mode:0o700});
      await writeFile(temporary,JSON.stringify(value),{mode:0o600,flag:'wx'});await rename(temporary,filename);
    }catch{/* A read-only cache must not affect online authorization. */}
    finally{await rm(temporary,{force:true}).catch(()=>undefined);}
  }
}
