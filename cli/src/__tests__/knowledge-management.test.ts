import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { manageKnowledgeBases } from '../knowledge-management';
vi.mock('../auth-config', () => ({readCliAuthConfig:async()=>({serverUrl:'https://knowledge.test',apiKey:'account-token'})}));
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
const id='71b86ea0-5632-4ce3-853b-acce3c3d4375';
it('uses account-authenticated knowledge resource routes without retrying mutations',async()=>{
  vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
  const request=vi.fn().mockResolvedValue(Response.json({errCode:0,data:{id}}));vi.stubGlobal('fetch',request);
  expect(await manageKnowledgeBases(['create','Docs','--request-id',id])).toBe(0);
  expect(request.mock.calls[0][0]).toBe('https://knowledge.test/api/knowledge-bases');
  expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({name:'Docs',requestId:id});
  expect(request.mock.calls[0][1].headers.Authorization).toBe('Bearer account-token');
  request.mockImplementation(async()=>{throw new Error('Connection lost');});
  await expect(manageKnowledgeBases(['grant',id,'--user','reader','--mode','read'])).rejects.toThrow('Connection lost');
  expect(request).toHaveBeenCalledTimes(2);
  await expect(manageKnowledgeBases(['list','--invalid'])).rejects.toThrow('Unknown');
});
it('writes only the independent knowledge alias mapping after the Server accepts a binding',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'knowledge-bind-'));
  try {
    await writeFile(path.join(root,'index.ts'),'export {};');
    await writeFile(path.join(root,'steamharness.json'),JSON.stringify({id,name:'Test',version:'0.1.0',defaultEntry:'main',entries:[{entryId:'main',name:'Main',type:'workflow',root:'.',entry:'index.ts',databases:[],knowledgeBases:['docs']}]}));
    vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
    const request=vi.fn().mockImplementation(async()=>Response.json({errCode:0,data:{id}}));vi.stubGlobal('fetch',request);
    await manageKnowledgeBases(['bind',root,'--knowledge-base',id,'--alias','docs']);
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({projectId:id,entryId:'main',alias:'docs',knowledgeBaseId:id});
    const config=JSON.parse(await readFile(path.join(root,'config.json'),'utf8'));
    expect(config.knowledgeBases).toEqual({docs:id});expect(config.databases??{}).toEqual({});
    request.mockImplementation(async()=>Response.json({errCode:403,errMessage:'Grant revoked'},{status:403}));
    await expect(manageKnowledgeBases(['bind',root,'--knowledge-base','71b86ea0-5632-4ce3-853b-acce3c3d4376','--alias','docs'])).rejects.toThrow('Grant revoked');
    expect(JSON.parse(await readFile(path.join(root,'config.json'),'utf8'))).toEqual(config);
  }finally{await rm(root,{recursive:true,force:true});}
});
