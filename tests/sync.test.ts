import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LangfuseClient, SkillRef, SkillVersion } from "../server/langfuse";
import { createLocalStore, type LocalStore } from "../server/local-store";
import { contentHash } from "../server/skill-folder";
import { createSkillService } from "../server/skill-service";
import { ConfigSchema } from "../shared/settings";

type Files = Array<{ path: string; content: string }>;

function skillMd(name: string, body = "# Skill\n"): string {
  return `---\nname: ${name}\ndescription: About ${name}\n---\n${body}`;
}

/** A Langfuse project holding skill versions; createSkillVersion appends one. */
class VersionedLangfuse implements LangfuseClient {
  versions = new Map<string, Files[]>();
  created: Array<{ files: Files; commitMessage: string }> = [];
  async listSkills() {
    return [...this.versions.keys()].map((name) => ({ name, description: "" }));
  }
  async resolveSkill(name: string, label: string): Promise<SkillRef | null> {
    const list = this.versions.get(name);
    if (!list || list.length === 0) return null;
    return label === "latest" || label === "production" ? { name, version: list.length, description: "" } : null;
  }
  async getSkillVersion(name: string, version: number): Promise<SkillVersion> {
    const files = this.versions.get(name)?.[version - 1];
    if (!files) throw new Error(`no ${name} v${version}`);
    return { name, version, files: files.map((file) => ({ ...file, contentType: "text/plain", sha256Hash: "" })) };
  }
  async createSkillVersion(files: Files, commitMessage: string) {
    const name = /name: (.*)/.exec(files.find((file) => file.path === "SKILL.md")?.content ?? "")?.[1] ?? "?";
    const list = this.versions.get(name) ?? [];
    list.push(files);
    this.versions.set(name, list);
    this.created.push({ files, commitMessage });
    return { name, version: list.length };
  }
  async testConnection() {
    return { projectName: "Acme" };
  }
}

let root: string;
let home: string;
let store: LocalStore;
let langfuse: VersionedLangfuse;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lfs-sync-"));
  home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  store = createLocalStore({ root: path.join(root, "local") });
  langfuse = new VersionedLangfuse();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function service() {
  return createSkillService({
    readConfig: async () => ConfigSchema.parse({ baseUrl: "https://lf.example" }),
    readKeys: async () => ({ publicKey: "pk", secretKey: "sk" }),
    createLangfuse: () => langfuse,
    storeRoot: path.join(root, "langfuse"),
    localStore: store,
    home,
  });
}

const LOCAL = { kind: "local" as const, name: "cut-release" };

/** Pushes exactly what a fresh preview showed, confirming its external files. */
async function pushReviewed(skills: ReturnType<typeof service>, target: Parameters<ReturnType<typeof service>["pushSync"]>[0]) {
  const preview = await skills.previewSync(target);
  return skills.pushSync(target, preview.langfuseVersion, preview.contentHash, preview.externalPaths);
}

describe("sync a local skill", () => {
  it("creates the skill in Langfuse and records the base", async () => {
    await store.save({ name: "cut-release", files: [{ path: "SKILL.md", content: skillMd("cut-release") }] });
    const skills = service();
    expect((await skills.previewSync(LOCAL)).outcome).toBe("create");
    const pushed = await pushReviewed(skills, LOCAL);
    expect(pushed).toEqual({ version: 1, message: "Synced to Langfuse as v1." });
    expect(langfuse.created[0]?.commitMessage).toBe("Synced from Paseo Agent Skills (local v1)");
    const row = (await skills.list({})).rows.find((candidate) => candidate.name === "cut-release");
    expect(row?.local).toMatchObject({ syncedVersion: 1, localChanges: false });
  });

  it("records the base for an identical copy, including old records", async () => {
    const files = [{ path: "SKILL.md", content: skillMd("cut-release") }];
    langfuse.versions.set("cut-release", [files, files]);
    await store.save({ name: "cut-release", files });
    const recordPath = path.join(root, "local", "cut-release", "skill.json");
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    delete record.hash;
    delete record.syncBase;
    await writeFile(recordPath, JSON.stringify(record));
    const preview = await service().previewSync(LOCAL);
    expect(preview.outcome).toBe("identical");
    expect(preview.langfuseVersion).toBe(2);
    expect((await store.get("cut-release"))?.syncBase?.version).toBe(2);
  });

  it("fast-forwards local edits when Langfuse is unchanged", async () => {
    await store.save({ name: "cut-release", files: [{ path: "SKILL.md", content: skillMd("cut-release") }] });
    const skills = service();
    await pushReviewed(skills, LOCAL);
    await store.save({ name: "cut-release", files: [{ path: "SKILL.md", content: skillMd("cut-release", "# edited\n") }] });
    expect((await skills.list({})).rows[0]?.local?.localChanges).toBe(true);
    const preview = await skills.previewSync(LOCAL);
    expect(preview.outcome).toBe("fast-forward");
    expect(preview.files).toEqual([
      { path: "SKILL.md", change: "changed", local: skillMd("cut-release", "# edited\n"), langfuse: skillMd("cut-release") },
    ]);
    expect((await pushReviewed(skills, LOCAL)).version).toBe(2);
    expect((await skills.list({})).rows[0]?.local?.localChanges).toBe(false);
  });

  it("reports a conflict with per-file changes", async () => {
    await store.save({
      name: "cut-release",
      files: [
        { path: "SKILL.md", content: skillMd("cut-release") },
        { path: "mine.sh", content: "mine" },
        { path: "both.sh", content: "local" },
      ],
    });
    const skills = service();
    await pushReviewed(skills, LOCAL);
    langfuse.versions.get("cut-release")?.push([
      { path: "SKILL.md", content: skillMd("cut-release") },
      { path: "theirs.sh", content: "theirs" },
      { path: "both.sh", content: "remote" },
    ]);
    const preview = await skills.previewSync(LOCAL);
    expect(preview.outcome).toBe("conflict");
    expect(preview.baseVersion).toBe(1);
    expect(preview.langfuseVersion).toBe(2);
    const changes = Object.fromEntries(preview.files.map((file) => [file.path, file.change]));
    expect(changes).toEqual({ "SKILL.md": "same", "both.sh": "changed", "mine.sh": "added", "theirs.sh": "removed" });
  });

  it("refuses a push when Langfuse moved after the review", async () => {
    langfuse.versions.set("cut-release", [[{ path: "SKILL.md", content: skillMd("cut-release", "# 1\n") }]]);
    await store.save({ name: "cut-release", files: [{ path: "SKILL.md", content: skillMd("cut-release", "# mine\n") }] });
    const skills = service();
    const preview = await skills.previewSync(LOCAL);
    langfuse.versions.get("cut-release")?.push([{ path: "SKILL.md", content: skillMd("cut-release", "# 2\n") }]);
    await expect(skills.pushSync(LOCAL, preview.langfuseVersion, preview.contentHash, [])).rejects.toThrow(
      "Langfuse changed again since the review; review again.",
    );
    expect(langfuse.versions.get("cut-release")).toHaveLength(2);
  });

  it("takes Langfuse's version as a new local version", async () => {
    const first = await store.save({ name: "cut-release", files: [{ path: "SKILL.md", content: skillMd("cut-release", "# mine\n") }] });
    const before = await readFile(path.join(first.dir, "SKILL.md"), "utf8");
    const theirs = [{ path: "SKILL.md", content: skillMd("cut-release", "# theirs\n") }];
    langfuse.versions.set("cut-release", [theirs, theirs, theirs, theirs]);
    const taken = await service().takeSync("cut-release", 4);
    expect(taken).toEqual({ localVersion: 2, message: "Saved Langfuse v4 as local v2." });
    expect(await readFile(path.join(first.dir, "SKILL.md"), "utf8")).toBe(before);
    expect((await store.get("cut-release"))?.syncBase).toEqual({ version: 4, hash: contentHash(theirs) });
  });

  it("requires confirmation for files from outside the skill folder", async () => {
    await store.save({
      name: "cut-release",
      files: [{ path: "SKILL.md", content: skillMd("cut-release") }],
      externalPaths: ["SKILL.md"],
    });
    const skills = service();
    const preview = await skills.previewSync(LOCAL);
    expect(preview.externalPaths).toEqual(["SKILL.md"]);
    await expect(skills.pushSync(LOCAL, null, preview.contentHash, [])).rejects.toThrow(
      "Confirm the files from outside the skill folder first.",
    );
    expect((await skills.pushSync(LOCAL, null, preview.contentHash, ["SKILL.md"])).version).toBe(1);
  });
});

describe("sync a found skill", () => {
  it("reviews a differing found skill and pushes without creating a local skill", async () => {
    const dir = path.join(home, ".claude/skills/review");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), skillMd("review", "# found\n"));
    langfuse.versions.set("review", [[{ path: "SKILL.md", content: skillMd("review", "# remote\n") }]]);
    const skills = service();
    const id = (await skills.list({})).rows.find((row) => row.name === "review")?.found[0]?.id ?? "";
    const preview = await skills.previewSync({ kind: "found", id });
    expect(preview.outcome).toBe("conflict");
    const pushed = await skills.pushSync({ kind: "found", id }, 1, preview.contentHash, []);
    expect(pushed.version).toBe(2);
    expect(langfuse.created[0]?.commitMessage).toBe("Synced from Paseo Agent Skills (~/.claude/skills)");
    expect(await store.get("review")).toBeNull();
  });

  it("flags a SKILL.md symlinked from outside the folder", async () => {
    const outside = path.join(home, "gstack", "SKILL.md");
    await mkdir(path.dirname(outside), { recursive: true });
    await writeFile(outside, skillMd("autoplan"));
    const dir = path.join(home, ".claude/skills/autoplan");
    await mkdir(dir, { recursive: true });
    await symlink(outside, path.join(dir, "SKILL.md"));
    const skills = service();
    const id = (await skills.list({})).rows.find((row) => row.name === "autoplan")?.found[0]?.id ?? "";
    const preview = await skills.previewSync({ kind: "found", id });
    expect(preview.externalPaths).toEqual(["SKILL.md"]);
    await expect(skills.pushSync({ kind: "found", id }, null, preview.contentHash, [])).rejects.toThrow("Confirm the files");
  });
});

describe("review fixes", () => {
  it("refuses a push when the content changed since the review", async () => {
    await store.save({ name: "cut-release", files: [{ path: "SKILL.md", content: skillMd("cut-release") }] });
    const skills = service();
    const preview = await skills.previewSync(LOCAL);
    await store.save({ name: "cut-release", files: [{ path: "SKILL.md", content: skillMd("cut-release", "# later\n") }] });
    await expect(skills.pushSync(LOCAL, preview.langfuseVersion, preview.contentHash, [])).rejects.toThrow(
      "This skill changed since the review; review again.",
    );
    expect(langfuse.created).toHaveLength(0);
  });

  it("refuses a push when an external file was not part of the confirmation", async () => {
    await store.save({
      name: "cut-release",
      files: [
        { path: "SKILL.md", content: skillMd("cut-release") },
        { path: "run.sh", content: "echo" },
      ],
      externalPaths: ["SKILL.md", "run.sh"],
    });
    const skills = service();
    const preview = await skills.previewSync(LOCAL);
    await expect(skills.pushSync(LOCAL, null, preview.contentHash, ["SKILL.md"])).rejects.toThrow(
      "Confirm the files from outside the skill folder first.",
    );
  });

  it("requires a review for an imported record without external tracking", async () => {
    await store.save({
      name: "cut-release",
      files: [{ path: "SKILL.md", content: skillMd("cut-release") }],
      source: { kind: "path", path: "/gone" },
      sourceHash: "x",
    });
    const recordPath = path.join(root, "local", "cut-release", "skill.json");
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    delete record.externalPaths;
    await writeFile(recordPath, JSON.stringify(record));
    const preview = await service().previewSync(LOCAL);
    expect(preview.outcome).toBe("create");
    expect(preview.reviewRequired).toBe(true);
  });

  it("does not require a review for a skill created in Paseo", async () => {
    await store.save({ name: "cut-release", files: [{ path: "SKILL.md", content: skillMd("cut-release") }], source: null });
    expect((await service().previewSync(LOCAL)).reviewRequired).toBe(false);
  });
});
