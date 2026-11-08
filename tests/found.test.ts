import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scanFound } from "../server/found";
import { importFound, importFromPath, reimport, sourceStatus } from "../server/importer";
import { createLocalStore, type LocalStore } from "../server/local-store";

function skillMd(name: string, body = "# Skill\n"): string {
  return `---\nname: ${name}\ndescription: About ${name}\n---\n${body}`;
}

let home: string;
let store: LocalStore;
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "lfs-home-"));
  store = createLocalStore({ root: path.join(home, "store") });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

async function put(relative: string, content: string | Buffer): Promise<string> {
  const target = path.join(home, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  return target;
}

async function installPlugin(installPath: string, entries: Array<{ installPath: string; lastUpdated: string; version: string }>) {
  await put(
    ".claude/plugins/installed_plugins.json",
    JSON.stringify({ version: 2, plugins: { "superpowers@official": entries } }),
  );
  return installPath;
}

describe("scanFound", () => {
  it("finds folder skills, symlinked skills and installed plugin skills", async () => {
    await put(".claude/skills/cut-release/SKILL.md", skillMd("cut-release"));
    await put("elsewhere/review/SKILL.md", skillMd("review"));
    await mkdir(path.join(home, ".agents", "skills"), { recursive: true });
    await symlink(path.join(home, "elsewhere", "review"), path.join(home, ".agents", "skills", "review"));
    await put(".claude/skills/no-skill/README.md", "hi");
    await put(".claude/skills/binary/SKILL.md", skillMd("binary"));
    await put(".claude/skills/binary/logo.png", Buffer.from([0x89, 0x00, 0x01]));
    const newer = path.join(home, ".claude/plugins/cache/official/superpowers/7.0.0");
    const older = path.join(home, ".claude/plugins/cache/official/superpowers/6.0.0");
    await put(".claude/plugins/cache/official/superpowers/7.0.0/skills/brainstorming/SKILL.md", skillMd("brainstorming"));
    await put(".claude/plugins/cache/official/superpowers/6.0.0/skills/old-skill/SKILL.md", skillMd("old-skill"));
    await installPlugin(newer, [
      { installPath: older, lastUpdated: "2026-01-01T00:00:00.000Z", version: "6.0.0" },
      { installPath: newer, lastUpdated: "2026-10-01T00:00:00.000Z", version: "7.0.0" },
    ]);

    const found = await scanFound(home);
    const byName = Object.fromEntries(found.map((skill) => [skill.name, skill]));
    expect(Object.keys(byName).sort()).toEqual(["binary", "brainstorming", "cut-release", "review"]);
    expect(byName["cut-release"]?.origin).toEqual({ kind: "folder", tool: "claude" });
    expect(byName["cut-release"]?.importable).toBe(true);
    expect(byName.review?.origin).toEqual({ kind: "folder", tool: "agents" });
    expect(byName.brainstorming?.origin).toEqual({
      kind: "claude-plugin",
      marketplace: "official",
      plugin: "superpowers",
      version: "7.0.0",
    });
    expect(byName.brainstorming?.id).toBe("claude-plugin:official/superpowers/brainstorming");
    const binary = byName.binary?.importable;
    expect(binary).not.toBe(true);
    expect(binary === true ? "" : binary?.reason).toContain("logo.png");
  });

  it("returns nothing when no skill folders exist", async () => {
    expect(await scanFound(home)).toEqual([]);
  });
});

describe("import and source status", () => {
  it("imports a folder with a path source and tracks changes", async () => {
    const dir = path.dirname(await put(".claude/skills/cut-release/SKILL.md", skillMd("cut-release")));
    await put(".claude/skills/cut-release/run.sh", "echo 1\n");
    const before = await stat(path.join(dir, "run.sh"));
    const skill = await importFromPath(store, dir, home);
    expect(skill.version).toBe(1);
    expect(skill.source).toEqual({ kind: "path", path: dir });
    expect(await sourceStatus(home, skill)).toBe("unchanged");
    expect((await stat(path.join(dir, "run.sh"))).mtimeMs).toBe(before.mtimeMs);

    await writeFile(path.join(dir, "run.sh"), "echo 2\n");
    expect(await sourceStatus(home, skill)).toBe("updated");
    const second = await reimport(store, home, "cut-release");
    expect(second.version).toBe(2);
    expect(await sourceStatus(home, second)).toBe("unchanged");

    await rm(dir, { recursive: true });
    expect(await sourceStatus(home, second)).toBe("missing");
  });

  it("records a plugin source and follows the plugin to a new install path", async () => {
    const v7 = path.join(home, ".claude/plugins/cache/official/superpowers/7.0.0");
    await put(".claude/plugins/cache/official/superpowers/7.0.0/skills/brainstorming/SKILL.md", skillMd("brainstorming"));
    await installPlugin(v7, [{ installPath: v7, lastUpdated: "2026-10-01T00:00:00.000Z", version: "7.0.0" }]);
    const skill = await importFound(store, home, "claude-plugin:official/superpowers/brainstorming");
    expect(skill.source).toEqual({ kind: "claude-plugin", marketplace: "official", plugin: "superpowers", skill: "brainstorming" });

    const v8 = path.join(home, ".claude/plugins/cache/official/superpowers/8.0.0");
    await put(".claude/plugins/cache/official/superpowers/8.0.0/skills/brainstorming/SKILL.md", skillMd("brainstorming", "# new\n"));
    await installPlugin(v8, [{ installPath: v8, lastUpdated: "2026-11-01T00:00:00.000Z", version: "8.0.0" }]);
    await rm(v7, { recursive: true });
    expect(await sourceStatus(home, skill)).toBe("updated");
    const second = await reimport(store, home, "brainstorming");
    expect(second.version).toBe(2);
  });

  it("detects a plugin source when importing by path", async () => {
    const v7 = path.join(home, ".claude/plugins/cache/official/superpowers/7.0.0");
    const skillMdPath = await put(".claude/plugins/cache/official/superpowers/7.0.0/skills/brainstorming/SKILL.md", skillMd("brainstorming"));
    await installPlugin(v7, [{ installPath: v7, lastUpdated: "2026-10-01T00:00:00.000Z", version: "7.0.0" }]);
    const skill = await importFromPath(store, path.dirname(skillMdPath), home);
    expect(skill.source?.kind).toBe("claude-plugin");
  });

  it("rejects an unknown found id", async () => {
    await expect(importFound(store, home, "path:/nope")).rejects.toThrow("Skill not found on this host; refresh the list.");
  });

  it("reports no status for a skill without a source", async () => {
    const skill = await store.save({ name: "x", files: [{ path: "SKILL.md", content: skillMd("x") }] });
    expect(await sourceStatus(home, skill)).toBeNull();
  });
});

describe("review fixes", () => {
  it("ignores a malformed installed_plugins.json", async () => {
    await put(".claude/skills/cut-release/SKILL.md", skillMd("cut-release"));
    await put(".claude/plugins/installed_plugins.json", '{"version": 2, "plugins": {');
    expect((await scanFound(home)).map((skill) => skill.name)).toEqual(["cut-release"]);
  });
});
