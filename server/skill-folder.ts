import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

/** One text file of a skill; `path` is relative to the skill root and uses "/" separators. */
export interface SkillText {
  path: string;
  content: string;
}

export interface SkillFolder {
  name: string;
  description: string;
  files: SkillText[];
}

export type SkillFolderErrorKind = "missing" | "no-skill-md" | "no-name" | "non-text" | "too-large" | "loop";

/** A skill folder that cannot be read as a skill. */
export class SkillFolderError extends Error {
  constructor(
    public readonly kind: SkillFolderErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "SkillFolderError";
  }
}

export const MAX_SKILL_FILES = 200;
export const MAX_SKILL_BYTES = 2 * 1024 * 1024;

const decoder = new TextDecoder("utf-8", { fatal: true });

/** Text means empty, or valid UTF-8 without a NUL byte. */
export function isText(buffer: Buffer): boolean {
  if (buffer.length === 0) return true;
  if (buffer.includes(0)) return false;
  try {
    decoder.decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function unquote(value: string): string {
  const first = value[0];
  if (value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)) return value.slice(1, -1);
  return value;
}

/** Reads `name` and `description` from a leading `---` frontmatter block of `key: value` lines. */
export function parseFrontmatter(markdown: string): { name?: string; description?: string } {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  const result: { name?: string; description?: string } = {};
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") return result;
    const match = /^(name|description):\s*(.*)$/.exec(line);
    if (match) result[match[1] as "name" | "description"] = unquote((match[2] ?? "").trim());
  }
  return {};
}

/** Order-independent sha256 (hex) over every file's path and content. */
export function contentHash(files: SkillText[]): string {
  const lines = files
    .map((file) => `${file.path}\0${createHash("sha256").update(file.content, "utf8").digest("hex")}\n`)
    .sort();
  return createHash("sha256").update(lines.join("")).digest("hex");
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/**
 * Reads a skill folder from disk, following symlinks.
 *
 * @throws {SkillFolderError} "missing" when `dir` does not exist, "loop" for a symlink cycle,
 *   "too-large" above MAX_SKILL_FILES or MAX_SKILL_BYTES, "non-text" for a file that is not
 *   text, "no-skill-md" without a root SKILL.md, "no-name" when its frontmatter has no name.
 */
export async function readSkillFolder(dir: string): Promise<SkillFolder> {
  const tooLarge = () =>
    new SkillFolderError(
      "too-large",
      `Skill folder ${dir} has more than ${MAX_SKILL_FILES} files or 2 MB; skills that large are not supported.`,
    );
  let rootReal: string;
  try {
    rootReal = await realpath(dir);
    if (!(await stat(rootReal)).isDirectory()) throw Object.assign(new Error("not a folder"), { code: "ENOENT" });
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
      throw new SkillFolderError("missing", `Skill folder ${dir} does not exist.`);
    }
    throw error;
  }

  const found: Array<{ relative: string; absolute: string }> = [];
  let bytes = 0;

  async function walk(absolute: string, relative: string, ancestors: Set<string>): Promise<void> {
    const entries = (await readdir(absolute)).sort();
    for (const entry of entries) {
      const childAbsolute = path.join(absolute, entry);
      const childRelative = relative ? `${relative}/${entry}` : entry;
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(childAbsolute);
      } catch (error) {
        if (errorCode(error) === "ENOENT" || errorCode(error) === "ELOOP") {
          if (errorCode(error) === "ELOOP") throw new SkillFolderError("loop", `Skill folder ${dir} has a symlink loop at ${childRelative}.`);
          continue; // dangling symlink
        }
        throw error;
      }
      if (info.isDirectory()) {
        const real = await realpath(childAbsolute);
        if (ancestors.has(real)) {
          throw new SkillFolderError("loop", `Skill folder ${dir} has a symlink loop at ${childRelative}.`);
        }
        await walk(childAbsolute, childRelative, new Set([...ancestors, real]));
      } else if (info.isFile()) {
        found.push({ relative: childRelative, absolute: childAbsolute });
        bytes += info.size;
        if (found.length > MAX_SKILL_FILES || bytes > MAX_SKILL_BYTES) throw tooLarge();
      }
    }
  }

  await walk(rootReal, "", new Set([rootReal]));

  const files: SkillText[] = [];
  for (const file of found) {
    const buffer = await readFile(file.absolute);
    if (!isText(buffer)) {
      throw new SkillFolderError("non-text", `${dir} is not importable: ${file.relative} is not a text file.`);
    }
    files.push({ path: file.relative, content: buffer.toString("utf8") });
  }

  const skillMd = files.find((file) => file.path === "SKILL.md");
  if (!skillMd) throw new SkillFolderError("no-skill-md", `${dir} has no SKILL.md.`);
  const { name, description } = parseFrontmatter(skillMd.content);
  if (!name) throw new SkillFolderError("no-name", `${dir}/SKILL.md has no name in its frontmatter.`);
  return { name, description: description ?? "", files };
}
