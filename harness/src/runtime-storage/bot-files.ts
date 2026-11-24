import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";

export const BOT_FILE_AREAS = ["temp", "artifacts"] as const;
export type BotFileArea = typeof BOT_FILE_AREAS[number];
export const BOT_FILE_WRITE_LIMIT = 128 * 1024;
const READ_PAGE_BYTES = 16 * 1024;
const WRITE_PREFIX = ".steamharness-write-";

const isArea = (name: string): name is BotFileArea => (BOT_FILE_AREAS as readonly string[]).includes(name);
const hasCode = (error: unknown, code: string) => (error as NodeJS.ErrnoException | undefined)?.code === code;
const stat = (file: string) => fs.lstat(file).catch(error => { if (!hasCode(error, "ENOENT")) throw error; });
const fileMissing = () => new Error("This Bot file does not exist.");
const occupied = () => new Error("The destination already exists. Use a new name or explicitly request a text overwrite.");

function isPortableName(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value) <= 255 && !/[<>:"\\|?*\u0000-\u001f\u007f]|[. ]$/u.test(value)
    && !/^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[0-9\u00b2\u00b3\u00b9])(?: *\.|$)/iu.test(value)
    && !value.toLowerCase().startsWith(WRITE_PREFIX);
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(+date) && date.toISOString().startsWith(value);
}

function fileParts(ref: string, file: boolean): string[] {
  const parts = ref.split("/");
  if (ref.length > 1024 || parts.length > 24 || parts.some(part => !isPortableName(part)) || !isArea(parts[0]!)
    || (parts.length >= 2 && !isDate(parts[1]!)) || (file && parts.length < 3)) {
    throw new Error("Use a Bot-relative path such as temp/YYYY-MM-DD/report.txt or artifacts/YYYY-MM-DD/report.txt, without links or traversal.");
  }
  return parts;
}

function localDate(now: Date): string {
  return `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function assertRegularFile(info: Awaited<ReturnType<typeof stat>>) {
  if (!info) throw fileMissing();
  if (!info.isFile() || info.nlink !== 1) throw new Error("Bot file operations require a regular file without symbolic or hard links.");
  return info;
}

export type BotFileWorkspace = ReturnType<typeof createBotFileWorkspace>;

/** The caller owns the runtime root and the scope key; neither is supplied by a tool call. */
export function createBotFileWorkspace(runtimeRoot: string, scopeKey: string, clock = () => new Date()) {
  const base = path.resolve(runtimeRoot);
  const scope = ["bot-files", scopeKey];
  const root = path.join(base, ...scope);
  const locations = () => {
    const date = localDate(clock());
    return { root, date, temp: `temp/${date}`, artifacts: `artifacts/${date}` };
  };

  async function directory(parts: readonly string[], create = false): Promise<string | undefined> {
    if (create) await fs.mkdir(base, { recursive: true, mode: 0o700 });
    let current = base;
    // The host may configure its runtime root through an OS alias or a mount. The
    // managed descendants, including the scope itself, must be real directories.
    for (const name of [...scope, ...parts]) {
      current = path.join(current, name);
      if (create) await fs.mkdir(current, { mode: 0o700 }).catch(error => { if (!hasCode(error, "EEXIST")) throw error; });
      const info = await stat(current);
      if (!info) return;
      if (!info.isDirectory()) throw new Error("Bot file directories cannot be symbolic links or special files.");
    }
    return current;
  }

  async function target(ref: string, create = false) {
    const parts = fileParts(ref, true);
    const parent = await directory(parts.slice(0, -1), create);
    if (!parent) throw fileMissing();
    return path.join(parent, parts.at(-1)!);
  }

  return {
    async list(ref: string | undefined, offset: number, limit: number) {
      const parts = ref === undefined ? [] : fileParts(ref, false);
      const folder = await directory(parts);
      const entries = folder ? (await fs.readdir(folder, { withFileTypes: true }))
        .filter(item => isPortableName(item.name) && (item.isDirectory() || item.isFile()) &&
          (parts.length === 0 ? item.isDirectory() && isArea(item.name) : parts.length === 1 ? item.isDirectory() && isDate(item.name) : true))
        .sort((a, b) => a.name < b.name ? -1 : a.name === b.name ? 0 : 1) : [];
      return { ...locations(), path: ref ?? "", absolutePath: path.join(root, ...parts), exists: folder !== undefined,
        entries: entries.slice(offset, offset + limit).map(item => ({ name: item.name, kind: item.isDirectory() ? "directory" : "file" })),
        ...(offset + limit < entries.length ? { nextOffset: offset + limit } : {}) };
    },

    async read(ref: string, offset: number) {
      const file = await target(ref);
      const before = assertRegularFile(await stat(file));
      const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const info = assertRegularFile(await handle.stat());
        if (before.ino !== info.ino || before.dev !== info.dev) throw new Error("The file changed while opening. Try reading it again.");
        if (offset > info.size) throw new Error("byteOffset is past the end of the file.");
        const bytes = Buffer.alloc(Math.min(READ_PAGE_BYTES + 4, info.size - offset));
        let count = 0;
        while (count < bytes.length) {
          const { bytesRead } = await handle.read(bytes, count, bytes.length - count, offset + count);
          if (bytesRead === 0) break;
          count += bytesRead;
        }
        let end = Math.min(count, READ_PAGE_BYTES);
        if (count > end) while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
        const page = bytes.subarray(0, end);
        let text: string;
        try {
          if (page.includes(0)) throw new Error("Binary file.");
          text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(page);
        } catch { throw new Error("This is not a UTF-8 text page. For text offsets, use nextByteOffset from the previous page."); }
        return { path: ref, absolutePath: file, text, bytes: info.size,
          ...(count > end ? { nextByteOffset: offset + end } : {}) };
      } finally { await handle.close(); }
    },

    async snapshotArtifact(ref: string, maxBytes: number, signal?: AbortSignal) {
      if (!ref.startsWith("artifacts/")) throw new Error("Only files under artifacts can be delivered.");
      signal?.throwIfAborted();
      const file = await target(ref);
      const before = assertRegularFile(await stat(file));
      const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const opened = assertRegularFile(await handle.stat());
        if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("The file changed while opening it.");
        if (opened.size > maxBytes) throw new Error(`A delivered file must be at most ${maxBytes / 1024 / 1024} MiB.`);
        const bytes = Buffer.alloc(opened.size);
        let offset = 0;
        while (offset < bytes.length) {
          signal?.throwIfAborted();
          const { bytesRead } = await handle.read(bytes, offset, Math.min(bytes.length - offset, 1024 * 1024), offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        const after = await handle.stat();
        if (offset !== bytes.length || after.nlink !== 1 || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
          throw new Error("The file changed during delivery; try again when it is ready.");
        }
        signal?.throwIfAborted();
        return { name: path.basename(file), bytes };
      } finally { await handle.close(); }
    },

    async write(ref: string, text: string, overwrite: boolean) {
      const bytes = Buffer.byteLength(text);
      if (bytes > BOT_FILE_WRITE_LIMIT || text.includes("\0")) throw new Error("Write at most 128 KiB of UTF-8 text without NUL per file.");
      const file = await target(ref, true);
      const previous = await stat(file);
      if (previous && !overwrite) throw occupied();
      if (previous) assertRegularFile(previous);
      const staging = path.join(path.dirname(file), `${WRITE_PREFIX}${randomUUID()}`);
      const handle = await fs.open(staging, "wx", 0o600);
      try {
        try { await handle.writeFile(text, "utf-8"); } finally { await handle.close(); }
        if (previous) await fs.rename(staging, file);
        else await fs.link(staging, file).catch(error => { if (hasCode(error, "EEXIST")) throw occupied(); throw error; });
      } finally { await fs.unlink(staging).catch(error => { if (!hasCode(error, "ENOENT")) throw error; }); }
      return { path: ref, absolutePath: file, bytes };
    },

    async move(source: string, destination: string) {
      fileParts(destination, true);
      const file = await target(source);
      const before = assertRegularFile(await stat(file));
      const next = await target(destination, true);
      // A same-store link publishes a complete file without ever replacing an existing destination.
      await fs.link(file, next).catch(error => { if (hasCode(error, "EEXIST")) throw occupied(); throw error; });
      const linked = await stat(next);
      const current = await stat(file);
      const sameFile = (info: Awaited<ReturnType<typeof stat>>) => info?.ino === before.ino && info.dev === before.dev;
      if (!sameFile(linked) || (current && !sameFile(current))) {
        await fs.unlink(next);
        throw new Error("The source changed while moving it. Try again.");
      }
      await fs.unlink(file).catch(error => {
        if (!hasCode(error, "ENOENT")) throw error;
      });
      return { path: destination, absolutePath: next };
    },

    async delete(ref: string) {
      const file = await target(ref);
      assertRegularFile(await stat(file));
      await fs.unlink(file);
      return { path: ref, deleted: true };
    },

    async shell() {
      const { date } = locations();
      const temp = (await directory(["temp", date], true))!;
      const artifacts = (await directory(["artifacts", date], true))!;
      return { temp, artifacts };
    },
  };
}
