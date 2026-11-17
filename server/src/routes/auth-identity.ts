import express, { Router, type Request, type ErrorRequestHandler } from "express";
import { getProjectAuthContext, getRequestPrincipal, readRequestPrincipal, writeAuthSessionCookie, clearAuthSessionCookie } from "../auth";
import { registrationEnabled } from "../auth-identity";
import { mailConfigured, type EmailPurpose } from "../auth-mail";
import { createAuditActor, readRequestIp, recordAuditEventForRequest } from "../audit";
import { HttpError, ok } from "../protocol";

function service() {
  const auth = getProjectAuthContext().authService;
  if (!auth) throw new HttpError(503,503,"Account auth is not configured.");
  return auth;
}
async function account(req: Request): Promise<string> {
  const principal=await readRequestPrincipal(req);
  if (!principal || (principal.kind !== "user_session" && principal.kind !== "admin_session") || principal.tokenSource !== "cookie") throw new HttpError(401,401,"Sign in on the Server website to manage account security.");
  return principal.userId;
}
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
async function audit(req: Request, eventType: string, userId?: string): Promise<void> {
  await recordAuditEventForRequest(req,{...createAuditActor(getRequestPrincipal(req)),...(userId ? {actorUserId:userId} : {}),eventType,outcome:"success",resourceType:"user",resourceId:userId});
}
const publicAttempts=new Map<string,{count:number;until:number}>();
function limit(req: Request): void {
  const key=readRequestIp(req) ?? "unknown", now=Date.now();
  for (const [ip,value] of publicAttempts) if (value.until<=now) publicAttempts.delete(ip);
  const bucket=publicAttempts.get(key) ?? {count:0,until:now+60_000};
  publicAttempts.set(key,bucket);
  if (++bucket.count>10 || publicAttempts.size>10_000) throw new HttpError(429,429,"Too many requests.");
}

export function createIdentityRouter(): Router {
  const router=Router();
  const json = express.json({limit:"32kb"});
  router.use((_req,res,next)=>{res.set({"Cache-Control":"no-store","Referrer-Policy":"no-referrer"});next();});
  router.get("/config",(_req,res)=>res.json(ok({registrationEnabled:registrationEnabled(),methods:{password:true,emailCode:mailConfigured()},mailAvailable:mailConfigured()})));
  router.post("/email-code/send",json,async(req,res,next)=>{
    try {
      limit(req);
      const purpose=string(req.body?.purpose) as EmailPurpose;
      if (!["register","login","bind-email","reauth","password-reset"].includes(purpose)) throw new HttpError(400,400,"Invalid verification purpose.");
      const userId=["bind-email","reauth"].includes(purpose) ? await account(req) : undefined;
      const data=await service().accounts.sendCode({email:string(req.body?.email),purpose,userId,ip:readRequestIp(req) ?? "unknown",locale:req.get("X-SteamHarness-Locale") || req.get("Accept-Language")});
      res.json(ok(data));
    } catch(error) {next(error);}
  });
  router.post("/register",json,async(req,res,next)=>{
    try {
      limit(req);
      if (!["username","email"].includes(req.body?.method)) throw new HttpError(400,400,"Invalid registration method.");
      const auth=service();
      const userId=await auth.accounts.register({method:req.body.method,username:string(req.body?.username),password:string(req.body?.password),challengeId:string(req.body?.challengeId),code:string(req.body?.code)});
      const session=await auth.signInUser(userId); writeAuthSessionCookie(res,session);
      await audit(req,"auth.register",userId);
      res.status(201).json(ok({authenticated:true,user:session.user}));
    } catch(error) {next(error);}
  });
  router.post("/email-code/login",json,async(req,res,next)=>{
    try {
      limit(req);
      const auth=service(), identity=await auth.accounts.loginWithCode(string(req.body?.challengeId),string(req.body?.code));
      const session=await auth.signInUser(identity.userId, identity.identityVersion); writeAuthSessionCookie(res,session);
      await audit(req,"auth.email_code.login",identity.userId);
      res.json(ok({authenticated:true,user:session.user}));
    } catch(error) {next(error);}
  });
  router.post("/password/reset",json,async(req,res,next)=>{
    try {
      limit(req);
      await service().accounts.resetPassword(string(req.body?.challengeId),string(req.body?.code),string(req.body?.password));
      clearAuthSessionCookie(res); await audit(req,"auth.password.reset");res.json(ok({reset:true}));
    } catch(error) {next(error);}
  });
  router.get("/me/security",async(req,res,next)=>{
    try {const userId=await account(req);res.json(ok(await service().accounts.security(userId)));} catch(error){next(error);}
  });
  router.post("/me/username",json,async(req,res,next)=>{
    try {limit(req);const userId=await account(req);await service().accounts.setUsername(userId,string(req.body?.username));await audit(req,"auth.username.set",userId);res.json(ok(await service().accounts.security(userId)));}catch(error){next(error);}
  });
  router.post("/me/email",json,async(req,res,next)=>{
    try {
      limit(req);const userId=await account(req);
      if (!["bind","unbind"].includes(req.body?.action)) throw new HttpError(400,400,"Invalid request.");
      await service().accounts.updateEmail(userId,{action:req.body.action,challengeId:string(req.body?.challengeId),code:string(req.body?.code)});
      clearAuthSessionCookie(res);await audit(req,"auth.email.update",userId);res.json(ok(await service().accounts.security(userId)));
    }catch(error){next(error);}
  });
  router.post("/me/password",json,async(req,res,next)=>{
    try {limit(req);const userId=await account(req);await service().accounts.setPassword(userId,string(req.body?.password));clearAuthSessionCookie(res);await audit(req,"auth.password.update",userId);res.json(ok({updated:true}));}catch(error){next(error);}
  });
  const failures: ErrorRequestHandler = (error,req,_res,next) => {
    void recordAuditEventForRequest(req,{...createAuditActor(getRequestPrincipal(req)),eventType:"auth.identity.failed",outcome:"failed",resourceType:"user",context:{operation:req.path,status:error instanceof HttpError ? error.statusCode : 500}}).catch(() => undefined);
    next(error);
  };
  router.use(failures);
  return router;
}
