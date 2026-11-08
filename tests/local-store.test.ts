import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalStore, LocalStoreError, type LocalStoreErrorKind, type SkillSource } from "../server/local-store";
import type { SkillText } from "../server/skill-folder";

const NOW = () => new Date("2026-11-08T00:00:00.000Z");

function skillMd(name: string, body = "# Skill\n"): string {
  return `---\nname: ${name}\ndescription: About ${name}\n---\n${body}`;
}

function files(name: string, body?: string): SkillText[] {
  return [
    { path: "SKILL.md", content: skillMd(name, body) },
    { path: "scripts/run.sh", content: `echo ${name}\n` },
  ];
}

const SOURCE: SkillSource = { kind: "path", path: "/home/me/.claude/skills/cut-release" };

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lfs-local-"));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function kind(promise: Promise<unknown>): Promise<LocalStoreErrorKind> {
  const error = await promise.then(
    () => {
      throw new Error("expected rejection");
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(LocalStoreError);
  return (error as LocalStoreError).kind;
}

describe("createLocalStore", () => {
  it("saves version 1 with files and record", async () => {
    const store = createLocalStore({ root, now: NOW });
    const saved = await store.save({ name: "cut-release", files: files("cut-release"), source: SOURCE, sourceHash: "h1" });
    expect(saved).toEqual({
      name: "cut-release",
      description: "About cut-release",
      version: 1,
      updatedAt: "2026-11-08T00:00:00.000Z",
      source: SOURCE,
      sourceHash: "h1",
      dir: path.join(root, "cut-release", "v1"),
    });
    expect(await readFile(path.join(saved.dir, "scripts", "run.sh"), "utf8")).toBe("echo cut-release\n");
    expect(await store.get("cut-release")).toEqual(saved);
  });

  it("keeps the source when a later save omits it", async () => {
    const store = createLocalStore({ root, now: NOW });
    await store.save({ name: "cut-release", files: files("cut-release"), source: SOURCE, sourceHash: "h1" });
    const second = await store.save({ name: "cut-release", files: files("cut-release", "# v2\n") });
    expect(second.version).toBe(2);
    expect(second.source).toEqual(SOURCE);
    expect(second.sourceHash).toBe("h1");
  });

  it("never modifies an earlier version folder", async () => {
    const store = createLocalStore({ root, now: NOW });
    const first = await store.save({ name: "cut-release", files: files("cut-release") });
    const before = await readFile(path.join(first.dir, "SKILL.md"), "utf8");
    await store.save({ name: "cut-release", files: files("cut-release", "# changed\n") });
    expect(await readFile(path.join(first.dir, "SKILL.md"), "utf8")).toBe(before);
    expect((await readdir(first.dir)).sort()).toEqual([".agent-skill.json", "SKILL.md", "scripts"]);
  });

  it("refuses a SKILL.md whose name differs", async () => {
    const store = createLocalStore({ root, now: NOW });
    const promise = store.save({ name: "cut-release", files: files("other") });
    await expect(promise).rejects.toThrow(
      'SKILL.md says "other" but the skill is "cut-release". Renaming means creating a new skill.',
    );
    expect(await kind(store.save({ name: "cut-release", files: files("other") }))).toBe("name-mismatch");
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses a save based on an older version", async () => {
    const store = createLocalStore({ root, now: NOW });
    await store.save({ name: "cut-release", files: files("cut-release") });
    await store.save({ name: "cut-release", files: files("cut-release") });
    const promise = store.save({ name: "cut-release", files: files("cut-release"), expectedVersion: 1 });
    await expect(promise).rejects.toThrow("This skill was changed elsewhere; reload.");
  });

  it("refuses a non-text file", async () => {
    const store = createLocalStore({ root, now: NOW });
    const promise = store.save({
      name: "cut-release",
      files: [...files("cut-release"), { path: "x.bin", content: "a\0b" }],
    });
    await expect(promise).rejects.toThrow("x.bin is not a text file");
  });

  it("orders concurrent saves of one name", async () => {
    const store = createLocalStore({ root, now: NOW });
    const results = await Promise.all([
      store.save({ name: "cut-release", files: files("cut-release", "# a\n") }),
      store.save({ name: "cut-release", files: files("cut-release", "# b\n") }),
    ]);
    expect(results.map((skill) => skill.version).sort()).toEqual([1, 2]);
    const record = JSON.parse(await readFile(path.join(root, "cut-release", "skill.json"), "utf8"));
    expect(record.version).toBe(2);
  });

  it("lists skills by name and skips a corrupt record", async () => {
    const store = createLocalStore({ root, now: NOW });
    await store.save({ name: "zeta", files: files("zeta") });
    await store.save({ name: "Alpha", files: files("Alpha") });
    await mkdir(path.join(root, "broken"), { recursive: true });
    await writeFile(path.join(root, "broken", "skill.json"), "{not json");
    expect((await store.list()).map((skill) => skill.name)).toEqual(["Alpha", "zeta"]);
  });

  it("stores folder-style names in one encoded folder", async () => {
    const store = createLocalStore({ root, now: NOW });
    const saved = await store.save({ name: "team/cut-release", files: files("team/cut-release") });
    expect(saved.dir).toBe(path.join(root, "team%2Fcut-release", "v1"));
    expect(await store.get("team/cut-release")).not.toBeNull();
  });

  it("returns null for an unknown skill", async () => {
    expect(await createLocalStore({ root }).get("nope")).toBeNull();
  });
});

describe("review fixes", () => {
  it.each([".", ".."])("refuses the skill name %j", async (name) => {
    const store = createLocalStore({ root: path.join(root, "local"), now: NOW });
    expect(await kind(store.save({ name, files: files(name) }))).toBe("unsafe-name");
    expect(await readdir(root)).toEqual([]);
  });

  it("skips a version folder left complete by an interrupted save", async () => {
    const store = createLocalStore({ root, now: NOW });
    await store.save({ name: "cut-release", files: files("cut-release") });
    const stale = path.join(root, "cut-release", "v2");
    await mkdir(stale, { recursive: true });
    await writeFile(path.join(stale, "SKILL.md"), "STALE");
    await writeFile(path.join(stale, ".agent-skill.json"), "{}");
    const saved = await store.save({ name: "cut-release", files: files("cut-release", "# NEW\n") });
    expect(saved.version).toBe(3);
    expect(await readFile(path.join(saved.dir, "SKILL.md"), "utf8")).toContain("# NEW");
  });
});
