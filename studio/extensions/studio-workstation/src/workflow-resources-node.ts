import { spawn } from 'node:child_process';
import type { Project } from './workflow-types';
import type { ResourceRequest } from './workflow-resources-types';
import type { HostDatabaseRequest } from './workflow-databases-types';
import { sanitizeProjectEnvironment, AuthError, type Connection } from './workflow-auth-client';
import { sanitizeConnectionForSurface } from './workflow-cli-process';
import { t } from './localization';
import { nodeRuntimeEnvironment, type NodeRuntime } from './node-runtime';

export function requestProjectResource(options: {
  project: Project; input: ResourceRequest | HostDatabaseRequest; worker: string; storageDir: string;
  nodePath: string; connection?: Connection; signal: AbortSignal; runtime?: NodeRuntime;
}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    options.signal.throwIfAborted();
    const connection = sanitizeConnectionForSurface(options.connection, 'editor');
    const env: NodeJS.ProcessEnv = sanitizeProjectEnvironment(options.runtime ? nodeRuntimeEnvironment(options.runtime) : process.env);
    if (!options.runtime) env.ELECTRON_RUN_AS_NODE = '1';
    const child = spawn(options.nodePath, [options.worker], { cwd: options.project.folderPath, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], signal: options.signal });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    const clean = (value: string): string => connection ? value.replaceAll(connection.accessToken, '[redacted]') : value;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (value: string) => { stdout += value; if (stdout.length > 8 * 1024 * 1024) { child.kill('SIGKILL'); } });
    child.stderr.on('data', (value: string) => { stderr = (stderr + value).slice(-8000); });
    child.stdin.on('error', () => undefined);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => {
      clearTimeout(timeout);
      try {
        const result = JSON.parse(stdout) as { value?: unknown; error?: string; status?: number; source?: string; sources?: string[] };
        if (result.error || code !== 0) { throw Object.assign(new AuthError(t(clean(result.error || stderr || 'Resource worker stopped.')), result.status), { source: result.source, sources: result.sources }); }
        resolve(result.value);
      } catch (error) { reject(error instanceof SyntaxError ? new Error(clean(stderr || 'Invalid resource worker response.')) : error); }
    });
    // Resource workers always run on the editor surface. Send the scoped
    // connection calculated above instead of the caller object, which may also
    // contain the private AI service credentials used by the Assistant.
    child.stdin.end(JSON.stringify({ project: { id: options.project.id, entryId: options.project.entryId, folderPath: options.project.folderPath }, input: options.input, storageDir: options.storageDir, connection }));
  });
}
