import { realpath } from "node:fs/promises";
import { pluginSourceFor, resolveSource, scanFound } from "./found";
import type { LocalSkill, LocalStore, SkillSource } from "./local-store";
import { contentHash, readSkillFolder, SkillFolderError } from "./skill-folder";

export type SourceStatus = "unchanged" | "updated" | "missing";

async function importFolder(store: LocalStore, dir: string, source: SkillSource): Promise<LocalSkill> {
  const folder = await readSkillFolder(dir);
  const files = folder.files.map(({ path, content }) => ({ path, content }));
  return store.save({
    name: folder.name,
    files,
    source,
    sourceHash: contentHash(files),
    externalPaths: folder.files.filter((file) => file.external).map((file) => file.path),
  });
}

/**
 * Copies the skill folder at `dir` into the local store as the next version. A folder inside an
 * installed Claude Code plugin is recorded as a plugin source; anything else by real path.
 *
 * @throws {SkillFolderError} when the folder is not a valid skill; store errors from `save`.
 */
export async function importFromPath(store: LocalStore, dir: string, home: string): Promise<LocalSkill> {
  let real: string;
  try {
    real = await realpath(dir);
  } catch {
    throw new SkillFolderError("missing", `Skill folder ${dir} does not exist.`);
  }
  const pluginSource = await pluginSourceFor(home, real);
  return importFolder(store, real, pluginSource ?? { kind: "path", path: real });
}

/**
 * Imports a skill listed by {@link scanFound}.
 *
 * @throws {Error} "Skill not found on this host; refresh the list." for an unknown id.
 */
export async function importFound(store: LocalStore, home: string, id: string): Promise<LocalSkill> {
  const found = (await scanFound(home)).find((skill) => skill.id === id);
  if (!found) throw new Error("Skill not found on this host; refresh the list.");
  if (found.origin.kind === "claude-plugin") {
    const skillFolder = id.slice(id.lastIndexOf("/") + 1);
    return importFolder(store, found.dir, {
      kind: "claude-plugin",
      marketplace: found.origin.marketplace,
      plugin: found.origin.plugin,
      skill: skillFolder,
    });
  }
  return importFolder(store, await realpath(found.dir), { kind: "path", path: await realpath(found.dir) });
}

/**
 * Imports a local skill again from its recorded source, as the next version.
 *
 * @throws {Error} when the skill has no source or its source is gone.
 */
export async function reimport(store: LocalStore, home: string, name: string): Promise<LocalSkill> {
  const skill = await store.get(name);
  if (!skill?.source) throw new Error(`Skill ${name} was not imported, so it cannot be re-imported.`);
  const dir = await resolveSource(home, skill.source);
  if (!dir) throw new Error(`The source of ${name} no longer exists.`);
  return importFolder(store, dir, skill.source);
}

/** Whether a local skill's import source changed since import; null when it has no source. */
export async function sourceStatus(home: string, skill: LocalSkill): Promise<SourceStatus | null> {
  if (!skill.source) return null;
  const dir = await resolveSource(home, skill.source);
  if (!dir) return "missing";
  try {
    const folder = await readSkillFolder(dir);
    return contentHash(folder.files) === skill.sourceHash ? "unchanged" : "updated";
  } catch (error) {
    if (error instanceof SkillFolderError && error.kind === "missing") return "missing";
    return "updated";
  }
}
