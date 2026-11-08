import { describe, expect, it } from "vitest";
import {
  addFile,
  addFolder,
  buildTree,
  checkPath,
  type DraftResult,
  isDirty,
  openDraft,
  removePath,
  renamePath,
  type SkillDraft,
  setContent,
} from "../shared/skill-draft";

const FILES = [
  { path: "SKILL.md", content: "---\nname: cut-release\n---\n" },
  { path: "templates/changelog.md", content: "# Changelog\n" },
  { path: "templates/sub/x.md", content: "x\n" },
];

function draft(): SkillDraft {
  return openDraft("cut-release", 3, FILES);
}

function ok(result: DraftResult): SkillDraft {
  if (!result.ok) throw new Error(result.error);
  return result.draft;
}

describe("isDirty", () => {
  it("tracks content changes back to the original", () => {
    const opened = draft();
    expect(isDirty(opened)).toBe(false);
    const edited = setContent(opened, "SKILL.md", "changed");
    expect(isDirty(edited)).toBe(true);
    expect(isDirty(setContent(edited, "SKILL.md", FILES[0]?.content ?? ""))).toBe(false);
    expect(opened.files).toEqual(FILES);
  });
});

describe("addFile and addFolder", () => {
  it("adds an empty file and shows folders before files", () => {
    const next = ok(addFile(draft(), "scripts/run.sh"));
    expect(next.files.find((file) => file.path === "scripts/run.sh")?.content).toBe("");
    const tree = buildTree(next.files);
    expect(tree.map((node) => `${node.kind}:${node.name}`)).toEqual(["folder:scripts", "folder:templates", "file:SKILL.md"]);
    expect(tree[1]?.children.map((node) => node.name)).toEqual(["sub", "changelog.md"]);
  });

  it("keeps an empty folder until a file is added to it", () => {
    const withFolder = ok(addFolder(draft(), "assets"));
    expect(withFolder.files).toHaveLength(3);
    expect(buildTree(withFolder.files, withFolder.emptyFolders).map((node) => node.path)).toContain("assets");
    const withFile = ok(addFile(withFolder, "assets/a.md"));
    expect(withFile.emptyFolders).toEqual([]);
    expect(isDirty(withFolder)).toBe(false);
  });

  it("refuses existing paths and files used as folders", () => {
    expect(addFile(draft(), "SKILL.md")).toEqual({ ok: false, error: "SKILL.md already exists." });
    expect(addFile(draft(), "SKILL.md/x")).toEqual({ ok: false, error: "SKILL.md is a file." });
    expect(addFolder(draft(), "templates")).toEqual({ ok: false, error: "templates already exists." });
  });
});

describe("renamePath and removePath", () => {
  it("moves every file under a renamed folder", () => {
    const next = ok(renamePath(draft(), "templates", "docs"));
    expect(next.files.map((file) => file.path).sort()).toEqual(["SKILL.md", "docs/changelog.md", "docs/sub/x.md"]);
  });

  it("renames a file", () => {
    const next = ok(renamePath(draft(), "templates/changelog.md", "CHANGELOG.md"));
    expect(next.files.map((file) => file.path)).toContain("CHANGELOG.md");
  });

  it("refuses renaming onto an existing path and leaves the draft alone", () => {
    const opened = draft();
    expect(renamePath(opened, "templates/changelog.md", "SKILL.md")).toEqual({ ok: false, error: "SKILL.md already exists." });
    expect(opened.files).toEqual(FILES);
  });

  it("removes a folder recursively", () => {
    const next = ok(removePath(draft(), "templates"));
    expect(next.files.map((file) => file.path)).toEqual(["SKILL.md"]);
  });
});

describe("checkPath", () => {
  it.each(["../x", "a//b", "/abs", "a\\b", "", ".agent-skill.json", ".langfuse-skill.json", "a/./b"])(
    "refuses %j",
    (bad) => {
      expect(checkPath(bad)).toBe(`"${bad}" is not a valid file path.`);
    },
  );

  it("accepts a nested path", () => {
    expect(checkPath("scripts/run.sh")).toBeNull();
  });

  it("is applied by addFile", () => {
    expect(addFile(draft(), "../x")).toEqual({ ok: false, error: '"../x" is not a valid file path.' });
  });
});
