import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { SkillSource } from "./local-store";
import { parseFrontmatter, readSkillFolder } from "./skill-folder";

export type FoundOrigin =
  | { kind: "folder"; tool: "claude" | "codex" | "agents" }
  | { kind: "claude-plugin"; marketplace: string; plugin: string; version: string };

export interface FoundSkill {
  /** "path:<real path>" or "claude-plugin:<marketplace>/<plugin>/<skill folder>". */
  id: string;
  name: string;
  description: string;
  dir: string;
  origin: FoundOrigin;
  importable: true | { reason: string };
}

export interface InstalledPlugin {
  marketplace: string;
  plugin: string;
  version: string;
  installPath: string;
}

const FOLDERS: Array<{ tool: "claude" | "codex" | "agents"; relative: string }> = [
  { tool: "claude", relative: ".claude/skills" },
  { tool: "codex", relative: ".codex/skills" },
  { tool: "agents", relative: ".agents/skills" },
];

const InstalledSchema = z.object({
  plugins: z.record(
    z.string(),
    z.array(z.object({ installPath: z.string(), version: z.string().optional(), lastUpdated: z.string().optional() })),
  ),
});

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

async function isDir(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function hasSkillMd(dir: string): Promise<boolean> {
  try {
    return (await stat(path.join(dir, "SKILL.md"))).isFile();
  } catch {
    return false;
  }
}

async function subfolders(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return [];
    throw error;
  }
}

/**
 * Claude Code plugins as installed, from `~/.claude/plugins/installed_plugins.json`. For a plugin
 * installed in several scopes, the entry updated last wins. Missing or unreadable file: none.
 */
export async function installedPlugins(home: string): Promise<InstalledPlugin[]> {
  let raw: string;
  try {
    raw = await readFile(path.join(home, ".claude", "plugins", "installed_plugins.json"), "utf8");
  } catch {
    return [];
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    console.error("[agent-skills] Unreadable installed_plugins.json", {
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
  const parsed = InstalledSchema.safeParse(json);
  if (!parsed.success) {
    console.error("[agent-skills] Unreadable installed_plugins.json", { issues: parsed.error.issues });
    return [];
  }
  return Object.entries(parsed.data.plugins).flatMap(([key, entries]) => {
    const at = key.lastIndexOf("@");
    if (at <= 0) return [];
    const latest = [...entries].sort((a, b) => (b.lastUpdated ?? "").localeCompare(a.lastUpdated ?? ""))[0];
    if (!latest) return [];
    return [
      {
        plugin: key.slice(0, at),
        marketplace: key.slice(at + 1),
        version: latest.version ?? "",
        installPath: latest.installPath,
      },
    ];
  });
}

async function describe(dir: string, id: string, origin: FoundOrigin, folderName: string): Promise<FoundSkill> {
  try {
    const folder = await readSkillFolder(dir);
    return { id, name: folder.name, description: folder.description, dir, origin, importable: true };
  } catch (error) {
    let name = folderName;
    let description = "";
    try {
      const meta = parseFrontmatter(await readFile(path.join(dir, "SKILL.md"), "utf8"));
      name = meta.name ?? folderName;
      description = meta.description ?? "";
    } catch {
      // keep the folder name
    }
    const reason = error instanceof Error ? error.message : String(error);
    return { id, name, description, dir, origin, importable: { reason } };
  }
}

/** Skill folders on this host: home skill folders and installed Claude Code plugin skills. */
export async function scanFound(home: string): Promise<FoundSkill[]> {
  const results: FoundSkill[] = [];
  for (const { tool, relative } of FOLDERS) {
    const base = path.join(home, relative);
    for (const entry of await subfolders(base)) {
      const dir = path.join(base, entry);
      if (!(await isDir(dir)) || !(await hasSkillMd(dir))) continue;
      const real = await realpath(dir);
      results.push(await describe(dir, `path:${real}`, { kind: "folder", tool }, entry));
    }
  }
  for (const plugin of await installedPlugins(home)) {
    const base = path.join(plugin.installPath, "skills");
    for (const entry of await subfolders(base)) {
      const dir = path.join(base, entry);
      if (!(await isDir(dir)) || !(await hasSkillMd(dir))) continue;
      const origin: FoundOrigin = {
        kind: "claude-plugin",
        marketplace: plugin.marketplace,
        plugin: plugin.plugin,
        version: plugin.version,
      };
      results.push(await describe(dir, `claude-plugin:${plugin.marketplace}/${plugin.plugin}/${entry}`, origin, entry));
    }
  }
  return results;
}

/** The folder a stored source points at now, or null when it no longer exists. */
export async function resolveSource(home: string, source: SkillSource): Promise<string | null> {
  if (source.kind === "path") return (await isDir(source.path)) ? source.path : null;
  const plugin = (await installedPlugins(home)).find(
    (candidate) => candidate.marketplace === source.marketplace && candidate.plugin === source.plugin,
  );
  if (!plugin) return null;
  const dir = path.join(plugin.installPath, "skills", source.skill);
  return (await isDir(dir)) ? dir : null;
}

/** The plugin source for a folder inside an installed Claude Code plugin's skills, else null. */
export async function pluginSourceFor(home: string, dir: string): Promise<SkillSource | null> {
  const real = await realpath(dir);
  for (const plugin of await installedPlugins(home)) {
    let skillsRoot: string;
    try {
      skillsRoot = await realpath(path.join(plugin.installPath, "skills"));
    } catch {
      continue;
    }
    if (path.dirname(real) === skillsRoot) {
      return { kind: "claude-plugin", marketplace: plugin.marketplace, plugin: plugin.plugin, skill: path.basename(real) };
    }
  }
  return null;
}
