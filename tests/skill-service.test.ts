import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LangfuseClient, SkillFile, SkillRef, SkillSummary, SkillVersion } from "../server/langfuse";
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

function service(client: FakeLangfuse, clock = { now: 0 }) {
  return createSkillService({
    readConfig: async () => ConfigSchema.parse({ baseUrl: "https://lf.example" }),
    readKeys: async () => ({ publicKey: "pk", secretKey: "sk" }),
    createLangfuse: () => client,
    storeRoot: root,
    now: () => clock.now,
  });
}

describe("attachmentText", () => {
  it("is the exact three-line note", () => {
    expect(attachmentText("cut-release", 2, "/s/cut-release/v2")).toBe(
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
    const dir = path.join(root, "cut-release", "v2");
    expect(items).toEqual([
      {
        id: "cut-release@2",
        identifier: "cut-release",
        title: "cut-release",
        subtitle: "v2 · production · Cut a release",
        url: `file://${dir}`,
        text: attachmentText("cut-release", 2, dir),
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
    expect(await readFile(path.join(root, "cut-release", "v2", "SKILL.md"), "utf8")).toBe("# v2");
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
