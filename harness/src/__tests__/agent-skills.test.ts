import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_SKILL_FILE_CHARS,
  MAX_SKILL_FILE_LISTING,
  SKILL_TOOL_NAME,
  createSkillTools,
  runSkillAction,
  listAgentSkillGuides,
  readAgentSkillGuide,
} from "../agent/skills";

const SKILL_DOCUMENT = [
  "---",
  "name: alpha",
  "description: 处理 alpha 类任务。",
  "---",
  "",
  "# Alpha",
  "",
  "Read `references/guide.md` before starting.",
  "",
].join("\n");

test("host catalogs include every project guide and distinct built-in guides, with complete safe entry previews", async () => {
  await withSkillRoots(async ({ first, second }) => {
    for (let i = 0; i < 70; i++) {
      const directory = path.join(first, `guide-${i}`); await mkdir(directory);
      await writeFile(path.join(directory, "SKILL.md"), `---\nname: guide-${i}\ndescription: ${"详细说明".repeat(700)}\n---\n# Guide ${i}`);
    }
    const full = `---\nname: i-have-adhd\ndescription: Project override\n---\n${"完整内容😀".repeat(50_000)}\nEND`;
    for (const root of [first, second]) await mkdir(path.join(root, "communication"));
    await writeFile(path.join(first, "communication/SKILL.md"), full);
    await writeFile(path.join(second, "communication/SKILL.md"), "---\nname: i-have-adhd\n---\nWrong precedence");
    const guides = await listAgentSkillGuides([first, second]);
    assert.equal(guides.length, 73);
    assert.match((await readAgentSkillGuide([], "builtin:steamharness-memory")).content, /# Account memory/u);
    assert.equal(guides.filter(guide => guide.name === "i-have-adhd").length, 2);
    assert.equal(guides.find(guide => guide.name === "guide-0")?.description.length, 2800);
    assert.equal(JSON.stringify(guides).includes(first), false);
    assert.equal((await readAgentSkillGuide([first, second], "project:i-have-adhd")).content, full);
    assert.match((await readAgentSkillGuide([first], "builtin:i-have-adhd")).content, /name: i-have-adhd/u);
    await assert.rejects(() => readAgentSkillGuide([first], "project:../../package.json"), /no longer available/u);
    const outside = path.join(second, "outside.md"); await writeFile(outside, "outside");
    await mkdir(path.join(first, "escape"));
    await symlink(outside, path.join(first, "escape/SKILL.md"), process.platform === "win32" ? "file" : undefined);
    await assert.rejects(() => readAgentSkillGuide([first], "project:escape"), /outside/u);
  });
});

async function withSkillRoots(
  build: (roots: { first: string; second: string }) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(path.join(os.tmpdir(), "workflow-skills-"));
  const first = path.join(base, "first");
  const second = path.join(base, "second");
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });

  try {
    await build({ first, second });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test("a skill is a directory holding a SKILL.md, named by its frontmatter", async () => {
  await withSkillRoots(async ({ first }) => {
    await writeSkill(first, "alpha", SKILL_DOCUMENT);
    await writeFileAt(first, "alpha/references/guide.md", "步骤一。\n");

    // A SKILL.md without frontmatter is still a skill; it just takes its
    // directory name, so the model sees it before it has read anything.
    await writeSkill(first, "beta", "# Beta\n\n没有 frontmatter。\n");
    // No SKILL.md at all means no skill.
    await writeFileAt(first, "notes/readme.md", "not a skill\n");

    const listed = await runSkillAction([first], { action: "list" }) as {
      skills: { name: string; description: string; files: string[]; filesTruncated: boolean }[];
    };

    assert.deepEqual(listed.skills.map((skill) => skill.name), ["alpha", "beta"]);
    assert.equal(listed.skills[0]?.description, "处理 alpha 类任务。");
    assert.equal(listed.skills[1]?.description, "");
    assert.deepEqual(listed.skills[0]?.files, ["SKILL.md", "references/guide.md"]);
    assert.equal(listed.skills[0]?.filesTruncated, false);
  });
});

test("a listing cut short says so", async () => {
  await withSkillRoots(async ({ first }) => {
    await writeSkill(first, "alpha", SKILL_DOCUMENT);
    await Promise.all(
      Array.from({ length: MAX_SKILL_FILE_LISTING + 5 }, (_value, index) =>
        writeFileAt(first, `alpha/references/page-${String(index).padStart(3, "0")}.md`, "x")),
    );

    const listed = await runSkillAction([first], { action: "list" }) as {
      skills: { files: string[]; filesTruncated: boolean }[];
    };

    // A cut list the model cannot tell was cut reads as "that is all of it".
    assert.equal(listed.skills[0]?.files.length, MAX_SKILL_FILE_LISTING);
    assert.equal(listed.skills[0]?.filesTruncated, true);
  });
});

test("the first root wins when two roots offer the same skill", async () => {
  await withSkillRoots(async ({ first, second }) => {
    await writeSkill(first, "alpha", SKILL_DOCUMENT);
    await writeSkill(second, "alpha", "---\nname: alpha\ndescription: 另一个 alpha。\n---\n");

    const listed = await runSkillAction([first, second], { action: "list" }) as {
      skills: { name: string; description: string }[];
    };
    assert.deepEqual(listed.skills, [{
      name: "alpha",
      description: "处理 alpha 类任务。",
      files: ["SKILL.md"],
      filesTruncated: false,
    }]);

    // A root that does not exist is a root with no skills in it, not an error.
    assert.deepEqual(await runSkillAction([path.join(first, "missing"), second], { action: "list" }), {
      action: "list",
      skills: [{ name: "alpha", description: "另一个 alpha。", files: ["SKILL.md"], filesTruncated: false }],
      offset: 0, totalSkills: 1, truncated: false,
    });
  });
});

test("skill catalogs and file listings can be fully read without exceeding the JSON byte budget", async () => {
  await withSkillRoots(async ({ first }) => {
    await Promise.all(Array.from({ length: 30 }, (_, index) => writeSkill(first, `skill-${String(index).padStart(2, "0")}`,
      `---\ndescription: ${'中文😀"\\'.repeat(1000)}\n---\n`)));
    const names: string[] = [];
    let offset = 0, pages = 0;
    do {
      const page = await runSkillAction([first], { action: "list", offset }) as {
        skills: { name: string; descriptionTruncated: boolean }[]; nextOffset?: number;
      };
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 40_000);
      assert.ok(page.skills.every(skill => skill.descriptionTruncated));
      names.push(...page.skills.map(skill => skill.name)); pages++;
      if (page.nextOffset === undefined) break;
      assert.ok(page.nextOffset > offset); offset = page.nextOffset;
    } while (pages < 40);
    assert.equal(names.length, 30); assert.equal(new Set(names).size, 30); assert.ok(pages > 1);

    const skill = names[0]!;
    await Promise.all(Array.from({ length: 130 }, (_, index) => writeFileAt(first,
      `${skill}/references/${"子".repeat(60)}/${"层".repeat(60)}/${String(index).padStart(3, "0")}-${"长路径".repeat(20)}.md`, "tail")));
    const files: string[] = []; offset = 0; pages = 0;
    do {
      const page = await runSkillAction([first], { action: "list", skill, offset }) as { files: string[]; nextOffset?: number };
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 40_000);
      files.push(...page.files); pages++;
      if (page.nextOffset === undefined) break;
      assert.ok(page.nextOffset > offset); offset = page.nextOffset;
    } while (pages < 30);
    assert.equal(files.length, 131); assert.equal(new Set(files).size, 131); assert.ok(pages > 2);
    await assert.rejects(() => runSkillAction([first], { action: "list", skill, offset: 999 }), /beyond/);
    await assert.rejects(() => runSkillAction([first], { action: "list", offset: 999 }), /beyond/);
  });
});

test("read defaults to the entry file and can name any file inside the skill", async () => {
  await withSkillRoots(async ({ first }) => {
    await writeSkill(first, "alpha", SKILL_DOCUMENT);
    await mkdir(path.join(first, "alpha", "references"), { recursive: true });
    await writeFile(path.join(first, "alpha", "references", "guide.md"), "步骤一。\n");

    assert.deepEqual(await runSkillAction([first], { action: "read", skill: "alpha" }), {
      action: "read",
      skill: "alpha",
      path: "SKILL.md",
      content: SKILL_DOCUMENT,
      offset: 0,
      totalChars: SKILL_DOCUMENT.length,
      truncated: false,
    });

    const guide = await runSkillAction([first], {
      action: "read",
      skill: "alpha",
      path: "references/guide.md",
    }) as { content: string };
    assert.equal(guide.content, "步骤一。\n");
  });
});

test("read cannot leave the skill directory", async () => {
  await withSkillRoots(async ({ first }) => {
    await writeSkill(first, "alpha", SKILL_DOCUMENT);
    await writeFile(path.join(first, "outside.md"), "secret\n");

    for (const escape of [
      "../outside.md",
      path.join("references", "..", "..", "outside.md"),
      path.join(first, "outside.md"),
      "/etc/hosts",
    ]) {
      await assert.rejects(
        () => runSkillAction([first], { action: "read", skill: "alpha", path: escape }),
        /outside the skill directory/u,
        `expected "${escape}" to be refused`,
      );
    }

    // A symlink planted inside the directory is caught by the realpath check
    // rather than by the lexical one, which it passes.
    await symlink(path.join(first, "outside.md"), path.join(first, "alpha", "link.md"));
    await assert.rejects(
      () => runSkillAction([first], { action: "read", skill: "alpha", path: "link.md" }),
      /outside the skill directory/u,
    );

    // A directory is not a file, and saying so beats an EISDIR.
    await mkdir(path.join(first, "alpha", "references"), { recursive: true });
    await assert.rejects(
      () => runSkillAction([first], { action: "read", skill: "alpha", path: "references" }),
      /is not a file/u,
    );

    // A path that resolves nowhere says which file was missing.
    await assert.rejects(
      () => runSkillAction([first], { action: "read", skill: "alpha", path: "nope.md" }),
      /"nope\.md" does not exist/u,
    );
  });
});

test("an unknown skill or action names what was available", async () => {
  await withSkillRoots(async ({ first }) => {
    await writeSkill(first, "alpha", SKILL_DOCUMENT);

    await assert.rejects(
      () => runSkillAction([first], { action: "read", skill: "beta" }),
      /Unknown skill "beta"\. Available: alpha\./u,
    );
    await assert.rejects(
      () => runSkillAction([first], { action: "frobnicate" }),
      /must be "list" or "read"/u,
    );
  });
});

test("large UTF-8 and escaped files can be reconstructed from bounded JSON pages", async () => {
  await withSkillRoots(async ({ first }) => {
    const original = `---\nname: big\n---\n${'中文😀\n"\\\u0001'.repeat(30_000)}END`;
    assert.ok(original.length > MAX_SKILL_FILE_CHARS);
    await writeSkill(first, "big", original);
    let offset = 0, reconstructed = "", pages = 0;
    do {
      const page = await runSkillAction([first], { action: "read", skill: "big", offset }) as {
        content: string; truncated: boolean; offset: number; nextOffset?: number; totalChars: number;
      };
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 40_000);
      assert.equal(page.offset, offset);
      assert.equal(page.totalChars, original.length);
      assert.equal(Buffer.from(page.content).toString(), page.content, "page must not split a surrogate pair");
      reconstructed += page.content; pages++;
      if (!page.truncated) { assert.equal(page.nextOffset, undefined); break; }
      assert.equal(page.nextOffset, offset + page.content.length);
      assert.ok(page.nextOffset! > offset);
      offset = page.nextOffset!;
    } while (pages < 100);
    assert.ok(pages > 1);
    assert.equal(reconstructed, original);
    const end = await runSkillAction([first], { action: "read", skill: "big", offset: original.length }) as { content: string; truncated: boolean };
    assert.equal(end.content, ""); assert.equal(end.truncated, false);
  });
});

test("skill read validates page bounds and permits smaller recovery pages", async () => {
  await withSkillRoots(async ({ first }) => {
    await writeSkill(first, "alpha", "😀abcdef");
    for (const args of [{ offset: -1 }, { offset: 0.5 }, { offset: "2" }, { offset: 99 }, { offset: 1 },
      { limit: 0 }, { limit: MAX_SKILL_FILE_CHARS + 1 }, { limit: "1" }, { limit: 1 }]) {
      await assert.rejects(() => runSkillAction([first], { action: "read", skill: "alpha", ...args }), /offset|limit/u);
    }
    const page = await runSkillAction([first], { action: "read", skill: "alpha", limit: 2 }) as { content: string; nextOffset: number };
    assert.equal(page.content, "😀"); assert.equal(page.nextOffset, 2);
    const tail = await runSkillAction([first], { action: "read", skill: "alpha", offset: page.nextOffset, limit: 3 }) as { content: string; nextOffset: number };
    assert.equal(tail.content, "abc"); assert.equal(tail.nextOffset, 5);
  });
});

test("the tool is one approval-gated `skill` tool", async () => {
  await withSkillRoots(async ({ first }) => {
    await writeSkill(first, "alpha", SKILL_DOCUMENT);

    const approvals: string[] = [];
    const tools = await createSkillTools({
      directories: [first],
      approve: async (toolId) => {
        approvals.push(toolId);
      },
    });

    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.name, SKILL_TOOL_NAME);

    const tool = tools[0] as unknown as {
      parameters: { properties: { action: { enum: string[] } } };
      execute(id: string, params: unknown): Promise<{ content: { text: string }[] }>;
    };
    assert.deepEqual(tool.parameters.properties.action.enum, ["list", "read"]);

    const result = await tool.execute("call-1", { action: "list" });
    assert.deepEqual(approvals, [SKILL_TOOL_NAME]);
    assert.deepEqual(
      (JSON.parse(result.content[0]!.text) as { skills: { name: string }[] }).skills.map((s) => s.name),
      ["alpha"],
    );

    await assert.rejects(() => tool.execute("call-2", { action: "read", skill: "nope" }), /Unknown skill/u);
  });
});

async function writeSkill(root: string, name: string, content: string): Promise<void> {
  await writeFileAt(root, `${name}/SKILL.md`, content);
}

async function writeFileAt(root: string, relative: string, content: string): Promise<void> {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}
