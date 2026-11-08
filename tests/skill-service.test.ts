import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LangfuseClient, SkillFile, SkillRef, SkillSummary, SkillVersion } from "../server/langfuse";
import { createLocalStore, type LocalStore } from "../server/local-store";
import { createSkillService } from "../server/skill-service";
import { ConfigSchema } from "../shared/settings";
import { attachmentText } from "../shared/skills";

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
    expect(cut?.local).toEqual({ version: 1, sourceStatus: null, sourceLabel: null });
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
