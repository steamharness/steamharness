import { createLocalProjectConfigurationStore } from 'steamharness';
import path from 'node:path';
import {configurationPublication} from './configuration-publication';
import {readCliAuthConfig} from './auth-config';
import type { ProjectConfigurationAction } from '@steamharness/project-configuration';

/** JSON RPC used by Studio even while the project page is closed. */
export async function main(argv: string[]): Promise<number> {
  if (argv.length > 1 || argv[0]?.startsWith('-')) throw new Error('Usage: steamharness configuration [project-directory] < request.json');
  try {
  let size=0; const chunks:Buffer[]=[];
  for await (const chunk of process.stdin) { size+=chunk.length; if(size>1024*1024)throw new Error('Configuration request exceeds 1 MiB.'); chunks.push(chunk); }
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const call = (request.call??request) as ProjectConfigurationAction;
    const store=await createLocalProjectConfigurationStore(path.resolve(argv[0]??process.cwd()));
    const auth=await readCliAuthConfig();
    const serverUrl=process.env.STEAMHARNESS_SERVER_URL||auth.serverUrl,accessToken=process.env.STEAMHARNESS_SERVER_ADMIN_KEY||auth.apiKey;
    const connection=Object.hasOwn(request,'connection')?request.connection??undefined:serverUrl&&accessToken?{serverUrl,accessToken}:undefined;
    if(connection && (typeof connection.serverUrl!=='string'||typeof connection.accessToken!=='string'||!/^https?:\/\//.test(connection.serverUrl)))throw new Error('Invalid Server connection.');
    const value=call.action==='get'||call.action.startsWith('publication.')?await configurationPublication(path.resolve(argv[0]??process.cwd()),await store.read(),call,connection):await store.dispatch(call);
    process.stdout.write(JSON.stringify({ok:true,value})+'\n'); return 0;
  } catch(error) { process.stdout.write(JSON.stringify({ok:false,error:{message:(error as Error).message,code:(error as {code?:string}).code}})+'\n'); return 1; }
}
