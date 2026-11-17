import assert from 'node:assert/strict';
import test from 'node:test';
import { npmReleasePlan } from '../npm-release.mjs';

const release=(version,prerelease=false)=>({eventName:'release',ref:`refs/tags/steamharness/v${version}`,release:{tag_name:`steamharness/v${version}`,prerelease},coreVersion:version,cliVersion:version,cliCoreVersion:version});
test('stable and alpha Releases select separate npm tags',()=>{
  assert.deepEqual(npmReleasePlan(release('0.1.3')),{version:'0.1.3',distTag:'latest'});
  assert.deepEqual(npmReleasePlan(release('0.1.3-20261117001',true)),{version:'0.1.3-20261117001',distTag:'alpha'});
});
test('prereleases cannot update latest or disguise stable versions as alpha',()=>{
  assert.throws(()=>npmReleasePlan(release('0.1.3-20261117001')),/prerelease/);
  assert.throws(()=>npmReleasePlan(release('0.1.3',true)),/prerelease/);
});
test('tag identity, paired versions and CLI SDK pin must all agree',()=>{
  const plan=release('0.1.3');
  assert.throws(()=>npmReleasePlan({...plan,release:{tag_name:'steamharness/v0.1.2',prerelease:false}}),/tag/);
  assert.throws(()=>npmReleasePlan({...plan,cliVersion:'0.1.2'}),/versions/);
  assert.throws(()=>npmReleasePlan({...plan,cliCoreVersion:'0.1.2'}),/SDK/);
});
test('manual dev publication retains its branch and prerelease restrictions',()=>{
  const plan={eventName:'workflow_dispatch',ref:'refs/heads/dev',coreVersion:'0.1.3-dev.20261117001',cliVersion:'0.1.3-dev.20261117001',cliCoreVersion:'0.1.3-dev.20261117001'};
  assert.deepEqual(npmReleasePlan(plan),{version:'0.1.3-dev.20261117001',distTag:'dev'});
  assert.throws(()=>npmReleasePlan({...plan,ref:'refs/heads/main'}),/dev/);
  assert.throws(()=>npmReleasePlan({...plan,...release('0.1.3'),eventName:'workflow_dispatch',ref:'refs/heads/dev'}),/dev/);
});
