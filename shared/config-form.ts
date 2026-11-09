import { type Config, ConfigSchema } from "./settings";

/**
 * Whether the settings form draft differs from the saved config. The host stores parsed values
 * (trimmed), so the draft is compared after the same parse. A draft the schema rejects is unsaved.
 */
export function isConfigDirty(draft: Config, saved: Config): boolean {
  const parsed = ConfigSchema.safeParse(draft);
  if (!parsed.success) return true;
  return JSON.stringify(parsed.data) !== JSON.stringify(saved);
}
