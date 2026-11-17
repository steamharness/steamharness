import {appendFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

/** npm 上两个公开包与它们的 registry 元数据地址。 */
const PUBLIC_PACKAGES = ['steamharness', '@steamharness/cli'];
const REGISTRY_BASE = process.env.STEAMHARNESS_NPM_REGISTRY_URL?.replace(/\/+$/u, '') || 'https://registry.npmjs.org';
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const DATED_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-(\d{8})(\d{3})$/u;
const DEV_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-dev\.(\d{8})(\d{3})$/u;

/** 日期版本必须落在真实日历上：月份 1-12，日按月份与闰年校验。 */
export function parseDatedVersion(version) {
  const match = DATED_VERSION.exec(String(version).trim());
  if (!match) return undefined;
  const [, , , , datePart, sequencePart] = match;
  const month = Number(datePart.slice(4, 6));
  const day = Number(datePart.slice(6, 8));
  const year = Number(datePart.slice(0, 4));
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) return undefined;
  const sequence = Number(sequencePart);
  if (sequence < 1 || sequence > 999) return undefined;
  return { date: datePart, month, day, year, sequence };
}

/** dev 版本同样校验真实日期与 001-999 的日内序号。 */
export function parseDevVersion(version) {
  const match = DEV_VERSION.exec(String(version).trim());
  if (!match) return undefined;
  const [, , , , datePart, sequencePart] = match;
  const month = Number(datePart.slice(4, 6));
  const day = Number(datePart.slice(6, 8));
  const year = Number(datePart.slice(0, 4));
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) return undefined;
  const sequence = Number(sequencePart);
  if (sequence < 1 || sequence > 999) return undefined;
  return { date: datePart, month, day, year, sequence };
}

/** plan 的 dist-tag 对应构建时烘入的服务通道。 */
export function serviceChannelForPlan(plan) {
  if (plan.distTag === 'alpha') return 'alpha';
  if (plan.distTag === 'latest') return 'main';
  if (plan.distTag === 'dev') return 'dev';
  throw new Error(`Unknown npm dist-tag: ${plan.distTag}`);
}

/**
 * 纯计划函数：只判断"这次运行该发什么"，不碰 registry。
 * CLI 的 devDependency 与 peerDependency 都必须精确等于本次 Core 版本。
 */
export function npmReleasePlan({eventName,ref,release,coreVersion,cliVersion,cliCoreVersion,cliPeerVersion}) {
  if(coreVersion!==cliVersion)throw new Error('Core and CLI versions must match.');
  if(cliCoreVersion!==coreVersion)throw new Error('CLI must pin the exact SDK version being published.');
  if(cliPeerVersion!==coreVersion)throw new Error('CLI peerDependency must equal the exact SDK version being published.');
  if(!STABLE_VERSION.test(coreVersion)&&!DATED_VERSION.test(coreVersion)&&!DEV_VERSION.test(coreVersion))
    throw new Error(`Package version is not a supported release version: ${coreVersion}`);
  if(eventName==='workflow_dispatch') {
    if(ref!=='refs/heads/dev'||parseDevVersion(coreVersion)===undefined)
      throw new Error('Manual dev publication requires the dev branch and a dated dev prerelease (X.Y.Z-dev.YYYYMMDDNNN).');
    return {version:coreVersion,distTag:'dev'};
  }
  if(eventName!=='release'||release?.tag_name!==`steamharness/v${coreVersion}`||ref!==`refs/tags/steamharness/v${coreVersion}`)
    throw new Error('Release tag must match the package version and checked out tag.');
  if(release.prerelease) {
    if(parseDatedVersion(coreVersion)===undefined)
      throw new Error('Alpha requires a dated prerelease version (X.Y.Z-YYYYMMDDNNN) with a real calendar date and sequence 001-999.');
    return {version:coreVersion,distTag:'alpha'};
  }
  if(!STABLE_VERSION.test(coreVersion))throw new Error('A prerelease must never update npm latest.');
  return {version:coreVersion,distTag:'latest'};
}

/**
 * 匿名 registry 读回。网络错误一律向上抛出（拒绝放行）；404 视为"还没有发布"。
 * 返回按包名索引的 {versions, latest}。
 */
export async function fetchRegistryState({fetchImpl=globalThis.fetch,registryBase=REGISTRY_BASE,packages=PUBLIC_PACKAGES}={}) {
  const state={};
  for(const name of packages) {
    const url=`${registryBase}/${encodeURIComponent(name).replace(/^%40/u,'@')}`;
    const response=await fetchImpl(url,{headers:{accept:'application/json'}});
    if(response.status===404){state[name]={versions:[],latest:undefined};continue;}
    if(!response.ok)throw new Error(`registry read for ${name} failed with HTTP ${response.status}.`);
    const body=await response.json();
    const versions=Object.keys(body?.versions??{});
    state[name]={versions,latest:body?.['dist-tags']?.latest};
  }
  return state;
}

function compareStable(left,right) {
  const parse=(value)=>String(value).split('.').map((part)=>Number.parseInt(part,10)||0);
  const [a,b]=[parse(left),parse(right)];
  for(let index=0;index<3;index+=1){if(a[index]!==b[index])return a[index]-b[index];}
  return 0;
}

/**
 * 发布前门禁（在 SDK/CLI 任何 publish 之前执行）：
 * - 任一包已经存在同版本：拒绝（npm 的 --tag 不能绕过这一条）。
 * - 稳定版必须严格高于该通道当前 latest，否则拒绝（显式 --tag 会绕过 npm 自带的保护，
 *   所以这里自己拦）。预发布版本天然单调，不做 latest 比较。
 */
export function verifyPublishState({plan,registry}) {
  for(const name of PUBLIC_PACKAGES) {
    const entry=registry?.[name];
    if(!entry)throw new Error(`registry state for ${name} is missing.`);
    if(entry.versions.includes(plan.version))
      throw new Error(`${name}@${plan.version} is already published; allocate a new version instead of republishing.`);
  }
  if(!plan.version.includes('-')) {
    for(const name of PUBLIC_PACKAGES) {
      const current=registry[name]?.latest;
      if(current&&compareStable(plan.version,current)<=0)
        throw new Error(`${name} ${plan.version} must be higher than the npm latest ${current}.`);
    }
  }
  return {version:plan.version,distTag:plan.distTag,checkedPackages:PUBLIC_PACKAGES.filter((name)=>registry[name])};
}

/**
 * 实际的入口逻辑：读取清单与事件，算 plan，跑 registry 门禁，然后把
 * NPM_DIST_TAG 与 STEAMHARNESS_SERVICE_CHANNEL 写进 GITHUB_ENV。
 * 测试直接调用这个函数并注入 fetchImpl 与临时 env 文件，验证写出的内容。
 */
export async function runNpmRelease({root,env=process.env,fetchImpl=globalThis.fetch,append=appendFile}={}) {
  const resolvedRoot=path.resolve(root??path.dirname(fileURLToPath(import.meta.url)));
  const core=JSON.parse(await readFile(path.join(resolvedRoot,'harness/package.json'),'utf8'));
  const cli=JSON.parse(await readFile(path.join(resolvedRoot,'cli/package.json'),'utf8'));
  if(!env.GITHUB_EVENT_PATH)throw new Error('GITHUB_EVENT_PATH is required to select the release channel.');
  if(!env.GITHUB_ENV)throw new Error('GITHUB_ENV is required to export the release environment.');
  const event=JSON.parse(await readFile(env.GITHUB_EVENT_PATH,'utf8'));
  const plan=npmReleasePlan({eventName:env.GITHUB_EVENT_NAME,ref:env.GITHUB_REF,release:event.release,
    coreVersion:core.version,cliVersion:cli.version,cliCoreVersion:cli.devDependencies?.steamharness,
    cliPeerVersion:cli.peerDependencies?.steamharness});
  const registry=await fetchRegistryState({fetchImpl});
  const gate=verifyPublishState({plan,registry});
  const serviceChannel=serviceChannelForPlan(plan);
  await append(env.GITHUB_ENV,`NPM_DIST_TAG=${plan.distTag}\nSTEAMHARNESS_SERVICE_CHANNEL=${serviceChannel}\n`);
  const result={...plan,serviceChannel,gate};
  console.log(JSON.stringify(result));
  return result;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  await runNpmRelease({});
}
