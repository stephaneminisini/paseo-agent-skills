import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SkillFile, SkillVersion } from "./langfuse";

export type SkillStoreErrorKind =
  | "unsafe-name"
  | "unsafe-path"
  | "duplicate-path"
  | "no-skill-md"
  | "non-text"
  | "hash-mismatch";

/** A skill version that cannot be stored safely. Nothing is written when this is thrown. */
export class SkillStoreError extends Error {
  constructor(
    public readonly kind: SkillStoreErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "SkillStoreError";
  }
}

/** Written last into a version folder; its presence marks the folder complete. */
export const MANIFEST_FILE = ".langfuse-skill.json";

export interface StoreMeta {
  baseUrl: string;
  now?: () => Date;
}

const SKILL_MD = "SKILL.md";

function isUnsafeSegment(segment: string): boolean {
  return segment === "" || segment === "." || segment === ".." || segment.includes("\0");
}

/**
 * The folder holding one skill version: `<root>/<name segments...>/v<version>`.
 *
 * @throws {SkillStoreError} kind "unsafe-name" for a name with an empty, `.` or `..` segment, a
 *   backslash or NUL, or a version that is not a positive integer.
 */
export function versionDir(root: string, name: string, version: number): string {
  const segments = name.split("/");
  if (name.includes("\\") || segments.some(isUnsafeSegment)) {
    throw new SkillStoreError("unsafe-name", `Skill name ${JSON.stringify(name)} is not a safe folder name.`);
  }
  if (!Number.isInteger(version) || version < 1) {
    throw new SkillStoreError("unsafe-name", `Skill ${name} has an invalid version ${version}.`);
  }
  return path.join(root, ...segments, `v${version}`);
}

function checkFilePath(dir: string, filePath: string): string {
  const unsafe = () =>
    new SkillStoreError("unsafe-path", `Skill file path ${JSON.stringify(filePath)} is not allowed.`);
  if (filePath.length === 0 || /^[/\\]/.test(filePath) || /^[A-Za-z]:/.test(filePath)) throw unsafe();
  const segments = filePath.split(/[/\\]/);
  if (segments.some(isUnsafeSegment) || filePath === MANIFEST_FILE) throw unsafe();
  const target = path.resolve(dir, ...segments);
  if (!target.startsWith(dir + path.sep)) throw unsafe();
  return target;
}

function sha256Base64(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("base64");
}

/** Validates every file before anything is written; returns each file's target path. */
function plan(dir: string, skill: SkillVersion): Array<{ file: SkillFile; target: string }> {
  const seen = new Set<string>();
  const entries = skill.files.map((file) => {
    const target = checkFilePath(dir, file.path);
    if (seen.has(target)) {
      throw new SkillStoreError("duplicate-path", `Skill ${skill.name} lists ${file.path} twice.`);
    }
    seen.add(target);
    if (!file.contentType.startsWith("text/")) {
      throw new SkillStoreError(
        "non-text",
        `Skill ${skill.name} v${skill.version} contains a non-text file (${file.path}, ${file.contentType}), which this plugin does not support yet.`,
      );
    }
    if (sha256Base64(file.content) !== file.sha256Hash) {
      throw new SkillStoreError(
        "hash-mismatch",
        `Skill ${skill.name} v${skill.version} file ${file.path} does not match its hash.`,
      );
    }
    return { file, target };
  });
  if (!seen.has(path.join(dir, SKILL_MD))) {
    throw new SkillStoreError("no-skill-md", `Skill ${skill.name} v${skill.version} has no SKILL.md.`);
  }
  return entries;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/**
 * Makes sure one skill version is stored, downloading it through `load` only when missing.
 * Files go to a temporary sibling folder, then the folder is renamed into place, so a version
 * folder with a manifest is always complete and is never modified afterwards.
 *
 * @throws {SkillStoreError} when the name, a path, a content type or a hash is not acceptable.
 * @throws whatever `load` rejects with, and filesystem errors other than losing a rename race.
 */
export async function ensureSkillVersion(
  root: string,
  ref: { name: string; version: number },
  load: () => Promise<SkillVersion>,
  meta: StoreMeta,
): Promise<{ dir: string; downloaded: boolean }> {
  const dir = versionDir(root, ref.name, ref.version);
  const manifestPath = path.join(dir, MANIFEST_FILE);
  if (await exists(manifestPath)) return { dir, downloaded: false };

  const skill = await load();
  const tmpDir = `${dir}.tmp-${randomUUID()}`;
  const entries = plan(tmpDir, skill);
  try {
    for (const { file, target } of entries) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf8");
    }
    const manifest = {
      name: skill.name,
      version: skill.version,
      baseUrl: meta.baseUrl,
      fetchedAt: (meta.now?.() ?? new Date()).toISOString(),
      files: skill.files.map(({ path: filePath, sha256Hash }) => ({ path: filePath, sha256Hash })),
    };
    await writeFile(path.join(tmpDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    if (await exists(manifestPath)) {
      await rm(tmpDir, { recursive: true, force: true });
      return { dir, downloaded: false };
    }
    // A folder without a manifest is left from an interrupted write outside this plugin's
    // rename; replace it.
    if (await exists(dir)) await rm(dir, { recursive: true, force: true });
    try {
      await rename(tmpDir, dir);
    } catch (error) {
      const code = errorCode(error);
      if ((code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM") && (await exists(manifestPath))) {
        await rm(tmpDir, { recursive: true, force: true });
        return { dir, downloaded: false };
      }
      throw error;
    }
    return { dir, downloaded: true };
  } catch (error) {
    await rm(tmpDir, { recursive: true, force: true });
    throw error;
  }
}
