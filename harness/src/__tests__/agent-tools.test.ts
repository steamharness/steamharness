import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { createBuiltinAgentTools } from "../agent/tools";

async function fixture(run: (tools: ReturnType<typeof createBuiltinAgentTools>, directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-tool-pages-"));
  try { await run(createBuiltinAgentTools({ Type, scope: { workdir: directory, allowedDirectories: [directory] } }), directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("read reaches requested lines beyond 8 MiB and bounds a long UTF-8 line with recoverable byte offsets", async () => {
  await fixture(async (tools, directory) => {
    const read = tools.find(tool => tool.name === "read")!;
    await writeFile(path.join(directory, "big.log"), `${"x".repeat(999)}\n`.repeat(9000) + "TAIL");
    const tail = await read.execute("tail", { path: "big.log", offset: 9001, limit: 1 });
    assert.match(tail.content[0]!.type === "text" ? tail.content[0].text : "", /^9001\tTAIL/);
    assert.equal((tail.details as { truncated: boolean }).truncated, false);

    const original = `开始${"中文😀".repeat(15000)}END`;
    await writeFile(path.join(directory, "minified.json"), original);
    let byteOffset = 0, recovered = "", pages = 0;
    do {
      const page = await read.execute("page", { path: "minified.json", byteOffset });
      const text = page.content[0]!.type === "text" ? page.content[0].text : "";
      assert.ok(Buffer.byteLength(text) <= 40_000);
      assert.equal(Buffer.from(text).toString(), text);
      const details = page.details as { nextByteOffset?: number; truncated: boolean };
      recovered += details.truncated ? text.slice(0, text.indexOf("\n… (truncated")) : text;
      pages++;
      if (!details.truncated) break;
      assert.ok(details.nextByteOffset! > byteOffset); byteOffset = details.nextByteOffset!;
    } while (pages < 100);
    assert.ok(pages > 1); assert.equal(recovered, original);
    await assert.rejects(() => read.execute("split", { path: "minified.json", byteOffset: 1 }), /UTF-8 character boundary/);
    await assert.rejects(() => read.execute("mixed", { path: "minified.json", byteOffset: 0, offset: 1 }), /without offset/);
    await assert.rejects(() => read.execute("bounds", { path: "big.log", offset: 99999 }), /beyond end/);
  });
});

test("shell output reports byte truncation without corrupting UTF-8 and preserves timeout diagnostics", async () => {
  await fixture(async tools => {
    const bash = tools.find(tool => tool.name === "bash")!;
    const command = `"${process.execPath}" -e "process.stdout.write(String.fromCodePoint(0x1f600).repeat(20000))"`;
    const result = await bash.execute("unicode", { command });
    const text = result.content[0]!.type === "text" ? result.content[0].text : "";
    assert.ok(Buffer.byteLength(text) <= 40_000);
    assert.equal(Buffer.from(text).toString(), text);
    assert.match(text, /output truncated/);
    assert.equal((result.details as { truncated: boolean }).truncated, true);
    await assert.rejects(() => bash.execute("timeout", {
      command: command.replace('))"', '));setInterval(()=>{},10000)"'), timeout: 1000,
    }), error => {
      assert.match(String(error), /output truncated/);
      assert.match(String(error), /timed out/);
      return true;
    });
  });
});

test("a shell call with an already aborted signal never starts the command", async () => {
  await fixture(async (tools, directory) => {
    const bash = tools.find(tool => tool.name === "bash")!;
    const abort = new AbortController(); abort.abort();
    await assert.rejects(() => bash.execute("aborted", { command: `"${process.execPath}" -e "require('fs').writeFileSync('unexpected','ran')"` }, abort.signal), /abort/i);
    await assert.rejects(() => readFile(path.join(directory, "unexpected")), /ENOENT/);
  });
});

test("grep, find and ls report continuations instead of silently omitting matching entries", async () => {
  await fixture(async (tools, directory) => {
    await Promise.all(Array.from({ length: 5 }, (_, index) => writeFile(path.join(directory, `${index}.txt`), `match ${index}\n`)));
    for (const name of ["grep", "find", "ls"]) {
      const tool = tools.find(tool => tool.name === name)!;
      const params = name === "grep" ? { pattern: "match" } : name === "find" ? { query: ".txt" } : {};
      const results: string[] = [];
      let offset = 0;
      do {
        const page = await tool.execute("page", { ...params, limit: 2, offset });
        const text = page.content[0]!.type === "text" ? page.content[0].text : "";
        results.push(...text.split("\n").filter(line => !line.startsWith("…")));
        const details = page.details as { truncated: boolean; nextOffset?: number };
        if (!details.truncated) break;
        assert.ok(details.nextOffset! > offset); offset = details.nextOffset!;
      } while (offset < 10);
      assert.equal(results.length, 5); assert.equal(new Set(results).size, 5);
    }
    await writeFile(path.join(directory, "long.txt"), "match" + "中文😀".repeat(20_000));
    const page = await tools.find(tool => tool.name === "grep")!.execute("long", { pattern: "match", path: "long.txt" });
    const text = page.content[0]!.type === "text" ? page.content[0].text : "";
    assert.ok(Buffer.byteLength(text) <= 40_000); assert.match(text, /entry truncated; use read/);
  });
});
