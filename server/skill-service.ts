import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginAttachmentItem, PluginAttachmentSearchPayload } from "@getpaseo/plugin";
import type { Config } from "../shared/settings";
import {
  attachmentText,
  newSkillTemplate,
  type ReadSkillResult,
  type SkillRefInput,
  type SkillRow,
  type SyncFile,
  type SyncPreview,
  type SyncTarget,
} from "../shared/skills";
import { type FoundSkill, scanFound } from "./found";
import { importFound, importFromPath, reimport, sourceStatus } from "./importer";
import type { LocalSkill, LocalStore } from "./local-store";
import { contentHash, readSkillFolder, SkillFolderError, type SkillText } from "./skill-folder";
import type { LangfuseKeys } from "./key-file";
import { type LangfuseClient, LangfuseError, type SkillRef, type SkillSummary } from "./langfuse";
import { ensureSkillVersion, LOCAL_MARKER_FILE, MANIFEST_FILE, SkillStoreError } from "./skill-store";

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
  importPath(path: string, replace?: boolean): Promise<{ name: string; version: number; needsConfirm: boolean }>;
  importFound(id: string): Promise<{ name: string; version: number }>;
  reimport(name: string): Promise<{ name: string; version: number }>;
  testLangfuse(): Promise<{ projectName: string }>;
  read(ref: SkillRefInput): Promise<ReadSkillResult>;
  save(name: string, files: SkillText[], expectedVersion: number): Promise<{ name: string; version: number }>;
  create(name: string): Promise<{ name: string; version: number }>;
  remove(name: string): Promise<void>;
  previewSync(target: SyncTarget): Promise<SyncPreview>;
  pushSync(
    target: SyncTarget,
    expectedLangfuseVersion: number | null,
    expectedHash: string,
    confirmedExternal: string[],
  ): Promise<{ version: number; message: string }>;
  takeSync(name: string, langfuseVersion: number): Promise<{ localVersion: number; message: string }>;
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

/** Per-file changes from Langfuse's files to the local or found files, sorted by path. */
function compareFiles(local: SkillText[], remote: SkillText[]): SyncFile[] {
  const paths = [...new Set([...local.map((file) => file.path), ...remote.map((file) => file.path)])].sort();
  return paths.map((filePath) => {
    const mine = local.find((file) => file.path === filePath)?.content ?? null;
    const theirs = remote.find((file) => file.path === filePath)?.content ?? null;
    const change = mine === null ? "removed" : theirs === null ? "added" : mine === theirs ? "same" : "changed";
    return { path: filePath, change, local: mine, langfuse: theirs };
  });
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

  async function langfuseClient(): Promise<{ config: Config; client: LangfuseClient }> {
    const config = await deps.readConfig();
    return { config, client: await clientFor(config) };
  }

  async function latestFiles(client: LangfuseClient, name: string): Promise<{ version: number; files: SkillText[] } | null> {
    const ref = await client.resolveSkill(name, "latest");
    if (!ref) return null;
    const version = await client.getSkillVersion(name, ref.version);
    return { version: ref.version, files: version.files.map(({ path: filePath, content }) => ({ path: filePath, content })) };
  }

  interface SyncSubject {
    name: string;
    files: SkillText[];
    externalPaths: string[];
    reviewRequired: boolean;
    commitMessage: string;
    local: LocalSkill | null;
  }

  async function loadSyncSubject(target: SyncTarget): Promise<SyncSubject> {
    if (target.kind === "local") {
      const skill = await deps.localStore.get(target.name);
      if (!skill) throw new Error("Skill not found; refresh the list.");
      const folder = await readSkillFolder(skill.dir, { ignore: [LOCAL_MARKER_FILE] });
      return {
        name: skill.name,
        files: folder.files.map(({ path: filePath, content }) => ({ path: filePath, content })),
        externalPaths: skill.externalPaths ?? [],
        // Imported before external files were tracked: show the files instead of pushing blindly.
        reviewRequired: skill.externalPaths === null && skill.source !== null,
        commitMessage: `Synced from Paseo Agent Skills (local v${skill.version})`,
        local: skill,
      };
    }
    const found = (await scanFound(deps.home)).find((skill) => skill.id === target.id);
    if (!found) throw new Error("Skill not found; refresh the list.");
    const folder = await readSkillFolder(found.dir);
    return {
      name: folder.name,
      files: folder.files.map(({ path: filePath, content }) => ({ path: filePath, content })),
      externalPaths: folder.files.filter((file) => file.external).map((file) => file.path),
      reviewRequired: false,
      commitMessage: `Synced from Paseo Agent Skills (${foundLabel(found)})`,
      local: null,
    };
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
          syncedVersion: skill.syncBase?.version ?? null,
          localChanges: skill.syncBase !== null && skill.hash !== skill.syncBase.hash,
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
    async importPath(folder, replace = false) {
      const trimmed = folder.trim();
      const expanded =
        trimmed === "~" ? deps.home : trimmed.startsWith("~/") ? path.join(deps.home, trimmed.slice(2)) : trimmed;
      if (!replace) {
        const { name } = await readSkillFolder(expanded);
        const existing = await deps.localStore.get(name);
        if (existing) return { name, version: existing.version, needsConfirm: true };
      }
      const skill = await importFromPath(deps.localStore, expanded, deps.home);
      return { name: skill.name, version: skill.version, needsConfirm: false };
    },
    async importFound(id) {
      const skill = await importFound(deps.localStore, deps.home, id);
      return { name: skill.name, version: skill.version };
    },
    async reimport(name) {
      const skill = await reimport(deps.localStore, deps.home, name);
      return { name: skill.name, version: skill.version };
    },
    async read(ref) {
      const notFound = () => new Error("Skill not found; refresh the list.");
      if (ref.kind === "local") {
        const skill = await deps.localStore.get(ref.name);
        if (!skill) throw notFound();
        const folder = await readSkillFolder(skill.dir, { ignore: [LOCAL_MARKER_FILE] });
        return { name: skill.name, version: skill.version, files: folder.files, error: null };
      }
      if (ref.kind === "langfuse") {
        const config = await deps.readConfig();
        const client = await clientFor(config);
        const skillRef = (await client.resolveSkill(ref.name, config.label)) ?? (await client.resolveSkill(ref.name, "latest"));
        if (!skillRef) throw notFound();
        const { dir } = await ensureSkillVersion(
          deps.storeRoot,
          skillRef,
          () => client.getSkillVersion(skillRef.name, skillRef.version),
          { baseUrl: config.baseUrl },
        );
        // Read by the manifest's file list: Langfuse skills need not match local frontmatter rules.
        const manifest = JSON.parse(await readFile(path.join(dir, MANIFEST_FILE), "utf8")) as { files: Array<{ path: string }> };
        const files = await Promise.all(
          manifest.files.map(async (file) => ({
            path: file.path,
            content: await readFile(path.join(dir, ...file.path.split("/")), "utf8"),
          })),
        );
        return { name: skillRef.name, version: skillRef.version, files, error: null };
      }
      const found = (await scanFound(deps.home)).find((skill) => skill.id === ref.id);
      if (!found) throw notFound();
      try {
        const folder = await readSkillFolder(found.dir);
        return { name: folder.name, version: null, files: folder.files, error: null };
      } catch (error) {
        if (!(error instanceof SkillFolderError)) throw error;
        return { name: found.name, version: null, files: [], error: error.message };
      }
    },
    async save(name, files, expectedVersion) {
      const skill = await deps.localStore.save({ name, files, expectedVersion });
      return { name: skill.name, version: skill.version };
    },
    async create(rawName) {
      const name = rawName.trim();
      if (name.length === 0) throw new Error("Enter a skill name.");
      if (await deps.localStore.get(name)) throw new Error(`A local skill named ${name} already exists.`);
      const skill = await deps.localStore.save({
        name,
        files: [{ path: "SKILL.md", content: newSkillTemplate(name) }],
        source: null,
        sourceHash: null,
      });
      return { name: skill.name, version: skill.version };
    },
    async remove(name) {
      await deps.localStore.remove(name);
    },
    async previewSync(target) {
      const subject = await loadSyncSubject(target);
      const { client } = await langfuseClient();
      const latest = await latestFiles(client, subject.name);
      const base = subject.local?.syncBase ?? null;
      const common = {
        name: subject.name,
        baseVersion: base?.version ?? null,
        externalPaths: subject.externalPaths,
        contentHash: contentHash(subject.files),
        reviewRequired: subject.reviewRequired,
      };
      if (!latest) {
        return { ...common, outcome: "create", langfuseVersion: null, files: compareFiles(subject.files, []) };
      }
      if (contentHash(latest.files) === contentHash(subject.files)) {
        if (subject.local) {
          await deps.localStore.setSyncBase(subject.name, { version: latest.version, hash: contentHash(latest.files) });
        }
        return { ...common, outcome: "identical", langfuseVersion: latest.version, files: [] };
      }
      const outcome = subject.local && base?.version === latest.version ? "fast-forward" : "conflict";
      return { ...common, outcome, langfuseVersion: latest.version, files: compareFiles(subject.files, latest.files) };
    },
    async pushSync(target, expectedLangfuseVersion, expectedHash, confirmedExternal) {
      const subject = await loadSyncSubject(target);
      const { client } = await langfuseClient();
      const latest = await client.resolveSkill(subject.name, "latest");
      if ((latest?.version ?? null) !== expectedLangfuseVersion) {
        throw new Error("Langfuse changed again since the review; review again.");
      }
      if (contentHash(subject.files) !== expectedHash) {
        throw new Error("This skill changed since the review; review again.");
      }
      if (subject.externalPaths.some((externalPath) => !confirmedExternal.includes(externalPath))) {
        throw new Error("Confirm the files from outside the skill folder first.");
      }
      const created = await client.createSkillVersion(subject.files, subject.commitMessage);
      if (subject.local) {
        await deps.localStore.setSyncBase(subject.name, { version: created.version, hash: contentHash(subject.files) });
      }
      return { version: created.version, message: `Synced to Langfuse as v${created.version}.` };
    },
    async takeSync(name, langfuseVersion) {
      const { client } = await langfuseClient();
      const remote = await client.getSkillVersion(name, langfuseVersion);
      const files = remote.files.map(({ path: filePath, content }) => ({ path: filePath, content }));
      const saved = await deps.localStore.save({
        name,
        files,
        syncBase: { version: langfuseVersion, hash: contentHash(files) },
        externalPaths: [],
      });
      return { localVersion: saved.version, message: `Saved Langfuse v${langfuseVersion} as local v${saved.version}.` };
    },
    async testLangfuse() {
      const config = await deps.readConfig();
      return (await clientFor(config)).testConnection();
    },
  };
}
