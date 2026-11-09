import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  contentHash,
  parseFrontmatter,
  readSkillFolder,
  SkillFolderError,
  type SkillFolderErrorKind,
} from "../server/skill-folder";

const SKILL_MD = '---\nname: cut-release\ndescription: "Cut a release"\n---\n# Cut a release\n';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lfs-folder-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(relative: string, content: string | Buffer): Promise<string> {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  return target;
}

async function kind(promise: Promise<unknown>): Promise<SkillFolderErrorKind> {
  const error = await promise.then(
    () => {
      throw new Error("expected rejection");
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(SkillFolderError);
  return (error as SkillFolderError).kind;
}

describe("readSkillFolder", () => {
  it("reads name, description and every file with / paths", async () => {
    await put("skill/SKILL.md", SKILL_MD);
    await put("skill/bundle-migrations.sh", "echo hi\n");
    await put("skill/templates/changelog.md", "# Changelog\n");
    const folder = await readSkillFolder(path.join(root, "skill"));
    expect(folder.name).toBe("cut-release");
    expect(folder.description).toBe("Cut a release");
    expect(folder.files.map((file) => file.path).sort()).toEqual([
      "SKILL.md",
      "bundle-migrations.sh",
      "templates/changelog.md",
    ]);
    expect(folder.files.find((file) => file.path === "bundle-migrations.sh")?.content).toBe("echo hi\n");
  });

  it("accepts an empty file as text", async () => {
    await put("skill/SKILL.md", SKILL_MD);
    await put("skill/__init__.py", "");
    const folder = await readSkillFolder(path.join(root, "skill"));
    expect(folder.files).toHaveLength(2);
  });

  it("refuses a binary file and names it", async () => {
    await put("skill/SKILL.md", SKILL_MD);
    await put("skill/assets/logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    const dir = path.join(root, "skill");
    await expect(readSkillFolder(dir)).rejects.toThrow(`${dir} is not importable: assets/logo.png is not a text file.`);
    expect(await kind(readSkillFolder(dir))).toBe("non-text");
  });

  it("refuses invalid UTF-8", async () => {
    await put("skill/SKILL.md", SKILL_MD);
    await put("skill/latin1.txt", Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    expect(await kind(readSkillFolder(path.join(root, "skill")))).toBe("non-text");
  });

  it("reports a missing SKILL.md, a missing name and a missing folder", async () => {
    await put("a/README.md", "hi");
    expect(await kind(readSkillFolder(path.join(root, "a")))).toBe("no-skill-md");
    await put("b/SKILL.md", "---\ndescription: x\n---\n");
    expect(await kind(readSkillFolder(path.join(root, "b")))).toBe("no-name");
    expect(await kind(readSkillFolder(path.join(root, "nope")))).toBe("missing");
  });

  it("refuses more than 200 files", async () => {
    await put("skill/SKILL.md", SKILL_MD);
    for (let index = 0; index < 200; index += 1) await put(`skill/f/${index}.txt`, "x");
    const dir = path.join(root, "skill");
    await expect(readSkillFolder(dir)).rejects.toThrow(
      `Skill folder ${dir} has more than 200 files or 2 MB; skills that large are not supported.`,
    );
  });

  it("refuses more than 2 MB", async () => {
    await put("skill/SKILL.md", SKILL_MD);
    await put("skill/big.txt", "a".repeat(2.1 * 1024 * 1024));
    expect(await kind(readSkillFolder(path.join(root, "skill")))).toBe("too-large");
  });

  it("follows a symlinked skill folder and a symlinked SKILL.md", async () => {
    const outside = await put("shared/SKILL.md", SKILL_MD);
    await put("real/run.sh", "echo run\n");
    await symlink(outside, path.join(root, "real", "SKILL.md"));
    await symlink(path.join(root, "real"), path.join(root, "linked"));
    const folder = await readSkillFolder(path.join(root, "linked"));
    expect(folder.name).toBe("cut-release");
    expect(folder.files.map((file) => file.path).sort()).toEqual(["SKILL.md", "run.sh"]);
  });

  it("stops on a symlink loop", async () => {
    await put("skill/SKILL.md", SKILL_MD);
    await symlink(path.join(root, "skill"), path.join(root, "skill", "again"));
    expect(await kind(readSkillFolder(path.join(root, "skill")))).toBe("loop");
  });
});

describe("contentHash", () => {
  it("ignores order and changes with content", () => {
    const a = { path: "SKILL.md", content: "x" };
    const b = { path: "run.sh", content: "y" };
    expect(contentHash([a, b])).toBe(contentHash([b, a]));
    expect(contentHash([a, b])).not.toBe(contentHash([a, { ...b, content: "z" }]));
  });
});

describe("parseFrontmatter", () => {
  it("reads quoted values and ignores the body", () => {
    expect(parseFrontmatter("---\nname: 'a'\n---\nbody")).toEqual({ name: "a" });
  });

  it("returns nothing without frontmatter", () => {
    expect(parseFrontmatter("# Title\nname: b\n")).toEqual({});
  });
});

describe("external files", () => {
  it("flags a file that is a symlink to outside the skill folder", async () => {
    const outside = await put("shared/SKILL.md", SKILL_MD);
    await put("skill/run.sh", "echo\n");
    await symlink(outside, path.join(root, "skill", "SKILL.md"));
    const folder = await readSkillFolder(path.join(root, "skill"));
    expect(folder.files.find((file) => file.path === "SKILL.md")?.external).toBe(true);
    expect(folder.files.find((file) => file.path === "run.sh")?.external).toBeUndefined();
  });

  it("does not flag files of a symlinked skill folder", async () => {
    await put("real/SKILL.md", SKILL_MD);
    await symlink(path.join(root, "real"), path.join(root, "linked"));
    const folder = await readSkillFolder(path.join(root, "linked"));
    expect(folder.files.every((file) => file.external === undefined)).toBe(true);
  });
});
