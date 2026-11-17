import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { AccountRepository } from '../account-db';
import { AuthService } from '../account-auth';
import { AccountIdentityService, registrationEnabled } from '../auth-identity';
import type { EmailPurpose } from '../auth-mail';
const databaseUrl=process.env.STEAMHARNESS_TEST_DATABASE_URL?.trim();
test('registration, verified email, recovery and device races use isolated PostgreSQL',{skip:!databaseUrl},async()=>{
 assert.ok(databaseUrl);const previous=process.env.STEAMHARNESS_SERVER_REGISTRATION_ENABLED;
 const pool=new pg.Pool({connectionString:databaseUrl}), db=new AccountRepository(databaseUrl),auth=new AuthService({databaseUrl,accountDb:db});
 const mail: {email:string;code:string;purpose:EmailPurpose}[]=[];
 await db.init();await auth.initialize();
 const accounts=new AccountIdentityService({pool,baseReady:auth.initialize(),sendMail:async value=>{mail.push(value);},revokeSessions:async(userId,client)=>{await client.query('update steamharness_auth_sessions set revoked_at=now() where user_id=$1',[userId]);}});
 const suffix=randomUUID().slice(0,8),username=`identity_${suffix}`,email=`identity-${suffix}@example.test`;
 const send=async(purpose:EmailPurpose,userId?:string,address=email)=>{
  await pool.query("update steamharness_auth_email_challenges set created_at=now()-interval '61 seconds' where email=$1",[address]);
  const challenge=await accounts.sendCode({email:address,purpose,userId,ip:'127.0.0.1'});
  return {...challenge,code:mail.filter(value=>value.email===address).at(-1)?.code ?? ''};
 };
 try {
  delete process.env.STEAMHARNESS_SERVER_REGISTRATION_ENABLED;assert.equal(registrationEnabled(),false);
  await assert.rejects(accounts.register({method:'username',username,password:'test-password'}),/closed/);
  process.env.STEAMHARNESS_SERVER_REGISTRATION_ENABLED='true';
  const userId=await accounts.register({method:'username',username,password:'test-password'});
  const security=await accounts.security(userId);assert.deepEqual(security,{username,email:null,emailVerifiedAt:null,hasPassword:true});
  const profile=await db.getUserProfileOrThrow(userId);assert.equal(profile.isSystemAdmin,false);assert.match(profile.displayName,/^SteamUser-/);
  const login=await auth.signInWithPassword({email:username.toUpperCase(),password:'test-password'});assert.equal(login.user.email,null);
  await assert.rejects(accounts.register({method:'username',username:username.toUpperCase(),password:'test-password'}),/already in use/);
  const target=await send('bind-email',userId);
  await assert.rejects(accounts.updateEmail(userId,{action:'bind',challengeId:target.challengeId,code:target.code==='000000'?'000001':'000000'}),/invalid or expired/);
  await accounts.updateEmail(userId,{action:'bind',challengeId:target.challengeId,code:target.code});
  assert.ok((await accounts.security(userId)).emailVerifiedAt);
  await assert.rejects(auth.getUserByAccessToken(login.accessToken));
  const challenge=await send('login');
  await assert.rejects(accounts.loginWithCode(challenge.challengeId,challenge.code==='000000'?'000001':'000000'),/invalid or expired/);
  const identity=await accounts.loginWithCode(challenge.challengeId,challenge.code);assert.equal(identity.userId,userId);
  const byCode=await auth.signInUser(identity.userId,identity.identityVersion);assert.equal(byCode.user.email,email);
  await assert.rejects(accounts.loginWithCode(challenge.challengeId,challenge.code),/invalid or expired/);
  const oldReset=await send('password-reset');
  const desktop=await db.createApiKey({userId,name:'Desktop',source:'desktop'}),manual=await db.createApiKey({userId,name:'Manual',source:'manual'});
  const started=await auth.createDeviceCode({clientName:'Test',source:'cli'});
  const result={user:{userId,email,displayName:profile.displayName}};
  const approvals=await Promise.allSettled([1,2].map(()=>db.updateDeviceCodeState(started.record.id,{state:'approved',approvedByUserId:userId,approvedAt:new Date().toISOString(),result})));
  assert.equal(approvals.filter(value=>value.status==='fulfilled').length,1);
  await accounts.setPassword(userId,'updated-password',{password:'test-password'});
  await assert.rejects(accounts.resetPassword(oldReset.challengeId,oldReset.code,'stolen-password'),/invalid or expired/);
  assert.equal(await db.findApiKeyByToken(desktop.token),undefined);assert.ok(await db.findApiKeyByToken(manual.token));
  assert.equal(await db.consumeApprovedDeviceCodeWithApiKey(started.record.id,{userId,name:'Race',source:'cli',consumedAt:new Date().toISOString(),result}),undefined);
  const reset=await send('password-reset');await accounts.resetPassword(reset.challengeId,reset.code,'reset-password');
  await assert.rejects(auth.signInWithPassword({email,password:'updated-password'}));await auth.signInWithPassword({email,password:'reset-password'});
  const unbindProof=await send('reauth',userId);
  await accounts.updateEmail(userId,{action:'unbind',reauthChallengeId:unbindProof.challengeId,reauthCode:unbindProof.code});assert.equal((await accounts.security(userId)).email,null);
  await auth.signInWithPassword({email:username,password:'reset-password'});
  const email2=`email-${suffix}@example.test`,reg=await send('register',undefined,email2);
  const emailUser=await accounts.register({method:'email',challengeId:reg.challengeId,code:reg.code});assert.equal((await accounts.security(emailUser)).hasPassword,false);
  await assert.rejects(accounts.updateEmail(emailUser,{action:'unbind',password:'nothing'}),/Verify your current/);
  const proof=await send('reauth',emailUser,email2);await accounts.setUsername(emailUser,`mail_${suffix}`,{reauthChallengeId:proof.challengeId,reauthCode:proof.code});
  const retries=await send('login',undefined,email2);
  for(let i=0;i<5;i++) await assert.rejects(accounts.loginWithCode(retries.challengeId,retries.code==='000000'?'000001':'000000'));
  await assert.rejects(accounts.loginWithCode(retries.challengeId,retries.code));
  await assert.rejects(accounts.sendCode({email:email2,purpose:'login',ip:'127.0.0.1'}),/Too many verification/);
  const cancelled=await auth.createDeviceCode({clientName:'Cancel',source:'cli'});
  await db.updateDeviceCodeState(cancelled.record.id,{state:'approved',approvedByUserId:userId,result:{user:{userId,email:null,displayName:'Test'}}});
  const minted=await db.consumeApprovedDeviceCodeWithApiKey(cancelled.record.id,{userId,name:'Cancel race',source:'cli',consumedAt:new Date().toISOString(),result:{user:{userId,email:null,displayName:'Test'}}});assert.ok(minted);
  await db.cancelDeviceCode(cancelled.deviceCode);assert.equal(await db.findApiKeyByToken(minted.apiKey.token),undefined);
  const staleProof = await send('login',undefined,email2);
  const staleIdentity = await accounts.loginWithCode(staleProof.challengeId,staleProof.code);
  const adminDevice = await db.createApiKey({userId:emailUser,name:'Admin change',source:'cli'});
  await auth.updateAuthUser({userId:emailUser,password:'admin-updated-password'});
  await assert.rejects(auth.signInUser(emailUser,staleIdentity.identityVersion));
  assert.equal(await db.findApiKeyByToken(adminDevice.token),undefined);
  assert.ok(await db.findApiKeyByToken(manual.token));

 } finally {
  if(previous===undefined) delete process.env.STEAMHARNESS_SERVER_REGISTRATION_ENABLED;else process.env.STEAMHARNESS_SERVER_REGISTRATION_ENABLED=previous;
  await auth.close();await db.close();await pool.end();
 }
});

test('email binding needs only the target code while replacement and removal retain identity proof',{skip:!databaseUrl},async t=>{
 assert.ok(databaseUrl);
 const previous=process.env.STEAMHARNESS_SERVER_REGISTRATION_ENABLED;
 const pool=new pg.Pool({connectionString:databaseUrl}),db=new AccountRepository(databaseUrl),auth=new AuthService({databaseUrl,accountDb:db});
 const mail:{email:string;code:string;purpose:EmailPurpose}[]=[];
 await db.init();await auth.initialize();
 const accounts=new AccountIdentityService({pool,baseReady:auth.initialize(),sendMail:async value=>{mail.push(value);},revokeSessions:async(userId,client)=>{await client.query('update steamharness_auth_sessions set revoked_at=now() where user_id=$1',[userId]);}});
 const suffix=randomUUID().slice(0,8);
 const send=async(userId:string,address:string)=>{
  await pool.query("update steamharness_auth_email_challenges set created_at=now()-interval '61 seconds' where email=$1",[address]);
  const challenge=await accounts.sendCode({email:address,purpose:'bind-email',userId,ip:'127.0.0.2'});
  return {...challenge,code:mail.filter(value=>value.email===address).at(-1)?.code ?? ''};
 };
 try {
  process.env.STEAMHARNESS_SERVER_REGISTRATION_ENABLED='true';
  const owner=await accounts.register({method:'username',username:`bind_${suffix}`,password:'test-password'});
  const other=await accounts.register({method:'username',username:`other_${suffix}`,password:'test-password'});
  const address=`first-${suffix}@example.test`,first=await send(owner,address);
  await t.test('a target code cannot be used by another account',async()=>{
   await assert.rejects(accounts.updateEmail(other,{action:'bind',challengeId:first.challengeId,code:first.code}),/invalid or expired/);
   assert.equal((await accounts.security(other)).email,null);
  });
  await t.test('first binding needs no password or reauthentication code and cannot be replayed',async()=>{
   await accounts.updateEmail(owner,{action:'bind',challengeId:first.challengeId,code:first.code});
   assert.equal((await accounts.security(owner)).email,address);assert.ok((await accounts.security(owner)).emailVerifiedAt);
   await assert.rejects(accounts.updateEmail(owner,{action:'bind',challengeId:first.challengeId,code:first.code}),/invalid or expired/);
  });
  await t.test('replacement and unbinding still require current identity proof',async()=>{
   const replacement=`replacement-${suffix}@example.test`,target=await send(owner,replacement);
   await assert.rejects(accounts.updateEmail(owner,{action:'bind',challengeId:target.challengeId,code:target.code}),/Verify your current/);
   assert.equal((await accounts.security(owner)).email,address);
   await assert.rejects(accounts.updateEmail(owner,{action:'unbind'}),/Verify your current/);
   const fresh=await send(owner,replacement);
   await accounts.updateEmail(owner,{action:'bind',challengeId:fresh.challengeId,code:fresh.code,password:'test-password'});
   assert.equal((await accounts.security(owner)).email,replacement);
  });
  await t.test('an unverified address can be verified without proof but cannot be replaced that way',async()=>{
   const legacy=`legacy-${suffix}@example.test`;
   await pool.query('update steamharness_auth_users set email=$2,email_verified_at=null where id=$1',[other,legacy]);
   await pool.query('update user_profiles set email=$2 where user_id=$1',[other,legacy]);
   const replacement=await send(other,`legacy-change-${suffix}@example.test`);
   await assert.rejects(accounts.updateEmail(other,{action:'bind',challengeId:replacement.challengeId,code:replacement.code}),/Verify your current/);
   assert.equal((await accounts.security(other)).email,legacy);
   await pool.query('update steamharness_auth_users set password_hash=null where id=$1',[other]);
   const verify=await send(other,legacy);
   await accounts.updateEmail(other,{action:'bind',challengeId:verify.challengeId,code:verify.code});
   assert.ok((await accounts.security(other)).emailVerifiedAt);
  });
  await t.test('expired and revoked target codes cannot bypass verification',async()=>{
   const freshUser=await accounts.register({method:'username',username:`expiry_${suffix}`,password:'test-password'});
   const target=await send(freshUser,`expired-${suffix}@example.test`);
   await pool.query("update steamharness_auth_email_challenges set expires_at=now()-interval '1 second' where id=$1",[target.challengeId]);
   await assert.rejects(accounts.updateEmail(freshUser,{action:'bind',challengeId:target.challengeId,code:target.code}),/invalid or expired/);
   const stale=await send(freshUser,`stale-${suffix}@example.test`);
   await accounts.setPassword(freshUser,'updated-password',{password:'test-password'});
   await assert.rejects(accounts.updateEmail(freshUser,{action:'bind',challengeId:stale.challengeId,code:stale.code}),/invalid or expired/);
   assert.equal((await accounts.security(freshUser)).email,null);
  });
  await t.test('concurrent first bindings cannot replace each other without proof',async()=>{
   const freshUser=await accounts.register({method:'username',username:`race_${suffix}`,password:'test-password'});
   const targets=await Promise.all([`race-a-${suffix}@example.test`,`race-b-${suffix}@example.test`].map(async address=>({address,...await send(freshUser,address)})));
   const results=await Promise.allSettled(targets.map(target=>accounts.updateEmail(freshUser,{action:'bind',challengeId:target.challengeId,code:target.code})));
   assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
   const winner=targets[results.findIndex(result=>result.status==='fulfilled')];
   assert.equal((await accounts.security(freshUser)).email,winner.address);
  });
 } finally {
  if(previous===undefined) delete process.env.STEAMHARNESS_SERVER_REGISTRATION_ENABLED;else process.env.STEAMHARNESS_SERVER_REGISTRATION_ENABLED=previous;
  await auth.close();await db.close();await pool.end();
 }
});
