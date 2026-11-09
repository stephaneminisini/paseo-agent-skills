import { describe, expect, it } from "vitest";
import { lineDiff, MAX_DIFF_LINES } from "../shared/diff";

describe("lineDiff", () => {
  it("marks identical text as same", () => {
    expect(lineDiff("a\nb", "a\nb")).toEqual([
      { kind: "same", text: "a" },
      { kind: "same", text: "b" },
    ]);
  });

  it("shows a changed line as removed then added in place", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "B" },
      { kind: "same", text: "c" },
    ]);
  });

  it("treats an empty before as all added", () => {
    expect(lineDiff("", "x\ny")).toEqual([
      { kind: "removed", text: "" },
      { kind: "added", text: "x" },
      { kind: "added", text: "y" },
    ]);
  });

  it("keeps a trailing empty line from a final newline", () => {
    expect(lineDiff("a\n", "a\n")).toEqual([
      { kind: "same", text: "a" },
      { kind: "same", text: "" },
    ]);
  });

  it("finishes quickly on two unrelated 4,000-line texts", () => {
    const before = Array.from({ length: 4000 }, (_, index) => `left ${index}`).join("\n");
    const after = Array.from({ length: 4000 }, (_, index) => `right ${index}`).join("\n");
    const started = Date.now();
    const diff = lineDiff(before, after);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(diff?.filter((line) => line.kind === "removed")).toHaveLength(4000);
  });

  it("gives up above the line cap", () => {
    const big = Array.from({ length: MAX_DIFF_LINES + 1 }, () => "x").join("\n");
    expect(lineDiff(big, "x")).toBeNull();
  });
});

describe("lineDiff reconstruction", () => {
  it("rebuilds both sides for random edits", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const words = ["a", "b", "c", "d", "e"];
    for (let round = 0; round < 300; round += 1) {
      const before = Array.from({ length: Math.floor(random() * 12) }, () => words[Math.floor(random() * 5)]).join("\n");
      const after = Array.from({ length: Math.floor(random() * 12) }, () => words[Math.floor(random() * 5)]).join("\n");
      const diff = lineDiff(before, after) ?? [];
      expect(diff.filter((line) => line.kind !== "added").map((line) => line.text).join("\n")).toBe(before);
      expect(diff.filter((line) => line.kind !== "removed").map((line) => line.text).join("\n")).toBe(after);
    }
  });
});
