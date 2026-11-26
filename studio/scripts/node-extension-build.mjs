import { build } from 'esbuild';

// ssh2 falls back to JavaScript when its optional native dependencies are absent.
export const optionalNativeExternals = ['cpu-features', '*.node'];

export function buildStudioNode({ external = [], ...options }) {
  return build({ ...options, platform: 'node', external: [...external, ...optionalNativeExternals] });
}
