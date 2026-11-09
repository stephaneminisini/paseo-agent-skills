import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SkillFile, SkillVersion } from "./langfuse";
import type { SkillText } from "./skill-folder";

export type SkillStoreErrorKind =
  | "unsafe-name"
  | "unsafe-path"
  | "duplicate-path"
  | "no-skill-md"
  | "non-text"
  | "hash-mismatch"
  | "path-conflict"
  | "version-mismatch"
  | "write-failed";

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
/** Written last into a local version folder; its presence marks the folder complete. */
export const LOCAL_MARKER_FILE = ".agent-skill.json";
const RESERVED_FILES = new Set([MANIFEST_FILE, LOCAL_MARKER_FILE]);

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
  if (segments.some(isUnsafeSegment) || RESERVED_FILES.has(filePath)) throw unsafe();
  const target = path.resolve(dir, ...segments);
  if (!target.startsWith(dir + path.sep)) throw unsafe();
  return target;
}

function sha256Base64(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("base64");
}

/**
 * Checks a skill's file paths: each stays inside `dir`, none repeats, none is both a file and a
 * folder, and SKILL.md is at the root. Returns each path's target in `dir`, in input order.
 *
 * @throws {SkillStoreError} kinds "unsafe-path", "duplicate-path", "path-conflict", "no-skill-md".
 */
export function checkSkillPaths(dir: string, paths: string[], label: string): string[] {
  const seen = new Set<string>();
  const targets = paths.map((filePath) => {
    const target = checkFilePath(dir, filePath);
    if (seen.has(target)) {
      throw new SkillStoreError("duplicate-path", `Skill ${label} lists ${filePath} twice.`);
    }
    seen.add(target);
    return target;
  });
  for (const target of seen) {
    if ([...seen].some((candidate) => candidate.startsWith(target + path.sep))) {
      throw new SkillStoreError(
        "path-conflict",
        `Skill ${label} uses ${path.relative(dir, target)} as both a file and a folder.`,
      );
    }
  }
  if (!seen.has(path.join(dir, SKILL_MD))) {
    throw new SkillStoreError("no-skill-md", `Skill ${label} has no SKILL.md.`);
  }
  return targets;
}

/** Validates every file before anything is written; returns each file's target path. */
function plan(dir: string, skill: SkillVersion): Array<{ file: SkillFile; target: string }> {
  const label = `${skill.name} v${skill.version}`;
  const targets = checkSkillPaths(
    dir,
    skill.files.map((file) => file.path),
    label,
  );
  return skill.files.map((file, index) => {
    if (!file.contentType.startsWith("text/")) {
      throw new SkillStoreError(
        "non-text",
        `Skill ${label} contains a non-text file (${file.path}, ${file.contentType}), which this plugin does not support yet.`,
      );
    }
    if (sha256Base64(file.content) !== file.sha256Hash) {
      throw new SkillStoreError("hash-mismatch", `Skill ${label} file ${file.path} does not match its hash.`);
    }
    return { file, target: targets[index] as string };
  });
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

/** In-flight stores by version folder, so overlapping searches share one download. */
const inFlight = new Map<string, Promise<{ dir: string; downloaded: boolean }>>();

/**
 * Makes sure one skill version is stored, downloading it through `load` only when missing.
 * Files go to a temporary sibling folder, then the folder is renamed into place, so a version
 * folder with a manifest is always complete and is never modified afterwards.
 *
 * @throws {SkillStoreError} when the name, a path, a content type, a hash or the downloaded
 *   version is not acceptable, or when writing the files fails ("write-failed").
 * @throws whatever `load` rejects with.
 */
export function ensureSkillVersion(
  root: string,
  ref: { name: string; version: number },
  load: () => Promise<SkillVersion>,
  meta: StoreMeta,
): Promise<{ dir: string; downloaded: boolean }> {
  let dir: string;
  try {
    dir = versionDir(root, ref.name, ref.version);
  } catch (error) {
    return Promise.reject(error);
  }
  const pending = inFlight.get(dir);
  if (pending) return pending.then(({ dir: stored }) => ({ dir: stored, downloaded: false }));
  const task = store(dir, ref, load, meta).finally(() => inFlight.delete(dir));
  inFlight.set(dir, task);
  return task;
}

async function store(
  dir: string,
  ref: { name: string; version: number },
  load: () => Promise<SkillVersion>,
  meta: StoreMeta,
): Promise<{ dir: string; downloaded: boolean }> {
  const manifestPath = path.join(dir, MANIFEST_FILE);
  if (await exists(manifestPath)) return { dir, downloaded: false };

  const skill = await load();
  if (skill.name !== ref.name || skill.version !== ref.version) {
    throw new SkillStoreError(
      "version-mismatch",
      `Asked Langfuse for ${ref.name} v${ref.version} but received ${skill.name} v${skill.version}.`,
    );
  }
  plan(dir, skill);
  const manifest = {
    name: skill.name,
    version: skill.version,
    baseUrl: meta.baseUrl,
    fetchedAt: (meta.now?.() ?? new Date()).toISOString(),
    files: skill.files.map(({ path: filePath, sha256Hash }) => ({ path: filePath, sha256Hash })),
  };
  const downloaded = await writeVersionFolder(dir, skill.files, {
    file: MANIFEST_FILE,
    content: `${JSON.stringify(manifest, null, 2)}\n`,
  });
  return { dir, downloaded };
}

/**
 * Writes `files` plus the completion marker `extra` into a temporary sibling of `dir`, then
 * renames it into place. Returns false when another writer completed `dir` first. Paths must
 * already be checked with {@link checkSkillPaths}.
 *
 * @throws {SkillStoreError} kind "write-failed" when writing or moving fails.
 */
export async function writeVersionFolder(
  dir: string,
  files: SkillText[],
  extra: { file: string; content: string },
): Promise<boolean> {
  const markerPath = path.join(dir, extra.file);
  if (await exists(markerPath)) return false;
  const tmpDir = `${dir}.tmp-${randomUUID()}`;
  try {
    try {
      for (const file of files) {
        const target = path.join(tmpDir, ...file.path.split("/"));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.content, "utf8");
      }
      await mkdir(tmpDir, { recursive: true });
      await writeFile(path.join(tmpDir, extra.file), extra.content, "utf8");
    } catch (error) {
      throw new SkillStoreError(
        "write-failed",
        `Could not store skill in ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return await moveIntoPlace(tmpDir, dir, markerPath);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

function isFolderTaken(error: unknown): boolean {
  const code = errorCode(error);
  return code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM";
}

/**
 * Renames the finished temp folder to `dir`. Returns false when another writer finished first.
 * A complete folder is never removed: only a folder without a manifest, left by an interrupted
 * write, is moved aside atomically and then deleted.
 */
async function moveIntoPlace(tmpDir: string, dir: string, manifestPath: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await rename(tmpDir, dir);
      return true;
    } catch (error) {
      if (!isFolderTaken(error)) throw error;
      if (await exists(manifestPath)) return false;
      const stale = `${dir}.stale-${randomUUID()}`;
      try {
        await rename(dir, stale);
      } catch (moveError) {
        if (errorCode(moveError) !== "ENOENT") throw moveError;
      }
      if (await exists(path.join(stale, MANIFEST_FILE))) {
        // Another writer completed between the check and the move: put its folder back.
        await rename(stale, dir).catch(() => undefined);
        if (await exists(manifestPath)) return false;
      }
      await rm(stale, { recursive: true, force: true });
    }
  }
  if (await exists(manifestPath)) return false;
  throw new SkillStoreError("write-failed", `Could not move the skill into ${dir}.`);
}
