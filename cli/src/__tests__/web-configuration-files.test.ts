import { afterEach, expect, it, vi } from 'vitest';
import { uploadConfigurationFile } from '../web/configuration-files';
const field={name:'image',type:'file' as const,accept:['image/png']};
const connection={serverUrl:'https://files.test',accessToken:'account-capability'};
const bytes=Buffer.from([0,137,255,10,0]);
const input={name:'底图.png',mimeType:'image/png',data:bytes.toString('base64')};
const reference={id:'wf_ab12',...input,data:undefined,size:bytes.length,kind:'image',storage:'server',projectId:'project'};
afterEach(()=>vi.restoreAllMocks());
it('uploads exact raw bytes to the authenticated project file service, outside conversations',async()=>{
  const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({errCode:0,data:[reference]})));
  expect(await uploadConfigurationFile('project',field,input,connection)).toMatchObject({id:'wf_ab12',size:bytes.length,storage:'server'});
  const [url,options]=fetch.mock.calls[0]!;
  expect(String(url)).toBe(`https://files.test/api/projects/project/configurations/files?${new URLSearchParams({fileName:input.name,mimeType:input.mimeType,key:field.name,field:JSON.stringify(field)})}`);
  expect(options).toMatchObject({method:'POST',headers:{Authorization:'Bearer account-capability','Content-Type':'image/png'},body:bytes,redirect:'error'});
});
it('requires login, validates selection before uploading and rejects paths and malformed payloads',async()=>{
  const fetch=vi.spyOn(globalThis,'fetch');
  await expect(uploadConfigurationFile('project',field,input,undefined)).rejects.toThrow('login');
  for(const file of [{...input,path:'/local.png'},{...input,data:'%%%'},{...input,name:'../map.png'},{...input,mimeType:'text/plain'}]) await expect(uploadConfigurationFile('project',field,file,connection)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it('preserves permission errors and refuses a reference from another project or invalid metadata',async()=>{
  const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response(JSON.stringify({errCode:403,errMessage:'Permission denied.'}),{status:403}));
  await expect(uploadConfigurationFile('project',field,input,connection)).rejects.toThrow('Permission denied');
  for(const value of [{...reference,projectId:'other'},{...reference,size:100},{...reference,path:'/host/file'}]) {
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({errCode:0,data:[value]})));
    await expect(uploadConfigurationFile('project',field,input,connection)).rejects.toThrow();
  }
});
