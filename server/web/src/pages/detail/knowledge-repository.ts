import type { KnowledgeRepository, KnowledgeResult } from '@steamharness/knowledge-base';
import { ServerApiClient } from '../../api';
import { isApiSuccess, type ApiResponse } from '../../types';
function result<T>(response:ApiResponse<T>):KnowledgeResult<T>{return isApiSuccess(response)?{errCode:0,errMessage:'',data:response.data}:{errCode:response.errCode,errMessage:response.errMessage};}
/** Space identity, independent of every project that has a grant. */
export function createServerKnowledgeRepository(client:ServerApiClient,spaceId:string):KnowledgeRepository{
  const call=async<T>(operation:string,input:unknown,signal?:AbortSignal)=>result(await client.databaseOperation<T>(spaceId,operation,input,signal));
  return {
    listDocuments:({signal,...input})=>call('knowledge.listDocuments',input,signal),
    getDocument:(documentId,{signal}={})=>call('knowledge.getDocument',{documentId},signal),
    createDocument:(input,{signal}={})=>call('knowledge.createDocument',input,signal),
    updateDocument:(documentId,input,{signal}={})=>call('knowledge.editDocument',{documentId,...input},signal),
    deleteDocument:(documentId,{signal}={})=>call('knowledge.deleteDocument',{documentId},signal),
    searchDocuments:({signal,...input})=>call('knowledge.searchDocuments',input,signal),
    readDocumentLines:(documentId,{signal,...input})=>call('knowledge.readDocumentLines',{documentId,...input},signal),
  };
}
