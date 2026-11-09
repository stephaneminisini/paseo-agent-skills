import { isDirty, type SkillDraft } from "./skill-draft";

export interface DraftRegistry {
  get(key: string): SkillDraft | null;
  put(key: string, draft: SkillDraft): void;
  discard(key: string): void;
  /** Keys whose draft has unsaved changes. */
  unsaved(): string[];
  isUnsaved(key: string): boolean;
  /** The draft when it has unsaved changes; a clean draft is dropped so the editor reloads. */
  resume(key: string): SkillDraft | null;
}

/** In-memory drafts by key; they survive screen unmounts, not an app reload. */
export function createDraftRegistry(): DraftRegistry {
  const drafts = new Map<string, SkillDraft>();
  return {
    get: (key) => drafts.get(key) ?? null,
    put: (key, draft) => {
      drafts.set(key, draft);
    },
    discard: (key) => {
      drafts.delete(key);
    },
    unsaved: () => [...drafts.entries()].filter(([, draft]) => isDirty(draft)).map(([key]) => key),
    isUnsaved: (key) => {
      const draft = drafts.get(key);
      return draft !== undefined && isDirty(draft);
    },
    resume: (key) => {
      const draft = drafts.get(key);
      if (!draft) return null;
      if (isDirty(draft)) return draft;
      drafts.delete(key);
      return null;
    },
  };
}

/** Deletes a skill and drops its draft only once the delete succeeded. */
export async function deleteSkillKeepingDraftOnFailure(
  key: string,
  drafts: DraftRegistry,
  remove: () => Promise<unknown>,
): Promise<void> {
  await remove();
  drafts.discard(key);
}

/** Drafts are per host: the plugin can be installed on several hosts. */
export function draftKey(hostId: string, name: string): string {
  return `${hostId}\0${name}`;
}
