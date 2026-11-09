import { createDraftRegistry } from "../shared/draft-registry";

/** Unsaved skill drafts for this app session, shared by every Skills screen mount. */
export const drafts = createDraftRegistry();
