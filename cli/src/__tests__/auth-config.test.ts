import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { clearCliAuthConfig, readCliAuthConfig, readCliAuthConfigSync, writeCliAuthConfig } from '../auth-config';
it('shares channels, isolates Servers, writes private files atomically and ignores legacy keys',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'sh-scoped-auth-'));
 const env={STEAMHARNESS_CLI_AUTH_DIR:directory,STEAMHARNESS_SERVICE_CHANNEL:'dev',STEAMHARNESS_SERVER_URL:'https://dev.example.test'};
 try {
  await writeFile(path.join(directory,'workflow-auth.json'),JSON.stringify({serverUrl:'https://dev.example.test',apiKey:'legacy'}));
  expect((await readCliAuthConfig(env)).apiKey).toBe('');
  expect((await readCliAuthConfig({...env,STEAMHARNESS_SERVICE_CHANNEL:'main',STEAMHARNESS_SERVER_URL:'https://main.example.test'})).apiKey).toBe('');
  await writeCliAuthConfig({serverUrl:'https://dev.example.test',apiKey:'dev-key'},env);
  expect((await readCliAuthConfig({...env,STEAMHARNESS_SERVICE_CHANNEL:'main'}, 'https://dev.example.test')).apiKey).toBe('dev-key');
  await writeCliAuthConfig({serverUrl:'https://other.example.test',apiKey:'other-key'},env);
  expect(readCliAuthConfigSync(env,'https://dev.example.test').apiKey).toBe('dev-key');
  expect((await readCliAuthConfig(env,'https://unknown.example.test')).apiKey).toBe('');
  await clearCliAuthConfig(env,'stale-key');expect((await readCliAuthConfig(env)).apiKey).toBe('other-key');
  await clearCliAuthConfig(env);expect((await readCliAuthConfig(env)).apiKey).toBe('');
  expect(JSON.parse(await readFile(path.join(directory,'project.json'),'utf8')).apiKey).toBe('');
  if(process.platform!=='win32') expect((await stat(path.join(directory,'project.json'))).mode & 0o777).toBe(0o600);
 } finally {await rm(directory,{recursive:true,force:true});}
});
