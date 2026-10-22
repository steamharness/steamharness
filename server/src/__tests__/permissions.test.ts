import assert from "node:assert/strict";
import test from "node:test";
import {canManageMember,PROJECT_ROLES,resolveResourceAccess} from "@steamharness/project-access";
const access=(role:typeof PROJECT_ROLES[number])=>resolveResourceAccess([{type:"project",id:"a",role}]);
test("fixed roles have cumulative capabilities and Guest never writes server data",()=>{
  let previous:string[]=[];
  for(const role of PROJECT_ROLES){const current=access(role);assert.ok(previous.every(value=>current.capabilities.includes(value as never)));previous=current.capabilities;}
  assert.deepEqual(access('guest').capabilities,['read','downloadSource']);
  assert.ok(access('developer').capabilities.includes('upload'));assert.ok(access('developer').capabilities.includes('publish'));
  assert.equal(access('developer').capabilities.includes('manageSettings'),false);
  assert.equal(access('maintainer').capabilities.includes('delete'),false);
});
test("maintainers cannot change peers or owners, including inherited roles",()=>{
  assert.equal(canManageMember(access('maintainer'),access('developer'),'guest'),true);
  for(const target of ['maintainer','owner'] as const)assert.equal(canManageMember(access('maintainer'),access(target),'guest'),false);
  assert.equal(canManageMember(access('maintainer'),access('guest'),'owner'),false);
  assert.equal(canManageMember(access('owner'),access('owner'),'guest'),true);
});
