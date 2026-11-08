import type { SkillRow } from "./skills";

export type SkillFilter = "all" | "local" | "langfuse" | "found";

export interface Badge {
  label: string;
  tone: "neutral" | "warning" | "success";
}

/** Rows that have the chosen source; "all" keeps every row. */
export function filterRows(rows: SkillRow[], filter: SkillFilter): SkillRow[] {
  if (filter === "all") return rows;
  if (filter === "local") return rows.filter((row) => row.local !== null);
  if (filter === "langfuse") return rows.filter((row) => row.langfuse !== null);
  return rows.filter((row) => row.found.length > 0);
}

/** Badges shown on a row, in display order. */
export function rowBadges(row: SkillRow): Badge[] {
  const badges: Badge[] = [];
  if (row.local) {
    badges.push({ label: `Local v${row.local.version}`, tone: "neutral" });
    if (row.local.sourceStatus === "updated") badges.push({ label: "Source updated", tone: "warning" });
    if (row.local.sourceStatus === "missing") badges.push({ label: "Source missing", tone: "warning" });
  }
  if (row.langfuse) badges.push({ label: `Langfuse v${row.langfuse.latestVersion}`, tone: "success" });
  if (row.found.length > 0) {
    badges.push({ label: "Found", tone: "neutral" });
    if (!row.local && row.found.every((entry) => !entry.importable)) {
      badges.push({ label: "Not importable", tone: "warning" });
    }
  }
  return badges;
}
