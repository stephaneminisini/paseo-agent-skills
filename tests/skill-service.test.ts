import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LangfuseClient, SkillFile, SkillRef, SkillSummary, SkillVersion } from "../server/langfuse";
import { createLocalStore, type LocalStore } from "../server/local-store";
import { createSkillService } from "../server/skill-service";
import { ConfigSchema } from "../shared/settings";
import { attachmentText, currentNoteText, newSkillTemplate } from "../shared/skills";

function file(filePath: string, content: string, contentType = "text/plain"): SkillFile {
  return {
    path: filePath,
    content,
    contentType,
    sha256Hash: createHash("sha256").update(content, "utf8").digest("base64"),
  };
}

interface FakeSkill {
  summary: SkillSummary;
  /** Version the label currently points at; null when unlabeled. */
  labeled: number | null;
  versions: Record<number, SkillFile[]>;
}

class FakeLangfuse implements LangfuseClient {
  listCalls = 0;
  versionCalls: Array<[string, number]> = [];
  constructor(
    public skills: FakeSkill[],
    private readonly onResolve?: (skill: FakeSkill) => void,
  ) {}
  async listSkills() {
    this.listCalls += 1;
    return this.skills.map((skill) => skill.summary);
  }
  async resolveSkill(name: string): Promise<SkillRef | null> {
    const skill = this.skills.find((candidate) => candidate.summary.name === name);
    if (!skill || skill.labeled === null) return null;
    const ref = { name, version: skill.labeled, description: skill.summary.description };
    this.onResolve?.(skill);
    return ref;
  }
  async getSkillVersion(name: string, version: number): Promise<SkillVersion> {
    this.versionCalls.push([name, version]);
    const skill = this.skills.find((candidate) => candidate.summary.name === name);
    const files = skill?.versions[version];
    if (!files) throw new Error(`no ${name} v${version}`);
    return { name, version, files };
  }
  async testConnection() {
    return { projectName: "Acme" };
  }
  async createSkillVersion(): Promise<{ name: string; version: number }> {
    throw new Error("not used in these tests");
  }
}

const CUT_RELEASE: FakeSkill = {
  summary: { name: "cut-release", description: "Cut a release" },
  labeled: 2,
  versions: {
    2: [file("SKILL.md", "# v2"), file("bundle-migrations.sh", "echo v2")],
    3: [file("SKILL.md", "# v3"), file("bundle-migrations.sh", "echo v3")],
  },
};
const DRAFT: FakeSkill = { summary: { name: "draft-only", description: "" }, labeled: null, versions: {} };
const IMAGES: FakeSkill = {
  summary: { name: "release-images", description: "" },
  labeled: 1,
  versions: { 1: [file("SKILL.md", "# img"), file("logo.png", "png", "image/png")] },
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lfs-service-"));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

let localStore: LocalStore;
let home: string;
beforeEach(async () => {
  localStore = createLocalStore({ root: path.join(root, "local") });
  home = path.join(root, "home");
  await mkdir(home, { recursive: true });
});

function service(client: FakeLangfuse, clock = { now: 0 }) {
  return createSkillService({
    readConfig: async () => ConfigSchema.parse({ baseUrl: "https://lf.example" }),
    readKeys: async () => ({ publicKey: "pk", secretKey: "sk" }),
    createLangfuse: () => client,
    storeRoot: path.join(root, "langfuse"),
    localStore,
    home,
    now: () => clock.now,
  });
}

function localFiles(name: string, description = `About ${name}`) {
  return [{ path: "SKILL.md", content: `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n` }];
}

describe("attachmentText", () => {
  it("is the exact three-line note", () => {
    expect(attachmentText("cut-release", "Langfuse", 2, "/s/cut-release/v2")).toBe(
      [
        'Use the skill "cut-release" (Langfuse version 2).',
        "Its files are in /s/cut-release/v2. Read /s/cut-release/v2/SKILL.md now and follow it for this task.",
        "Where SKILL.md writes <skill-dir>, use /s/cut-release/v2.",
      ].join("\n"),
    );
  });
});

describe("createSkillService.search", () => {
  it("stores the labeled version and returns a ready attachment", async () => {
    const { items } = await service(new FakeLangfuse([CUT_RELEASE, DRAFT])).search("release");
    const dir = path.join(root, "langfuse", "cut-release", "v2");
    expect(items).toEqual([
      {
        id: "cut-release@2",
        identifier: "cut-release",
        title: "cut-release",
        subtitle: "v2 · production · Cut a release",
        url: `file://${dir}`,
        text: attachmentText("cut-release", "Langfuse", 2, dir),
        resourceType: "skill",
      },
    ]);
    expect(await readFile(path.join(dir, "SKILL.md"), "utf8")).toBe("# v2");
  });

  it("matches the description and omits unlabeled skills", async () => {
    const client = new FakeLangfuse([CUT_RELEASE, DRAFT]);
    expect((await service(client).search("A RELEASE")).items.map((item) => item.id)).toEqual(["cut-release@2"]);
    expect((await service(client).search("")).items.map((item) => item.id)).toEqual(["cut-release@2"]);
  });

  it("downloads the resolved version even when the label moves afterwards", async () => {
    const moving: FakeSkill = { ...CUT_RELEASE, versions: { ...CUT_RELEASE.versions } };
    const client = new FakeLangfuse([moving], (skill) => {
      skill.labeled = 3;
    });
    const { items } = await service(client).search("cut");
    expect(items[0]?.text).toContain("Langfuse version 2");
    expect(client.versionCalls).toEqual([["cut-release", 2]]);
    expect(await readFile(path.join(root, "langfuse", "cut-release", "v2", "SKILL.md"), "utf8")).toBe("# v2");
  });

  it("reuses the skill list for 60 seconds", async () => {
    const client = new FakeLangfuse([CUT_RELEASE]);
    const clock = { now: 0 };
    const skills = service(client, clock);
    await skills.search("cut");
    await skills.search("cut");
    expect(client.listCalls).toBe(1);
    clock.now = 61_000;
    await skills.search("cut");
    expect(client.listCalls).toBe(2);
  });

  it("skips a broken skill when another one matches", async () => {
    const { items } = await service(new FakeLangfuse([CUT_RELEASE, IMAGES])).search("release");
    expect(items.map((item) => item.id)).toEqual(["cut-release@2"]);
  });

  it("reports the error when every matching skill is broken", async () => {
    await expect(service(new FakeLangfuse([CUT_RELEASE, IMAGES])).search("images")).rejects.toThrow(
      "Skill release-images v1 contains a non-text file (logo.png, image/png)",
    );
  });
});

describe("createSkillService.testLangfuse", () => {
  it("returns the project name", async () => {
    expect(await service(new FakeLangfuse([])).testLangfuse()).toEqual({ projectName: "Acme" });
  });
});

describe("local skills", () => {
  it("writes the local note", () => {
    expect(attachmentText("pr-review", "local", 3, "/d").split("\n")[0]).toBe('Use the skill "pr-review" (local version 3).');
  });

  it("returns matching local skills in search", async () => {
    for (let index = 0; index < 3; index += 1) await localStore.save({ name: "pr-review", files: localFiles("pr-review") });
    const { items } = await service(new FakeLangfuse([CUT_RELEASE])).search("review");
    expect(items).toHaveLength(1);
    const dir = path.join(root, "local", "pr-review", "v3");
    expect(items[0]).toMatchObject({
      id: "local:pr-review@3",
      title: "pr-review",
      subtitle: "Local v3 · About pr-review",
      text: attachmentText("pr-review", "local", 3, dir),
      resourceType: "skill",
    });
  });

  it("lists a local and a Langfuse skill of the same name separately, local first", async () => {
    await localStore.save({ name: "cut-release", files: localFiles("cut-release") });
    const { items } = await service(new FakeLangfuse([CUT_RELEASE])).search("cut");
    expect(items.map((item) => item.id)).toEqual(["local:cut-release@1", "cut-release@2"]);
  });

  it("still returns local skills when Langfuse fails", async () => {
    await localStore.save({ name: "pr-review", files: localFiles("pr-review") });
    const client = new FakeLangfuse([]);
    client.listSkills = async () => {
      throw new Error("Langfuse down");
    };
    const { items } = await service(client).search("review");
    expect(items.map((item) => item.id)).toEqual(["local:pr-review@1"]);
  });
});

describe("createSkillService.list", () => {
  async function putHome(relative: string, content: string | Buffer) {
    const target = path.join(home, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  it("merges local, Langfuse and found into one row per name", async () => {
    await putHome(".claude/skills/cut-release/SKILL.md", localFiles("cut-release")[0]?.content ?? "");
    await localStore.save({ name: "cut-release", files: localFiles("cut-release") });
    await putHome(".claude/skills/img/SKILL.md", localFiles("img")[0]?.content ?? "");
    await putHome(".claude/skills/img/logo.png", Buffer.from([0x89, 0x00]));
    const { rows, langfuseError } = await service(new FakeLangfuse([CUT_RELEASE])).list({});
    expect(langfuseError).toBeNull();
    const cut = rows.find((row) => row.name === "cut-release");
    expect(cut?.local).toEqual({ version: 1, sourceStatus: null, sourceLabel: null, syncedVersion: null, localChanges: false });
    expect(cut?.langfuse).toEqual({ latestVersion: 2, labeledVersion: 2 });
    expect(cut?.found).toEqual([
      expect.objectContaining({ label: "~/.claude/skills", importable: true, reason: null }),
    ]);
    const img = rows.find((row) => row.name === "img");
    expect(img?.local).toBeNull();
    expect(img?.found[0]?.importable).toBe(false);
    expect(img?.found[0]?.reason).toContain("logo.png");
  });

  it("returns rows and the Langfuse error when Langfuse fails", async () => {
    await localStore.save({ name: "pr-review", files: localFiles("pr-review") });
    const client = new FakeLangfuse([]);
    client.listSkills = async () => {
      throw new Error("Langfuse down");
    };
    const { rows, langfuseError } = await service(client).list({});
    expect(rows.map((row) => row.name)).toEqual(["pr-review"]);
    expect(langfuseError).toBe("Langfuse down");
  });
});

describe("createSkillService.importPath", () => {
  it("expands ~ to the home folder", async () => {
    const dir = path.join(home, "my-skills", "pr-review");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), localFiles("pr-review")[0]?.content ?? "");
    expect(await service(new FakeLangfuse([])).importPath("~/my-skills/pr-review")).toEqual({
      name: "pr-review",
      version: 1,
      needsConfirm: false,
    });
  });
});

describe("importPath replace confirmation", () => {
  it("asks before replacing an existing local skill", async () => {
    await localStore.save({ name: "pr-review", files: localFiles("pr-review") });
    const dir = path.join(home, "pr-review");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), localFiles("pr-review", "Changed")[0]?.content ?? "");
    const skills = service(new FakeLangfuse([]));
    expect(await skills.importPath(dir)).toEqual({ name: "pr-review", version: 1, needsConfirm: true });
    expect((await localStore.get("pr-review"))?.version).toBe(1);
    expect(await skills.importPath(dir, true)).toEqual({ name: "pr-review", version: 2, needsConfirm: false });
  });
});

describe("read, save, create, remove", () => {
  it("reads a local skill without the marker", async () => {
    await localStore.save({ name: "pr-review", files: localFiles("pr-review") });
    const result = await service(new FakeLangfuse([])).read({ kind: "local", name: "pr-review" });
    expect(result).toEqual({ name: "pr-review", version: 1, files: localFiles("pr-review"), error: null });
  });

  it("reads the labeled Langfuse version without the manifest", async () => {
    const result = await service(new FakeLangfuse([CUT_RELEASE])).read({ kind: "langfuse", name: "cut-release" });
    expect(result.version).toBe(2);
    expect(result.files.map((file) => file.path).sort()).toEqual(["SKILL.md", "bundle-migrations.sh"]);
    expect(result.error).toBeNull();
  });

  it("reads a found skill and reports a not-importable one", async () => {
    const good = path.join(home, ".claude/skills/good");
    await mkdir(good, { recursive: true });
    await writeFile(path.join(good, "SKILL.md"), localFiles("good")[0]?.content ?? "");
    const bad = path.join(home, ".claude/skills/bad");
    await mkdir(bad, { recursive: true });
    await writeFile(path.join(bad, "SKILL.md"), localFiles("bad")[0]?.content ?? "");
    await writeFile(path.join(bad, "logo.png"), Buffer.from([0x89, 0x00]));
    const skills = service(new FakeLangfuse([]));
    const rows = (await skills.list({})).rows;
    const goodId = rows.find((row) => row.name === "good")?.found[0]?.id ?? "";
    const badId = rows.find((row) => row.name === "bad")?.found[0]?.id ?? "";
    expect((await skills.read({ kind: "found", id: goodId })).files).toHaveLength(1);
    const blocked = await skills.read({ kind: "found", id: badId });
    expect(blocked.files).toEqual([]);
    expect(blocked.error).toContain("logo.png");
  });

  it("rejects an unknown local skill", async () => {
    await expect(service(new FakeLangfuse([])).read({ kind: "local", name: "nope" })).rejects.toThrow(
      "Skill not found; refresh the list.",
    );
  });

  it("saves the next version and refuses stale or invalid saves", async () => {
    await localStore.save({ name: "pr-review", files: localFiles("pr-review") });
    const skills = service(new FakeLangfuse([]));
    expect(await skills.save("pr-review", localFiles("pr-review", "Changed"), 1)).toEqual({ name: "pr-review", version: 2 });
    await expect(skills.save("pr-review", localFiles("pr-review"), 1)).rejects.toThrow("This skill was changed elsewhere; reload.");
    await expect(skills.save("pr-review", [{ path: "notes.md", content: "x" }], 2)).rejects.toThrow("has no SKILL.md");
    await expect(skills.save("pr-review", localFiles("other"), 2)).rejects.toThrow("Renaming means creating a new skill.");
  });

  it("creates a skill from the template", async () => {
    const skills = service(new FakeLangfuse([]));
    expect(await skills.create("  pr-review ")).toEqual({ name: "pr-review", version: 1 });
    const read = await skills.read({ kind: "local", name: "pr-review" });
    expect(read.files).toEqual([{ path: "SKILL.md", content: newSkillTemplate("pr-review") }]);
    await expect(skills.create("pr-review")).rejects.toThrow("A local skill named pr-review already exists.");
    await expect(skills.create(" ")).rejects.toThrow("Enter a skill name.");
  });

  it("removes a local skill", async () => {
    const skills = service(new FakeLangfuse([]));
    await skills.create("pr-review");
    await skills.remove("pr-review");
    expect(await localStore.get("pr-review")).toBeNull();
  });
});

describe("newSkillTemplate", () => {
  it("is the exact template", () => {
    expect(newSkillTemplate("x")).toBe(
      "---\nname: x\ndescription: Describe when an agent should use this skill.\n---\n\n# x\n\nInstructions for the agent.\n",
    );
  });
});

describe("reading a skill at the file limit", () => {
  it("opens a local skill with exactly 200 files", async () => {
    const many = [...localFiles("full"), ...Array.from({ length: 199 }, (_, index) => ({ path: `f/${index}.txt`, content: "x" }))];
    await localStore.save({ name: "full", files: many });
    const result = await service(new FakeLangfuse([])).read({ kind: "local", name: "full" });
    expect(result.files).toHaveLength(200);
  });
});

describe("note", () => {
  it("returns the pinned and the current note for a local skill", async () => {
    await localStore.save({ name: "pr-review", files: localFiles("pr-review") });
    await localStore.save({ name: "pr-review", files: localFiles("pr-review", "Changed") });
    const skills = service(new FakeLangfuse([]));
    const pinned = await skills.note("pr-review", "pinned");
    expect(pinned.text).toBe(attachmentText("pr-review", "local", 2, path.join(root, "local", "pr-review", "v2")));
    const current = await skills.note("pr-review", "current");
    const dir = path.join(root, "local", "pr-review", "current");
    expect(current.text).toBe(currentNoteText("pr-review", dir));
    expect(current.text.split("\n")[0]).toBe('Use the skill "pr-review" (latest saved local version).');
  });

  it("rejects an unknown skill", async () => {
    await expect(service(new FakeLangfuse([])).note("nope", "pinned")).rejects.toThrow("Skill not found; refresh the list.");
  });
});
