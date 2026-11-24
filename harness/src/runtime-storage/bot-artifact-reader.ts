import { execFile } from 'node:child_process';

// cwd is process-wide. Traverse in a dedicated reader so each relative lookup
// starts from the previous directory inode, not from a mutable absolute path.
const reader = String.raw`
const fs = require('node:fs');
const [limit, ...parts] = process.argv.slice(1);
const name = parts.pop();
const stat = path => fs.lstatSync(path, { bigint: true });
const same = (a,b) => a.dev === b.dev && a.ino === b.ino;
const fail = code => { throw Object.assign(new Error(), { exitCode: code }); };
try {
  for (const part of parts) {
    const before = stat(part);
    if (!before.isDirectory()) fail(3);
    process.chdir(part);
    if (!same(before, stat('.'))) fail(4);
  }
  const before = stat(name);
  if (!before.isFile() || before.nlink !== 1n) fail(3);
  const c = fs.constants;
  const fd = fs.openSync(name, c.O_RDONLY | (c.O_NOFOLLOW ?? 0) | (c.O_NONBLOCK ?? 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n) fail(3);
    if (!same(before, opened)) fail(4);
    if (opened.size > BigInt(limit)) fail(5);
    const bytes = Buffer.alloc(Number(opened.size));
    let n = 0;
    while (n < bytes.length) {
      const count = fs.readSync(fd, bytes, n, bytes.length - n, n);
      if (!count) fail(4);
      n += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (after.nlink !== 1n || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) fail(4);
    process.stdout.write(bytes);
  } finally { fs.closeSync(fd); }
} catch (error) { process.exitCode = error.exitCode ?? (error.code === 'ENOENT' ? 2 : 4); }
`;

export async function readBotArtifactSnapshot(root: string, parts: string[], maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  return new Promise<Buffer>((resolve, reject) => {
    execFile(process.execPath, ['--input-type=commonjs', '-e', reader, '--', String(maxBytes), ...parts], {
      cwd: root, encoding: 'buffer', maxBuffer: maxBytes + 1024, windowsHide: true, signal,
      env: { ...(process.env.SystemRoot && { SystemRoot: process.env.SystemRoot }), ELECTRON_RUN_AS_NODE: '1' },
    }, (error, bytes) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      if (!error) { resolve(bytes); return; }
      const message = error.code === 2 || error.code === 'ENOENT' ? 'This Bot file does not exist.'
        : error.code === 3 ? 'Bot file operations require a regular file without symbolic or hard links.'
        : error.code === 5 ? `A delivered file must be at most ${maxBytes / 1024 / 1024} MiB.`
        : 'The file changed while opening or reading it.';
      reject(new Error(message));
    });
  });
}
