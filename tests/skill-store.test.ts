import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SkillFile, SkillVersion } from "../server/langfuse";
import {
  ensureSkillVersion,
  MANIFEST_FILE,
  SkillStoreError,
  type SkillStoreErrorKind,
  versionDir,
} from "../server/skill-store";

const META = { baseUrl: "https://lf.example", now: () => new Date("2026-11-07T00:00:00.000Z") };

function file(filePath: string, content: string, contentType = "text/plain"): SkillFile {
  return {
    path: filePath,
    content,
    contentType,
    sha256Hash: createHash("sha256").update(content, "utf8").digest("base64"),
  };
}

const SKILL_MD = "# Cut release\nRun `bash <skill-dir>/bundle-migrations.sh` – done.\n";
const SCRIPT = "#!/usr/bin/env bash\necho bundle\n";

function cutRelease(files: SkillFile[] = [file("SKILL.md", SKILL_MD), file("bundle-migrations.sh", SCRIPT)]): SkillVersion {
  return { name: "cut-release", version: 2, files };
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lfs-store-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function listTree(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries.map(String).sort();
}

async function rejectionKind(promise: Promise<unknown>): Promise<SkillStoreErrorKind> {
  const error = await promise.then(
    () => {
      throw new Error("expected rejection");
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(SkillStoreError);
  return (error as SkillStoreError).kind;
}

describe("versionDir", () => {
  it("nests folder-style names", () => {
    expect(versionDir(root, "team/cut-release", 2)).toBe(path.join(root, "team", "cut-release", "v2"));
  });

  it.each(["../x", "a//b", ".", "a\\b", "", "a/./b"])("rejects unsafe name %j", (name) => {
    expect(() => versionDir(root, name, 2)).toThrow(SkillStoreError);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects version %s", (version) => {
    expect(() => versionDir(root, "cut-release", version)).toThrow(SkillStoreError);
  });
});

describe("ensureSkillVersion", () => {
  it("writes files and manifest on first use", async () => {
    const result = await ensureSkillVersion(root, { name: "cut-release", version: 2 }, async () => cutRelease(), META);
    expect(result).toEqual({ dir: path.join(root, "cut-release", "v2"), downloaded: true });
    expect(await readFile(path.join(result.dir, "SKILL.md"), "utf8")).toBe(SKILL_MD);
    expect(await readFile(path.join(result.dir, "bundle-migrations.sh"), "utf8")).toBe(SCRIPT);
    const manifest = JSON.parse(await readFile(path.join(result.dir, MANIFEST_FILE), "utf8"));
    expect(manifest).toEqual({
      name: "cut-release",
      version: 2,
      baseUrl: "https://lf.example",
      fetchedAt: "2026-11-07T00:00:00.000Z",
      files: cutRelease().files.map(({ path: p, sha256Hash }) => ({ path: p, sha256Hash })),
    });
  });

  it("reuses a stored version without loading", async () => {
    let loads = 0;
    const load = async () => {
      loads += 1;
      return cutRelease();
    };
    await ensureSkillVersion(root, { name: "cut-release", version: 2 }, load, META);
    const second = await ensureSkillVersion(root, { name: "cut-release", version: 2 }, load, META);
    expect(second.downloaded).toBe(false);
    expect(loads).toBe(1);
  });

  it("stores nested paths inside the version folder", async () => {
    const skill = { ...cutRelease([file("SKILL.md", SKILL_MD), file("scripts/run.sh", SCRIPT)]), name: "team/cut-release" };
    const { dir } = await ensureSkillVersion(root, { name: "team/cut-release", version: 2 }, async () => skill, META);
    expect(dir).toBe(path.join(root, "team", "cut-release", "v2"));
    expect(await readFile(path.join(dir, "scripts", "run.sh"), "utf8")).toBe(SCRIPT);
  });

  const bad: Array<[string, SkillFile[], SkillStoreErrorKind]> = [
    ["parent path", [file("SKILL.md", SKILL_MD), file("../evil", "x")], "unsafe-path"],
    ["absolute path", [file("SKILL.md", SKILL_MD), file("/etc/x", "x")], "unsafe-path"],
    ["drive path", [file("SKILL.md", SKILL_MD), file("C:/x", "x")], "unsafe-path"],
    ["nested escape", [file("SKILL.md", SKILL_MD), file("a/../../x", "x")], "unsafe-path"],
    ["manifest path", [file("SKILL.md", SKILL_MD), file(MANIFEST_FILE, "{}")], "unsafe-path"],
    ["duplicate path", [file("SKILL.md", SKILL_MD), file("SKILL.md", "again")], "duplicate-path"],
    ["no SKILL.md", [file("README.md", "hi")], "no-skill-md"],
    ["wrong hash", [{ ...file("SKILL.md", SKILL_MD), sha256Hash: "AAAA" }], "hash-mismatch"],
  ];

  it.each(bad)("refuses %s and leaves nothing behind", async (_label, files, kind) => {
    const promise = ensureSkillVersion(root, { name: "cut-release", version: 2 }, async () => cutRelease(files), META);
    expect(await rejectionKind(promise)).toBe(kind);
    expect(await listTree(root)).toEqual([]);
  });

  it("refuses non-text files with a clear message", async () => {
    const skill = cutRelease([file("SKILL.md", SKILL_MD), file("logo.png", "png", "image/png")]);
    await expect(
      ensureSkillVersion(root, { name: "cut-release", version: 2 }, async () => skill, META),
    ).rejects.toThrow(
      "Skill cut-release v2 contains a non-text file (logo.png, image/png), which this plugin does not support yet.",
    );
    expect(await listTree(root)).toEqual([]);
  });

  it("lets concurrent stores of the same version agree on one folder", async () => {
    const ref = { name: "cut-release", version: 2 };
    const results = await Promise.all(
      Array.from({ length: 4 }, () => ensureSkillVersion(root, ref, async () => cutRelease(), META)),
    );
    const dir = path.join(root, "cut-release", "v2");
    expect(new Set(results.map((result) => result.dir))).toEqual(new Set([dir]));
    expect(await listTree(path.join(root, "cut-release"))).toEqual(
      ["v2", `v2/${MANIFEST_FILE}`, "v2/SKILL.md", "v2/bundle-migrations.sh"].map((p) => path.normalize(p)).sort(),
    );
  });

  it("never removes a folder another call already returned", async () => {
    const ref = { name: "cut-release", version: 2 };
    for (let round = 0; round < 20; round += 1) {
      await rm(path.join(root, "cut-release"), { recursive: true, force: true });
      const missing: string[] = [];
      await Promise.all(
        Array.from({ length: 16 }, async () => {
          const { dir } = await ensureSkillVersion(root, ref, async () => cutRelease(), META);
          await readFile(path.join(dir, "SKILL.md"), "utf8").catch(() => missing.push(dir));
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(missing).toEqual([]);
      expect(await readFile(path.join(root, "cut-release", "v2", "SKILL.md"), "utf8")).toBe(SKILL_MD);
    }
  });

  it("refuses a file that is also used as a folder", async () => {
    const files = [file("SKILL.md", SKILL_MD), file("a", "x"), file("a/b", "y")];
    const promise = ensureSkillVersion(root, { name: "cut-release", version: 2 }, async () => cutRelease(files), META);
    expect(await rejectionKind(promise)).toBe("path-conflict");
    expect(await listTree(root)).toEqual([]);
  });

  it("reports a failed write as a store error and leaves nothing behind", async () => {
    const files = [file("SKILL.md", SKILL_MD), file("x".repeat(300), "too long")];
    const promise = ensureSkillVersion(root, { name: "cut-release", version: 2 }, async () => cutRelease(files), META);
    expect(await rejectionKind(promise)).toBe("write-failed");
    // Only the skill's empty parent folder may remain; no version or temp folder.
    expect(await listTree(root)).toEqual(["cut-release"]);
  });

  it("refuses a download whose version differs from the one requested", async () => {
    const promise = ensureSkillVersion(
      root,
      { name: "cut-release", version: 3 },
      async () => ({ ...cutRelease(), version: 4 }),
      META,
    );
    expect(await rejectionKind(promise)).toBe("version-mismatch");
    expect(await listTree(root)).toEqual([]);
  });

  it("replaces a version folder that has no manifest", async () => {
    const dir = path.join(root, "cut-release", "v2");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "stray.txt"), "left over");
    const result = await ensureSkillVersion(root, { name: "cut-release", version: 2 }, async () => cutRelease(), META);
    expect(result.downloaded).toBe(true);
    expect(await listTree(dir)).toEqual([MANIFEST_FILE, "SKILL.md", "bundle-migrations.sh"].sort());
  });
});
