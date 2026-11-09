import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { ROOT } from '../../scripts/distribution.mjs';

/**
 * 内核提交只取自检出本身：`config/upstream.json` 提供路径与上游版本号，
 * 不再固定提交。本地推进内核后无需同步任何锁文件，测试也总是针对当前检出的内核。
 */
export async function kernelLock(root = ROOT) {
  const lock = JSON.parse(await readFile(path.join(root, 'config/upstream.json'), 'utf8'));
  const directory = path.join(root, lock.path);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return { ...lock, commit, directory };
}
