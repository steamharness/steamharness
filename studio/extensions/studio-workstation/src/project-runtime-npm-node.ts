import { gtr, lt, prerelease, satisfies, valid, validRange } from 'semver';
import type { projectRuntimePackages } from '../../../vendor/project-templates/project-runtime-packages';

type RuntimePackageName = typeof projectRuntimePackages[number]['name'];
export type RuntimeNpmLatest = (name: RuntimePackageName) => Promise<string | undefined>;

export interface RuntimeNpmUpdate {
  name: RuntimePackageName;
  group: string;
  spec: string;
  installedVersion?: string;
  latestVersion: string;
  kind: 'declaration' | 'installation';
}

export function runtimeNpmRange(spec: string): string | undefined {
  if (spec.trim() && spec.length <= 1024) return validRange(spec) ?? undefined;
}

export function runtimeNpmUpdate(range: string, latestVersion: string, installedVersion?: string): RuntimeNpmUpdate['kind'] | undefined {
  if (gtr(latestVersion, range)) return 'declaration';
  if (installedVersion && lt(installedVersion, latestVersion) && satisfies(latestVersion, range)) return 'installation';
}

export function createRuntimeNpmLatest(lifetime: AbortSignal, request?: typeof fetch, now = Date.now): RuntimeNpmLatest {
  const cache = new Map<RuntimePackageName, { expires: number; result: Promise<string | undefined> }>();
  const fetchLatest = async (name: RuntimePackageName) => {
    try {
      // Only the two public runtime package names are sent; project registry settings are not involved.
      const response = await (request ?? fetch)(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
        signal: AbortSignal.any([lifetime, AbortSignal.timeout(4_000)]), credentials: 'omit', redirect: 'error',
      });
      if (!response.ok) return;
      const metadata = await response.json();
      if (metadata?.name !== name || typeof metadata.version !== 'string') return;
      const version = valid(metadata.version);
      if (version && !prerelease(version)) return version;
    } catch { /* Unavailable registry metadata must not block editing or suggest an upgrade. */ }
  };
  return name => {
    if (lifetime.aborted) return Promise.resolve(undefined);
    const previous = cache.get(name);
    if (previous && previous.expires > now()) return previous.result;
    const entry = { expires: Infinity, result: fetchLatest(name) };
    cache.set(name, entry);
    void entry.result.then(version => { entry.expires = now() + (version ? 15 * 60_000 : 60_000); });
    return entry.result;
  };
}
