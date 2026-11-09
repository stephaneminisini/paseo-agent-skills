import { describe, expect, it } from "vitest";
import type { SkillRow } from "../shared/skills";
import { filterRows, rowBadges } from "../shared/skills-view";

function row(partial: Partial<SkillRow> & { name: string }): SkillRow {
  return { description: "", local: null, langfuse: null, found: [], ...partial };
}

const LOCAL = row({ name: "pr-review", local: { version: 3, sourceStatus: null, sourceLabel: null, syncedVersion: null, localChanges: false } });
const LANGFUSE = row({ name: "qai-cut-release", langfuse: { latestVersion: 1, labeledVersion: 1 } });
const FOUND = row({
  name: "brainstorming",
  found: [{ id: "f1", label: "Claude plugin superpowers 7.0.0", importable: true, reason: null }],
});
const ALL = [FOUND, LOCAL, LANGFUSE];

describe("filterRows", () => {
  it("keeps every row for all", () => {
    expect(filterRows(ALL, "all")).toEqual(ALL);
  });

  it("keeps rows with that source", () => {
    expect(filterRows(ALL, "local")).toEqual([LOCAL]);
    expect(filterRows(ALL, "langfuse")).toEqual([LANGFUSE]);
    expect(filterRows(ALL, "found")).toEqual([FOUND]);
  });
});

describe("rowBadges", () => {
  it("shows local version, source updated and Langfuse version", () => {
    const badges = rowBadges(
      row({
        name: "cut-release",
        local: { version: 3, sourceStatus: "updated", sourceLabel: "~/.claude/skills/cut-release", syncedVersion: null, localChanges: false },
        langfuse: { latestVersion: 2, labeledVersion: 2 },
        found: [{ id: "f", label: "~/.claude/skills", importable: true, reason: null }],
      }),
    );
    expect(badges).toEqual([
      { label: "Local v3", tone: "neutral" },
      { label: "Source updated", tone: "warning" },
      { label: "Langfuse changed", tone: "warning" },
      { label: "Found", tone: "neutral" },
    ]);
  });

  it("marks a found-only skill that cannot be imported", () => {
    const badges = rowBadges(
      row({ name: "img", found: [{ id: "f", label: "~/.claude/skills", importable: false, reason: "logo.png" }] }),
    );
    expect(badges).toEqual([
      { label: "Found", tone: "neutral" },
      { label: "Not importable", tone: "warning" },
    ]);
  });

  it("shows a missing source", () => {
    const badges = rowBadges(row({ name: "x", local: { version: 1, sourceStatus: "missing", sourceLabel: "/gone", syncedVersion: null, localChanges: false } }));
    expect(badges).toEqual([
      { label: "Local v1", tone: "neutral" },
      { label: "Source missing", tone: "warning" },
      { label: "Not in Langfuse", tone: "neutral" },
    ]);
  });
});

describe("rowBadges sync state", () => {
  function local(syncedVersion: number | null, localChanges: boolean) {
    return { version: 3, sourceStatus: null, sourceLabel: null, syncedVersion, localChanges };
  }
  const labels = (r: SkillRow) => rowBadges(r).map((badge) => badge.label);

  it("shows the Langfuse version when in sync", () => {
    expect(labels(row({ name: "a", local: local(2, false), langfuse: { latestVersion: 2, labeledVersion: 2 } }))).toEqual([
      "Local v3",
      "Langfuse v2",
    ]);
  });

  it("shows Not in Langfuse", () => {
    expect(labels(row({ name: "a", local: local(null, false) }))).toEqual(["Local v3", "Not in Langfuse"]);
  });

  it("shows Local changes only", () => {
    expect(labels(row({ name: "a", local: local(2, true), langfuse: { latestVersion: 2, labeledVersion: 2 } }))).toEqual([
      "Local v3",
      "Local changes",
    ]);
  });

  it("shows Langfuse changed only", () => {
    expect(labels(row({ name: "a", local: local(2, false), langfuse: { latestVersion: 3, labeledVersion: 2 } }))).toEqual([
      "Local v3",
      "Langfuse changed",
    ]);
  });

  it("shows both", () => {
    expect(labels(row({ name: "a", local: local(2, true), langfuse: { latestVersion: 3, labeledVersion: 2 } }))).toEqual([
      "Local v3",
      "Local changes",
      "Langfuse changed",
    ]);
  });

  it("treats a never-synced local skill with a Langfuse copy as Langfuse changed", () => {
    expect(labels(row({ name: "a", local: local(null, false), langfuse: { latestVersion: 1, labeledVersion: 1 } }))).toEqual([
      "Local v3",
      "Langfuse changed",
    ]);
  });

  it("keeps the Langfuse version for a Langfuse-only row", () => {
    expect(labels(row({ name: "a", langfuse: { latestVersion: 4, labeledVersion: 4 } }))).toEqual(["Langfuse v4"]);
  });
});
