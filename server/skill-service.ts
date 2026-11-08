import { pathToFileURL } from "node:url";
import type { PluginAttachmentItem, PluginAttachmentSearchPayload } from "@getpaseo/plugin";
import type { Config } from "../shared/settings";
import { attachmentText } from "../shared/skills";
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
  /** Folder that holds every stored skill version. */
  storeRoot: string;
  /** Milliseconds clock; defaults to Date.now. */
  now?(): number;
}

export interface SkillService {
  search(query: string): Promise<PluginAttachmentSearchPayload>;
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

  async function listSkills(config: Config, client: LangfuseClient): Promise<SkillSummary[]> {
    const key = [config.baseUrl, config.keyFilePath].join("\n");
    if (cache && cache.key === key && now() - cache.at < LIST_CACHE_MS) return cache.skills;
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
      text: attachmentText(ref.name, ref.version, dir),
      resourceType: "skill",
    };
  }

  return {
    async search(query) {
      const config = await deps.readConfig();
      const client = await clientFor(config);
      const needle = query.trim().toLowerCase();
      const matches = (await listSkills(config, client))
        .filter(
          (skill) =>
            skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle),
        )
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
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
      return { items };
    },
    async testLangfuse() {
      const config = await deps.readConfig();
      return (await clientFor(config)).testConnection();
    },
  };
}
