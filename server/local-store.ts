import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  contentHash,
  isText,
  MAX_SKILL_BYTES,
  MAX_SKILL_FILES,
  parseFrontmatter,
  readSkillFolder,
  SkillFolderError,
  type SkillText,
} from "./skill-folder";
import { checkSkillPaths, LOCAL_MARKER_FILE, SkillStoreError, writeVersionFolder } from "./skill-store";

export type SkillSource =
  | { kind: "path"; path: string }
  | { kind: "claude-plugin"; marketplace: string; plugin: string; skill: string };

export interface SyncBase {
  version: number;
  hash: string;
}

export interface LocalSkill {
  name: string;
  description: string;
  version: number;
  updatedAt: string;
  source: SkillSource | null;
  sourceHash: string | null;
  /** contentHash of the current version's files. */
  hash: string;
  /** Langfuse version and hash this copy was last synced from or with. */
  syncBase: SyncBase | null;
  /** Paths that came from outside the skill folder through symlinks at import. */
  externalPaths: string[];
  /** Folder of the current version. */
  dir: string;
}

export type LocalStoreErrorKind = "name-mismatch" | "changed-elsewhere" | "unsafe-name";

/** A local save that is not allowed. */
export class LocalStoreError extends Error {
  constructor(
    public readonly kind: LocalStoreErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "LocalStoreError";
  }
}

export interface SaveInput {
  name: string;
  files: SkillText[];
  /** Omitted keeps the existing source; null clears it. */
  source?: SkillSource | null;
  sourceHash?: string | null;
  /** Omitted keeps the current sync base. */
  syncBase?: SyncBase | null;
  /** Omitted keeps the current external paths that are still in `files`. */
  externalPaths?: string[];
  /** Refuse the save unless the current version is this one. */
  expectedVersion?: number;
}

export interface LocalStore {
  list(): Promise<LocalSkill[]>;
  get(name: string): Promise<LocalSkill | null>;
  save(input: SaveInput): Promise<LocalSkill>;
  /** Records the Langfuse sync base without creating a version. */
  setSyncBase(name: string, base: SyncBase): Promise<LocalSkill>;
  /** Removes the skill from the list; its version folders stay for agents still using them. */
  remove(name: string): Promise<void>;
}

const RECORD_FILE = "skill.json";

const SourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("path"), path: z.string() }),
  z.object({ kind: z.literal("claude-plugin"), marketplace: z.string(), plugin: z.string(), skill: z.string() }),
]);
const RecordSchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.number().int().positive(),
  updatedAt: z.string(),
  source: SourceSchema.nullable(),
  sourceHash: z.string().nullable(),
  // Added in phase 3; older records lack them.
  hash: z.string().optional(),
  syncBase: z.object({ version: z.number(), hash: z.string() }).nullable().optional(),
  externalPaths: z.array(z.string()).optional(),
});
type SkillRecord = z.infer<typeof RecordSchema>;

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/**
 * Versioned skills kept on this host. Each save writes the next version folder
 * (`<root>/<encoded name>/v<n>/`) and never modifies earlier ones.
 */
export function createLocalStore(options: { root: string; now?: () => Date }): LocalStore {
  const { root } = options;
  const now = options.now ?? (() => new Date());
  const queues = new Map<string, Promise<unknown>>();

  function skillDir(name: string): string {
    if (name.length === 0 || name === "." || name === ".." || name.includes("\0")) {
      throw new LocalStoreError("unsafe-name", `Skill name ${JSON.stringify(name)} is not allowed.`);
    }
    return path.join(root, encodeURIComponent(name));
  }

  async function toSkill(record: SkillRecord): Promise<LocalSkill> {
    const dir = path.join(skillDir(record.name), `v${record.version}`);
    let hash = record.hash;
    if (hash === undefined) {
      try {
        hash = contentHash((await readSkillFolder(dir, { ignore: [LOCAL_MARKER_FILE] })).files);
      } catch {
        hash = "";
      }
    }
    return {
      name: record.name,
      description: record.description,
      version: record.version,
      updatedAt: record.updatedAt,
      source: record.source,
      sourceHash: record.sourceHash,
      hash,
      syncBase: record.syncBase ?? null,
      externalPaths: record.externalPaths ?? [],
      dir,
    };
  }

  async function readRecord(folder: string): Promise<SkillRecord | null> {
    let raw: string;
    try {
      raw = await readFile(path.join(folder, RECORD_FILE), "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
    try {
      return RecordSchema.parse(JSON.parse(raw));
    } catch (error) {
      console.error("[agent-skills] Skipping unreadable local skill record", {
        folder,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async function writeRecord(folder: string, record: SkillRecord): Promise<void> {
    const target = path.join(folder, RECORD_FILE);
    const tmp = `${target}.tmp-${randomUUID()}`;
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await rename(tmp, target);
  }

  function validate(input: SaveInput, versionFolder: string): string {
    checkSkillPaths(
      versionFolder,
      input.files.map((file) => file.path),
      input.name,
    );
    const bytes = input.files.reduce((total, file) => total + Buffer.byteLength(file.content, "utf8"), 0);
    if (input.files.length > MAX_SKILL_FILES || bytes > MAX_SKILL_BYTES) {
      throw new SkillFolderError(
        "too-large",
        `Skill ${input.name} has more than ${MAX_SKILL_FILES} files or 2 MB; skills that large are not supported.`,
      );
    }
    for (const file of input.files) {
      if (!isText(Buffer.from(file.content, "utf8"))) {
        throw new SkillStoreError("non-text", `Skill ${input.name}: ${file.path} is not a text file.`);
      }
    }
    const skillMd = input.files.find((file) => file.path === "SKILL.md");
    const { name, description } = parseFrontmatter(skillMd?.content ?? "");
    if (name !== input.name) {
      throw new LocalStoreError(
        "name-mismatch",
        `SKILL.md says "${name ?? ""}" but the skill is "${input.name}". Renaming means creating a new skill.`,
      );
    }
    return description ?? "";
  }

  async function saveNow(input: SaveInput): Promise<LocalSkill> {
    const folder = skillDir(input.name);
    const current = await readRecord(folder);
    let version = (current?.version ?? 0) + 1;
    const description = validate(input, path.join(folder, `v${version}`));
    if (input.expectedVersion !== undefined && input.expectedVersion !== (current?.version ?? 0)) {
      throw new LocalStoreError("changed-elsewhere", "This skill was changed elsewhere; reload.");
    }
    await mkdir(folder, { recursive: true });
    // A complete folder for this version can exist when an earlier save stopped before updating
    // the record, or another process saved it; never reuse it, take the next number instead.
    while (
      !(await writeVersionFolder(path.join(folder, `v${version}`), input.files, {
        file: LOCAL_MARKER_FILE,
        content: `${JSON.stringify({ name: input.name, version }, null, 2)}\n`,
      }))
    ) {
      version += 1;
    }
    const record: SkillRecord = {
      name: input.name,
      description,
      version,
      updatedAt: now().toISOString(),
      source: input.source === undefined ? (current?.source ?? null) : input.source,
      sourceHash: input.sourceHash === undefined ? (current?.sourceHash ?? null) : input.sourceHash,
      hash: contentHash(input.files),
      syncBase: input.syncBase === undefined ? (current?.syncBase ?? null) : input.syncBase,
      externalPaths: (input.externalPaths ?? current?.externalPaths ?? []).filter((externalPath) =>
        input.files.some((file) => file.path === externalPath),
      ),
    };
    await writeRecord(folder, record);
    return toSkill(record);
  }

  return {
    async list() {
      let entries: string[];
      try {
        entries = await readdir(root);
      } catch (error) {
        if (errorCode(error) === "ENOENT") return [];
        throw error;
      }
      const records = await Promise.all(entries.map((entry) => readRecord(path.join(root, entry))));
      const skills = await Promise.all(
        records.filter((record): record is SkillRecord => record !== null).map(toSkill),
      );
      return skills.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    },
    async get(name) {
      const record = await readRecord(skillDir(name));
      return record ? toSkill(record) : null;
    },
    setSyncBase(name, base) {
      return enqueue(name, async () => {
        const folder = skillDir(name);
        const current = await readRecord(folder);
        if (!current) throw new Error(`Skill ${name} not found.`);
        const record: SkillRecord = { ...current, syncBase: base };
        await writeRecord(folder, record);
        return toSkill(record);
      });
    },
    remove(name) {
      return enqueue(name, () => rm(path.join(skillDir(name), RECORD_FILE), { force: true }));
    },
    save(input) {
      return enqueue(input.name, () => saveNow(input));
    },
  };

  function enqueue<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(work);
    queues.set(key, task);
    void task
      .finally(() => {
        if (queues.get(key) === task) queues.delete(key);
      })
      .catch(() => undefined);
    return task;
  }
}
