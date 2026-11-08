import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isText, parseFrontmatter, type SkillText } from "./skill-folder";
import { checkSkillPaths, LOCAL_MARKER_FILE, SkillStoreError, writeVersionFolder } from "./skill-store";

export type SkillSource =
  | { kind: "path"; path: string }
  | { kind: "claude-plugin"; marketplace: string; plugin: string; skill: string };

export interface LocalSkill {
  name: string;
  description: string;
  version: number;
  updatedAt: string;
  source: SkillSource | null;
  sourceHash: string | null;
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
  /** Refuse the save unless the current version is this one. */
  expectedVersion?: number;
}

export interface LocalStore {
  list(): Promise<LocalSkill[]>;
  get(name: string): Promise<LocalSkill | null>;
  save(input: SaveInput): Promise<LocalSkill>;
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
    if (name.length === 0 || name.includes("\0")) {
      throw new LocalStoreError("unsafe-name", `Skill name ${JSON.stringify(name)} is not allowed.`);
    }
    return path.join(root, encodeURIComponent(name));
  }

  function toSkill(record: SkillRecord): LocalSkill {
    return { ...record, dir: path.join(skillDir(record.name), `v${record.version}`) };
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
    const version = (current?.version ?? 0) + 1;
    const versionFolder = path.join(folder, `v${version}`);
    const description = validate(input, versionFolder);
    if (input.expectedVersion !== undefined && input.expectedVersion !== (current?.version ?? 0)) {
      throw new LocalStoreError("changed-elsewhere", "This skill was changed elsewhere; reload.");
    }
    await mkdir(folder, { recursive: true });
    await writeVersionFolder(versionFolder, input.files, {
      file: LOCAL_MARKER_FILE,
      content: `${JSON.stringify({ name: input.name, version }, null, 2)}\n`,
    });
    const record: SkillRecord = {
      name: input.name,
      description,
      version,
      updatedAt: now().toISOString(),
      source: input.source === undefined ? (current?.source ?? null) : input.source,
      sourceHash: input.sourceHash === undefined ? (current?.sourceHash ?? null) : input.sourceHash,
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
      return records
        .filter((record): record is SkillRecord => record !== null)
        .map(toSkill)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    },
    async get(name) {
      const record = await readRecord(skillDir(name));
      return record ? toSkill(record) : null;
    },
    save(input) {
      const key = input.name;
      const previous = queues.get(key) ?? Promise.resolve();
      const task = previous.catch(() => undefined).then(() => saveNow(input));
      queues.set(key, task);
      void task.finally(() => {
        if (queues.get(key) === task) queues.delete(key);
      }).catch(() => undefined);
      return task;
    },
  };
}
