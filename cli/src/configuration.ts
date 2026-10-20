import { createLocalProjectConfigurationStore } from 'steamharness';
import path from 'node:path';
import type { ProjectConfigurationAction } from '@steamharness/project-configuration';

/** JSON RPC used by Studio even while the project page is closed. */
export async function main(argv: string[]): Promise<number> {
  if (argv.length > 1 || argv[0]?.startsWith('-')) throw new Error('Usage: steamharness configuration [project-directory] < request.json');
  try {
  let size=0; const chunks:Buffer[]=[];
  for await (const chunk of process.stdin) { size+=chunk.length; if(size>1024*1024)throw new Error('Configuration request exceeds 1 MiB.'); chunks.push(chunk); }
  const call = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ProjectConfigurationAction;
    const store=await createLocalProjectConfigurationStore(path.resolve(argv[0]??process.cwd()));
    process.stdout.write(JSON.stringify({ok:true,value:await store.dispatch(call)})+'\n'); return 0;
  } catch(error) { process.stdout.write(JSON.stringify({ok:false,error:{message:(error as Error).message,code:(error as {code?:string}).code}})+'\n'); return 1; }
}
