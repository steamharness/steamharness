import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { loadTypebox } from "./pi";
import type { TypeboxLike } from "./tools";
import { fitTextPage, MAX_TOOL_PAGE_BYTES, pageInteger, splitsSurrogate } from "./result-pages";

/** The tool a project offers for discovering and reading its skills. */
export const SKILL_TOOL_NAME = "skill";

/** The file that makes a directory a skill, and the one read by default. */
export const SKILL_ENTRY_FILE = "SKILL.md";

/** Maximum characters requested in one read; larger files remain pageable. */
export const MAX_SKILL_FILE_CHARS = 200_000;

interface SkillActionArgs {
  action?: unknown;
  skill?: unknown;
  path?: unknown;
  offset?: unknown;
  limit?: unknown;
}

/** How many paths one skill may list before the listing says it stopped. */
export const MAX_SKILL_FILE_LISTING = 60;

export interface SkillToolOptions {
  /**
   * Roots to look for skills in, in priority order.
   *
   * A skill is a directory holding a `SKILL.md`; its frontmatter supplies the
   * name and the one-line description the model chooses it by. The first root
   * that has a given skill wins, so a project's own copy of a skill overrides
   * the one shipped beside it.
   */
  directories: readonly string[];
  /**
   * Consulted before a call runs. Throwing blocks it; throwing
   * `user_input_required` parks the run instead.
   */
  approve?: (toolId: string, args: unknown) => Promise<void>;
  /** Resolved TypeBox runtime, for tests. */
  Type?: TypeboxLike;
}

interface SkillEntry {
  name: string;
  description: string;
  directory: string;
}

/**
 * Returns one `skill` tool for discovering and reading written task guides.
 *
 * Call `{ action: "list" }` to discover names, descriptions and relative file
 * paths. Select a returned name, then call `{ action: "read", skill: name }`
 * for its SKILL.md. Read referenced files with the same action and a `path`
 * relative to that skill's directory. File listings and content carry explicit
 * truncation flags. Every tool call passes through `approve` when supplied.
 *
 * Reading makes instructions available to the agent; following their steps
 * uses the agent's other tools and those tools' permissions.
 */
export async function createSkillTools(options: SkillToolOptions): Promise<AgentTool[]> {
  const Type = options.Type ?? await loadTypebox();

  const tool = {
    name: SKILL_TOOL_NAME,
    label: "List and read skill guides",
    description: [
      "Discover and read the task guides in this project's configured skill directories.",
      '1. Call {"action":"list"} to get skill names, descriptions and relative file paths. Select a guide relevant to the user\'s task.',
      '2. Call {"action":"read","skill":"<listed name>"} to read that guide\'s SKILL.md before following its instructions.',
      '3. Read any needed reference with {"action":"read","skill":"<listed name>","path":"references/guide.md"}. Paths are relative to the selected skill directory.',
      `Results are JSON and fit within 40,000 UTF-8 bytes. list returns skills with files and filesTruncated (at most ${MAX_SKILL_FILE_LISTING} paths per skill). Continue a truncated catalog with offset=nextOffset. For filesTruncated, call list with that skill and offset=nextFileOffset, then continue with nextOffset. Long descriptions have descriptionTruncated=true; read SKILL.md for the full description.`,
      "read returns skill, path, content, offset, totalChars and truncated. If truncated is true, read the same skill and path with offset=nextOffset until truncated is false. Concatenate content in order to read the complete file. Do not repeat the first page or stop the task because a page has more content.",
      "This tool reads guide and script contents. Carry out instructed file edits, commands or other actions with the appropriate tools and their permissions.",
    ].join("\n"),
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "read"],
          description: '"list": discover available skill names, descriptions and files. "read": read one file from the named skill; start with SKILL.md, then read relevant references.',
        },
        skill: {
          type: "string",
          description: 'Required for "read": use the exact name returned by "list". For "list", optionally select one skill to page through all its file paths.',
        },
        path: {
          type: "string",
          description: `For "read": a file path relative to the selected skill directory, such as references/guide.md or scripts/check.mjs. Omit it to read ${SKILL_ENTRY_FILE}. The resolved file must remain inside that directory. Ignored by "list".`,
        },
        offset: {
          type: "integer", minimum: 0,
          description: "Zero-based offset, initially 0: characters for read, skills for list, or file paths for list with a skill. Continue with nextOffset.",
        },
        limit: {
          type: "integer", minimum: 1, maximum: MAX_SKILL_FILE_CHARS,
          description: "Maximum characters for read, or entries for list (up to 60). The serialized byte budget may return fewer.",
        },
      },
      required: ["action"],
    }),
    async execute(_toolCallId: string, params: unknown) {
      const args = (params ?? {}) as SkillActionArgs;
      await options.approve?.(SKILL_TOOL_NAME, args);
      const payload = await runSkillAction(options.directories, args);
      return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], details: {} };
    },
  } as unknown as AgentTool;

  return [tool];
}

/**
 * Lists the skills, or reads one file of one skill.
 *
 * Exported so a caller that reaches tools by name — an approval resumed after
 * the turn that raised it ended — can run the same action.
 */
export async function runSkillAction(
  directories: readonly string[],
  args: SkillActionArgs,
): Promise<unknown> {
  const offset = pageInteger(args.offset, 0, "skill offset", 0, Number.MAX_SAFE_INTEGER);
  const limit = pageInteger(args.limit, MAX_SKILL_FILE_CHARS, "skill limit", 1, MAX_SKILL_FILE_CHARS);
  if (args.action === "list") {
    const skills = await listSkills(directories);
    const wanted = typeof args.skill === "string" ? args.skill.trim() : "";
    if (wanted !== "") {
      const skill = requireSkill(skills, wanted);
      const listing = await listSkillFiles(skill.directory, offset, Math.min(limit, MAX_SKILL_FILE_LISTING));
      return { action: "list", skill: skill.name, offset, ...listing,
        truncated: listing.filesTruncated, ...(listing.filesTruncated ? { nextOffset: listing.nextFileOffset } : {}) };
    }
    if (offset > skills.length) throw new Error("skill offset is beyond the catalog.");
    const entries: unknown[] = [];
    const result = () => ({ action: "list", skills: entries, offset, totalSkills: skills.length,
      truncated: offset + entries.length < skills.length,
      ...(offset + entries.length < skills.length ? { nextOffset: offset + entries.length } : {}) });
    for (const skill of skills.slice(offset, offset + Math.min(limit, MAX_SKILL_FILE_LISTING))) {
      const description = skill.description.slice(0, splitsSurrogate(skill.description, 2000) ? 1999 : 2000);
      entries.push({ name: skill.name, description,
        ...(description.length < skill.description.length ? { descriptionTruncated: true } : {}),
        ...(await listSkillFiles(skill.directory, 0, MAX_SKILL_FILE_LISTING)) });
      if (Buffer.byteLength(JSON.stringify(result())) > MAX_TOOL_PAGE_BYTES) { entries.pop(); break; }
    }
    if (skills.length > offset && entries.length === 0) throw new Error("Skill metadata exceeds the page byte budget; shorten its name.");
    return result();
  }

  if (args.action === "read") {
    const skills = await listSkills(directories);
    const wanted = typeof args.skill === "string" ? args.skill.trim() : "";
    const skill = requireSkill(skills, wanted);
    const relative = typeof args.path === "string" && args.path.trim() !== ""
      ? args.path.trim()
      : SKILL_ENTRY_FILE;
    const content = await readSkillFile(skill.directory, relative);
    if (offset > content.length || splitsSurrogate(content, offset)) {
      throw new Error("skill offset must be within the file and at a complete character boundary.");
    }
    const base = {
      action: "read" as const,
      skill: skill.name,
      path: relative,
      offset,
      totalChars: content.length,
    };
    return fitTextPage(content, offset, limit, page => ({ ...base, ...page }));
  }

  throw new Error('skill action must be "list" or "read".');
}

async function listSkills(directories: readonly string[]): Promise<SkillEntry[]> {
  const skills = new Map<string, SkillEntry>();

  for (const root of directories) {
    for (const entry of await readDirectory(root)) {
      if (!entry.isDirectory()) continue;

      const directory = path.join(root, entry.name);
      const frontmatter = await readFrontmatter(path.join(directory, SKILL_ENTRY_FILE));
      if (frontmatter === undefined) continue;

      // First root wins: a project that ships its own copy of a skill means
      // that copy to be the one used.
      const name = frontmatter.name ?? entry.name;
      if (skills.has(name)) continue;
      skills.set(name, { name, description: frontmatter.description ?? "", directory });
    }
  }

  return [...skills.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function listSkillFiles(
  directory: string,
  offset: number,
  limit: number,
): Promise<{ files: string[]; filesTruncated: boolean; nextFileOffset?: number }> {
  const files: string[] = [];
  let seen = 0;
  await collect(directory, "");
  if (seen < offset) throw new Error("skill offset is beyond its file listing.");
  let count = Math.min(limit, files.length);
  // Keep a single skill small enough to fit in a catalog page, even with long paths.
  while (count > 1 && Buffer.byteLength(JSON.stringify(files.slice(0, count))) > 20_000) count--;
  const truncated = count < files.length;
  return { files: files.slice(0, count), filesTruncated: truncated,
    ...(truncated ? { nextFileOffset: offset + count } : {}) };

  async function collect(current: string, prefix: string): Promise<void> {
    // One past the cap: that extra entry is what makes truncation visible.
    if (files.length > limit) return;

    for (const entry of await readDirectory(current)) {
      if (files.length > limit) return;
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await collect(path.join(current, entry.name), relative);
      } else if (entry.isFile()) {
        if (seen++ >= offset) files.push(relative);
      }
    }
  }
}

async function readSkillFile(
  directory: string,
  relative: string,
): Promise<string> {
  const target = path.resolve(directory, relative);

  // The model chooses `path`, so this is the one place it could name its way
  // out of the skill. Both the lexical path and the real one are checked: a
  // symlink planted inside the directory would pass the first and fail the
  // second.
  if (!isInside(directory, target)) {
    throw new Error(`"${relative}" is outside the skill directory.`);
  }
  const realTarget = await resolveRealPath(target, relative);
  const realRoot = await realpath(directory);
  if (!isInside(realRoot, realTarget)) {
    throw new Error(`"${relative}" is outside the skill directory.`);
  }
  if (!(await stat(realTarget)).isFile()) {
    throw new Error(`"${relative}" is not a file.`);
  }

  return readFile(realTarget, "utf8");
}

function requireSkill(skills: SkillEntry[], wanted: string): SkillEntry {
  const skill = skills.find(entry => entry.name === wanted);
  if (skill !== undefined) return skill;
  const available = skills.map(entry => entry.name).join(", ");
  throw new Error(`Unknown skill "${wanted}". Available: ${available.slice(0, 4000) || "(none)"}.${available.length > 4000 ? ' Use action="list" to see more.' : ""}`);
}

async function resolveRealPath(target: string, relative: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    // A path that resolves nowhere is a typo, not an escape, and saying which
    // file was missing is more use than an ENOENT stack.
    throw new Error(`"${relative}" does not exist in the skill directory.`);
  }
}

function isInside(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  return target === resolvedRoot || target.startsWith(resolvedRoot + path.sep);
}

async function readDirectory(directory: string): Promise<import("node:fs").Dirent[]> {
  try {
    return (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  } catch {
    // A root that does not exist is simply a root with no skills in it.
    return [];
  }
}

/**
 * Reads the two frontmatter fields a skill is chosen by.
 *
 * Deliberately not a YAML parser: the block is a name and a description, and
 * a dependency that could express far more would be answering a question
 * nobody asked.
 */
async function readFrontmatter(
  file: string,
): Promise<{ name?: string; description?: string } | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return undefined;
  }

  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text);
  if (match === null) {
    // A directory with a SKILL.md but no frontmatter is still a skill; it just
    // has no description to offer until the model reads it.
    return {};
  }

  const fields: { name?: string; description?: string } = {};
  for (const line of match[1]!.split(/\r?\n/u)) {
    const field = /^(name|description):\s*(.*)$/u.exec(line.trim());
    if (field === null) continue;
    const value = field[2]!.trim().replace(/^["']|["']$/gu, "");
    if (value !== "") fields[field[1] as "name" | "description"] = value;
  }

  return fields;
}
