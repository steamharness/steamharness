import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import { randomUUID } from 'node:crypto';
import { access, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createLocalProjectConfigurationStore, type LocalProjectConfigurationOptions } from '../configuration';
/** New aggregate fixture declaration for configuration-only unit tests. */
export async function declareConfigurationFixture(directory:string):Promise<string>{
  const exists=async(name:string)=>access(path.join(directory,name)).then(()=>true,()=>false);
  if(!await exists('package.json')) await writeConfigurationFixtureManifest(directory);
  if(!await exists('index.ts')) await writeFile(path.join(directory,'index.ts'),'export {};');
  if(!await exists('configuration.json')) await writeFile(path.join(directory,'configuration.json'),JSON.stringify({version:1,fields:[]}));
  await mkdir(path.join(directory,'configuration-templates','main'),{recursive:true});
  return directory;
}
export async function writeConfigurationFixtureManifest(directory:string,id:string=randomUUID()){
  await writeProjectFixture(path.join(directory,'package.json'),JSON.stringify({id,name:'configuration-test',type:'module',version: "0.1.0", defaultEntry:'main',entries:[{entryId:'main',type:'workflow',name:'Main',root:'.',entry:'index.ts',configuration:'configuration.json',databases:[]}]}));
}
export async function configurationFixtureStore(directory:string,options:LocalProjectConfigurationOptions={}){
  await declareConfigurationFixture(directory);
  return createLocalProjectConfigurationStore(directory,options);
}

export async function configurationFixtureId(directory:string):Promise<string>{ return JSON.parse(await readFile(path.join(directory,"steamharness.json"),"utf8")).id; }
