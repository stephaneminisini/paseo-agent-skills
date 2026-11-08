import { describe, expect, it } from "vitest";
import { createDraftRegistry, deleteSkillKeepingDraftOnFailure, draftKey } from "../shared/draft-registry";
import { openDraft, setContent } from "../shared/skill-draft";

const FILES = [{ path: "SKILL.md", content: "---\nname: a\n---\n" }];

describe("createDraftRegistry", () => {
  it("stores, returns and discards drafts", () => {
    const drafts = createDraftRegistry();
    const key = draftKey("host-1", "a");
    const draft = openDraft("a", 1, FILES);
    drafts.put(key, draft);
    expect(drafts.get(key)).toBe(draft);
    drafts.discard(key);
    expect(drafts.get(key)).toBeNull();
  });

  it("lists only drafts with unsaved changes", () => {
    const drafts = createDraftRegistry();
    drafts.put(draftKey("h", "clean"), openDraft("clean", 1, FILES));
    drafts.put(draftKey("h", "dirty"), setContent(openDraft("dirty", 1, FILES), "SKILL.md", "x"));
    expect(drafts.unsaved()).toEqual([draftKey("h", "dirty")]);
  });

  it("keeps an edited draft when a save fails", () => {
    const drafts = createDraftRegistry();
    const key = draftKey("h", "a");
    const edited = setContent(openDraft("a", 1, FILES), "SKILL.md", "edited");
    drafts.put(key, edited);
    // The screen only discards after a successful save.
    expect(drafts.get(key)?.files[0]?.content).toBe("edited");
  });

  it("keeps hosts apart", () => {
    expect(draftKey("h1", "a")).not.toBe(draftKey("h2", "a"));
    const drafts = createDraftRegistry();
    drafts.put(draftKey("h1", "a"), openDraft("a", 1, FILES));
    expect(drafts.get(draftKey("h2", "a"))).toBeNull();
  });
});

describe("review fixes", () => {
  it("resumes only drafts with unsaved changes and drops clean ones", () => {
    const drafts = createDraftRegistry();
    const clean = draftKey("h", "clean");
    const dirty = draftKey("h", "dirty");
    drafts.put(clean, openDraft("clean", 1, FILES));
    drafts.put(dirty, setContent(openDraft("dirty", 1, FILES), "SKILL.md", "x"));
    expect(drafts.resume(clean)).toBeNull();
    expect(drafts.get(clean)).toBeNull();
    expect(drafts.resume(dirty)?.files[0]?.content).toBe("x");
  });

  it("reports whether one key has unsaved changes", () => {
    const drafts = createDraftRegistry();
    drafts.put(draftKey("h", "a"), setContent(openDraft("a", 1, FILES), "SKILL.md", "x"));
    expect(drafts.isUnsaved(draftKey("h", "a"))).toBe(true);
    expect(drafts.isUnsaved(draftKey("h", "b"))).toBe(false);
  });

  it("keeps the draft when deleting the skill fails", async () => {
    const drafts = createDraftRegistry();
    const key = draftKey("h", "a");
    drafts.put(key, setContent(openDraft("a", 1, FILES), "SKILL.md", "x"));
    await expect(
      deleteSkillKeepingDraftOnFailure(key, drafts, async () => {
        throw new Error("disk full");
      }),
    ).rejects.toThrow("disk full");
    expect(drafts.get(key)).not.toBeNull();
    await deleteSkillKeepingDraftOnFailure(key, drafts, async () => {});
    expect(drafts.get(key)).toBeNull();
  });
});
