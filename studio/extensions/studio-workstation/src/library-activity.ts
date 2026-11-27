import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const entryId = /^[a-z][a-z0-9_-]{0,63}$/;
const maxLeaseBytes = 1024 * 1024;

interface LibraryActivityProject {
  uri: string;
  projectId?: string;
  distribution?: string;
  managed?: boolean;
}

async function directories(directory: string): Promise<string[]> {
  return (await readdir(directory, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory()).map(entry => entry.name);
}

function managedInstance(uri: string): string | undefined {
  try {
    const name = path.basename(fileURLToPath(uri));
    if (!name.endsWith('.code-workspace')) return;
    const id = name.slice(0, -'.code-workspace'.length);
    return uuid.test(id) ? id.toLowerCase() : undefined;
  } catch { return undefined; }
}

function processAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fff_ffff) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function entryRunning(root: string, project: string, entry: string, now: number): Promise<boolean> {
  const directory = path.join(root, 'entries', entry, 'activity');
  const files = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const runs = new Map<string, { changedAt: number; running: boolean }>();
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith('.json') || !uuid.test(file.name.slice(0, -5))) continue;
    try {
      const filename = path.join(directory, file.name);
      if ((await stat(filename)).size > maxLeaseBytes) continue;
      const lease = JSON.parse(await readFile(filename, 'utf8'));
      if (lease?.version !== 1 || typeof lease.projectId !== 'string' || lease.projectId.toLowerCase() !== project || lease.entryId !== entry
        || !Number.isFinite(lease.updatedAt) || lease.updatedAt < now - 20_000 || lease.updatedAt > now + 5_000
        || !Array.isArray(lease.runs) || !processAlive(lease.pid)) continue;
      for (const run of lease.runs) {
        // A history-only copy has no observed transition and cannot prove that this process started a task.
        if (typeof run?.id !== 'string' || typeof run.status !== 'string' || !Number.isFinite(run.changedAt) || run.changedAt > lease.updatedAt + 5_000) continue;
        const previous = runs.get(run.id);
        const running = run.status === 'running';
        if (!previous || run.changedAt > previous.changedAt || (run.changedAt === previous.changedAt && !running)) {
          runs.set(run.id, { changedAt: run.changedAt, running });
        }
      }
    } catch { /* A partial, malformed, or retired lease does not prove activity. */ }
  }
  return [...runs.values()].some(run => run.running);
}

/** Read the existing CLI activity leases, not conversation history or an open server's health. */
export async function readRunningLibraryProjects(storageDir: string, value: unknown, now = Date.now()): Promise<string[]> {
  if (!Array.isArray(value)) return [];
  const projects: LibraryActivityProject[] = value.filter(row => typeof row?.uri === 'string' && row.uri.startsWith('file:')).slice(0, 500);
  const cache = new Map<string, Promise<boolean>>();
  const isRunning = (root: string, id: string): Promise<boolean> => {
    const key = root;
    let result = cache.get(key);
    if (!result) {
      result = (async () => {
        for (const entry of await directories(path.join(key, 'entries'))) {
          if (entryId.test(entry) && await entryRunning(root, id, entry, now)) return true;
        }
        return false;
      })();
      cache.set(key, result);
    }
    return result;
  };
  const running: string[] = [];
  for (let offset = 0; offset < projects.length; offset += 16) {
    const batch = await Promise.all(projects.slice(offset, offset + 16).map(async row => {
      const id = typeof row.projectId === 'string' && uuid.test(row.projectId) ? row.projectId.toLowerCase() : undefined;
      if (row.managed === true) {
        // Managed workspace filenames carry the instance UUID. Its tasks must not light up the template or parent folder.
        const instance = managedInstance(row.uri);
        if (!instance) return;
        const projects = path.join(storageDir, 'projects');
        for (const project of id ? [id] : (await directories(projects)).filter(name => uuid.test(name))) {
          if (await isRunning(path.join(projects, project, 'instances', instance), project)) return row.uri;
        }
      } else if (id) {
        const root = path.join(storageDir, 'projects', id);
        if (await isRunning(root, id)) return row.uri;
        for (const workspace of await directories(path.join(root, 'workspaces'))) {
          if (/^[a-f0-9]{64}$/.test(workspace) && await isRunning(path.join(root, 'workspaces', workspace), id)) return row.uri;
        }
      }
      return undefined;
    }));
    for (const uri of batch) if (uri !== undefined) running.push(uri);
  }
  return running;
}
