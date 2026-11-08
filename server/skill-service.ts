import { pathToFileURL } from "node:url";
import type { PluginAttachmentItem, PluginAttachmentSearchPayload } from "@getpaseo/plugin";
import type { Config } from "../shared/settings";
import { attachmentText, type SkillRow } from "../shared/skills";
import { type FoundSkill, scanFound } from "./found";
import { importFound, importFromPath, reimport, sourceStatus } from "./importer";
import type { LocalSkill, LocalStore } from "./local-store";
import type { LangfuseKeys } from "./key-file";
import { type LangfuseClient, LangfuseError, type SkillRef, type SkillSummary } from "./langfuse";
import { ensureSkillVersion, SkillStoreError } from "./skill-store";

const MAX_SEARCH_RESULTS = 20;
const RESOLVE_CONCURRENCY = 5;
/** How long the skill list is reused, so picker keystrokes do not refetch it. */
const LIST_CACHE_MS = 60_000;

/** Thrown when the settings document is stored but fails its schema. */
export class SettingsUnavailableError extends Error {
  constructor(detail: string) {
    super(`Langfuse Skills settings are invalid: ${detail}`);
    this.name = "SettingsUnavailableError";
  }
}

export interface SkillServiceDeps {
  readConfig(): Promise<Config>;
  readKeys(path: string): Promise<LangfuseKeys>;
  createLangfuse(options: { baseUrl: string; keys: LangfuseKeys }): LangfuseClient;
  /** Folder that holds every downloaded Langfuse skill version. */
  storeRoot: string;
  localStore: LocalStore;
  /** Home folder scanned for found skills and plugin sources. */
  home: string;
  /** Milliseconds clock; defaults to Date.now. */
  now?(): number;
}

export interface SkillList {
  rows: SkillRow[];
  langfuseError: string | null;
}

export interface SkillService {
  search(query: string): Promise<PluginAttachmentSearchPayload>;
  list(options: { fresh?: boolean }): Promise<SkillList>;
  importPath(path: string): Promise<{ name: string; version: number }>;
  importFound(id: string): Promise<{ name: string; version: number }>;
  reimport(name: string): Promise<{ name: string; version: number }>;
  testLangfuse(): Promise<{ projectName: string }>;
}

/** Runs `task` over `inputs` with at most `limit` in flight, keeping input order. */
async function mapLimited<T, R>(inputs: T[], limit: number, task: (input: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(inputs.length);
  let next = 0;
  async function worker() {
    while (next < inputs.length) {
      const index = next;
      next += 1;
      results[index] = await task(inputs[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, worker));
  return results;
}

function byName(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

function matches_(name: string, description: string, needle: string): boolean {
  return name.toLowerCase().includes(needle) || description.toLowerCase().includes(needle);
}

type Outcome = { item: PluginAttachmentItem } | { error: Error } | null;

/**
 * Serves Langfuse skills to the attachment picker, storing each returned version on disk.
 *
 * Config, key file and list errors (SettingsUnavailableError, KeyFileError, LangfuseError)
 * propagate unchanged. Per-skill LangfuseError and SkillStoreError skip that skill; when every
 * matching skill fails, the first such error is thrown.
 */
export function createSkillService(deps: SkillServiceDeps): SkillService {
  const now = deps.now ?? Date.now;
  let cache: { key: string; at: number; skills: SkillSummary[] } | null = null;

  async function clientFor(config: Config): Promise<LangfuseClient> {
    const keys = await deps.readKeys(config.keyFilePath);
    return deps.createLangfuse({ baseUrl: config.baseUrl, keys });
  }

  async function listSkills(config: Config, client: LangfuseClient, fresh = false): Promise<SkillSummary[]> {
    const key = [config.baseUrl, config.keyFilePath].join("\n");
    if (!fresh && cache && cache.key === key && now() - cache.at < LIST_CACHE_MS) return cache.skills;
    const skills = await client.listSkills();
    cache = { key, at: now(), skills };
    return skills;
  }

  async function prepare(config: Config, client: LangfuseClient, ref: SkillRef): Promise<PluginAttachmentItem> {
    const { dir } = await ensureSkillVersion(
      deps.storeRoot,
      ref,
      () => client.getSkillVersion(ref.name, ref.version),
      { baseUrl: config.baseUrl },
    );
    const details = [`v${ref.version}`, config.label, ref.description].filter((part) => part.length > 0);
    return {
      id: `${ref.name}@${ref.version}`,
      identifier: ref.name,
      title: ref.name,
      subtitle: details.join(" · "),
      url: pathToFileURL(dir).href,
      text: attachmentText(ref.name, "Langfuse", ref.version, dir),
      resourceType: "skill",
    };
  }

  async function searchLangfuse(query: string): Promise<PluginAttachmentItem[]> {
    const config = await deps.readConfig();
    const client = await clientFor(config);
    const needle = query.trim().toLowerCase();
    const matches = (await listSkills(config, client))
      .filter((skill) => matches_(skill.name, skill.description, needle))
      .sort((a, b) => byName(a.name, b.name))
      .slice(0, MAX_SEARCH_RESULTS);
    const outcomes = await mapLimited(matches, RESOLVE_CONCURRENCY, async (skill): Promise<Outcome> => {
      try {
        const ref = await client.resolveSkill(skill.name, config.label);
        return ref ? { item: await prepare(config, client, ref) } : null;
      } catch (error) {
        if (!(error instanceof LangfuseError || error instanceof SkillStoreError)) throw error;
        console.error("[agent-skills] Skipping skill", { name: skill.name, message: error.message });
        return { error };
      }
    });
    const items = outcomes.flatMap((outcome) => (outcome && "item" in outcome ? [outcome.item] : []));
    const firstError = outcomes.find((outcome) => outcome !== null && "error" in outcome);
    if (items.length === 0 && firstError && "error" in firstError) throw firstError.error;
    return items;
  }

  function localItem(skill: LocalSkill): PluginAttachmentItem {
    return {
      id: `local:${skill.name}@${skill.version}`,
      identifier: skill.name,
      title: skill.name,
      subtitle: [`Local v${skill.version}`, skill.description].filter((part) => part.length > 0).join(" · "),
      url: pathToFileURL(skill.dir).href,
      text: attachmentText(skill.name, "local", skill.version, skill.dir),
      resourceType: "skill",
    };
  }

  async function langfuseRows(fresh: boolean): Promise<Map<string, NonNullable<SkillRow["langfuse"]> & { description: string }>> {
    const config = await deps.readConfig();
    const client = await clientFor(config);
    const skills = await listSkills(config, client, fresh);
    const refs = await mapLimited(skills, RESOLVE_CONCURRENCY, async (skill) => {
      const [latest, labeled] = await Promise.all([
        client.resolveSkill(skill.name, "latest"),
        client.resolveSkill(skill.name, config.label),
      ]);
      return { skill, latest, labeled };
    });
    const rows = new Map<string, NonNullable<SkillRow["langfuse"]> & { description: string }>();
    for (const { skill, latest, labeled } of refs) {
      if (!latest) continue;
      rows.set(skill.name, {
        latestVersion: latest.version,
        labeledVersion: labeled?.version ?? null,
        description: skill.description,
      });
    }
    return rows;
  }

  function foundLabel(found: FoundSkill): string {
    if (found.origin.kind === "claude-plugin") return `Claude plugin ${found.origin.plugin} ${found.origin.version}`.trim();
    return `~/.${found.origin.tool}/skills`;
  }

  function sourceLabel(skill: LocalSkill): string | null {
    if (!skill.source) return null;
    return skill.source.kind === "path" ? skill.source.path : `Claude plugin ${skill.source.plugin}`;
  }

  return {
    async search(query) {
      const needle = query.trim().toLowerCase();
      const local = (await deps.localStore.list())
        .filter((skill) => matches_(skill.name, skill.description, needle))
        .map(localItem);
      let remote: PluginAttachmentItem[] = [];
      try {
        remote = await searchLangfuse(query);
      } catch (error) {
        if (local.length === 0) throw error;
        console.error("[agent-skills] Langfuse search failed; showing local skills only", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return { items: [...local, ...remote] };
    },
    async list({ fresh = false }) {
      const [localSkills, found] = await Promise.all([deps.localStore.list(), scanFound(deps.home)]);
      let langfuse = new Map<string, NonNullable<SkillRow["langfuse"]> & { description: string }>();
      let langfuseError: string | null = null;
      try {
        langfuse = await langfuseRows(fresh);
      } catch (error) {
        langfuseError = error instanceof Error ? error.message : String(error);
      }
      const rows = new Map<string, SkillRow>();
      function row(name: string, description: string): SkillRow {
        let existing = rows.get(name);
        if (!existing) {
          existing = { name, description, local: null, langfuse: null, found: [] };
          rows.set(name, existing);
        }
        if (!existing.description && description) existing.description = description;
        return existing;
      }
      for (const skill of localSkills) {
        row(skill.name, skill.description).local = {
          version: skill.version,
          sourceStatus: await sourceStatus(deps.home, skill),
          sourceLabel: sourceLabel(skill),
        };
      }
      for (const [name, info] of langfuse) {
        row(name, info.description).langfuse = { latestVersion: info.latestVersion, labeledVersion: info.labeledVersion };
      }
      for (const skill of found) {
        row(skill.name, skill.description).found.push({
          id: skill.id,
          label: foundLabel(skill),
          importable: skill.importable === true,
          reason: skill.importable === true ? null : skill.importable.reason,
        });
      }
      return { rows: [...rows.values()].sort((a, b) => byName(a.name, b.name)), langfuseError };
    },
    async importPath(folder) {
      const skill = await importFromPath(deps.localStore, folder, deps.home);
      return { name: skill.name, version: skill.version };
    },
    async importFound(id) {
      const skill = await importFound(deps.localStore, deps.home, id);
      return { name: skill.name, version: skill.version };
    },
    async reimport(name) {
      const skill = await reimport(deps.localStore, deps.home, name);
      return { name: skill.name, version: skill.version };
    },
    async testLangfuse() {
      const config = await deps.readConfig();
      return (await clientFor(config)).testConnection();
    },
  };
}
