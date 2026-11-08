import { isDirty, type SkillDraft } from "./skill-draft";

export interface DraftRegistry {
  get(key: string): SkillDraft | null;
  put(key: string, draft: SkillDraft): void;
  discard(key: string): void;
  /** Keys whose draft has unsaved changes. */
  unsaved(): string[];
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
  };
}

/** Drafts are per host: the plugin can be installed on several hosts. */
export function draftKey(hostId: string, name: string): string {
  return `${hostId}\0${name}`;
}
