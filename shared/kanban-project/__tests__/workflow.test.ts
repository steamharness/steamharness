import {it,expect} from 'vitest';
import {parseKanbanBridgeCall} from '../index';
it('validates local Workflow controls without accepting identity or paths',()=>{
 const parse=(input:unknown)=>parseKanbanBridgeCall({requestId:'bridge',operation:'entries.workflow',input});
 expect(parse({entryId:'capture',action:'start',entrypointId:'listen',requestId:'stable',params:{windowId:'42',recordActions:'true'}}).operation).toBe('entries.workflow');
 expect(()=>parse({entryId:'capture',action:'page',runId:'run',page:0})).toThrow();
 expect(()=>parse({entryId:'capture',action:'list',limit:101})).toThrow();
 expect(()=>parse({entryId:'capture',action:'start',entrypointId:'listen',params:{recordActions:true},requestId:'stable'})).toThrow();
 expect(()=>parse({entryId:'capture',action:'file',runId:'run',fileId:'image',projectId:'another'})).toThrow();
 expect(()=>parse({entryId:'capture',action:'file',runId:'run',fileId:'image',path:'/tmp/private'})).toThrow();
});
