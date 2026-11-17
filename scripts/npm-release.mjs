import {appendFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

export function npmReleasePlan({eventName,ref,release,coreVersion,cliVersion,cliCoreVersion}) {
  if(coreVersion!==cliVersion)throw new Error('Core and CLI versions must match.');
  if(cliCoreVersion!==coreVersion)throw new Error('CLI must pin the exact SDK version being published.');
  const stable=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  if(eventName==='workflow_dispatch') {
    if(ref!=='refs/heads/dev'||!/^\d+\.\d+\.\d+-dev\.\d+$/.test(coreVersion))
      throw new Error('Manual dev publication requires the dev branch and a dev prerelease.');
    return {version:coreVersion,distTag:'dev'};
  }
  if(eventName!=='release'||release?.tag_name!==`steamharness/v${coreVersion}`||ref!==`refs/tags/steamharness/v${coreVersion}`)
    throw new Error('Release tag must match the package version and checked out tag.');
  if(release.prerelease) {
    if(!/^\d+\.\d+\.\d+-\d{11}$/.test(coreVersion))
      throw new Error('Alpha requires a dated prerelease version (X.Y.Z-YYYYMMDDNNN).');
    return {version:coreVersion,distTag:'alpha'};
  }
  if(!stable.test(coreVersion))throw new Error('A prerelease must never update npm latest.');
  return {version:coreVersion,distTag:'latest'};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const core=JSON.parse(await readFile(path.join(root,'harness/package.json'),'utf8'));
  const cli=JSON.parse(await readFile(path.join(root,'cli/package.json'),'utf8'));
  const event=JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH,'utf8'));
  const plan=npmReleasePlan({eventName:process.env.GITHUB_EVENT_NAME,ref:process.env.GITHUB_REF,release:event.release,
    coreVersion:core.version,cliVersion:cli.version,cliCoreVersion:cli.devDependencies?.steamharness});
  await appendFile(process.env.GITHUB_ENV,`NPM_DIST_TAG=${plan.distTag}\n`);
  console.log(JSON.stringify(plan));
}
