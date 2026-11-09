import { defineAttachmentSource, defineRpc, PluginAttachmentSearchPayloadSchema } from "@getpaseo/plugin";
import { z } from "zod";

export const searchSkillsRpc = defineRpc({
  name: "skills.search",
  input: z.object({ query: z.string() }),
  output: PluginAttachmentSearchPayloadSchema,
});

export const testLangfuseRpc = defineRpc({
  name: "skills.langfuse.test",
  input: z.object({}),
  output: z.object({ projectName: z.string() }),
});

export const skillsSource = defineAttachmentSource({
  id: "agent-skills",
  title: "Skill",
  icon: "Sparkles",
  pickerTitle: "Attach Langfuse skill",
  searchPlaceholder: "Search skills by name or description",
  search: searchSkillsRpc,
});

export const SkillRowSchema = z.object({
  name: z.string(),
  description: z.string(),
  local: z
    .object({
      version: z.number(),
      sourceStatus: z.enum(["unchanged", "updated", "missing"]).nullable(),
      sourceLabel: z.string().nullable(),
      syncedVersion: z.number().nullable(),
      localChanges: z.boolean(),
    })
    .nullable(),
  langfuse: z.object({ latestVersion: z.number(), labeledVersion: z.number().nullable() }).nullable(),
  found: z.array(
    z.object({ id: z.string(), label: z.string(), importable: z.boolean(), reason: z.string().nullable() }),
  ),
});
export type SkillRow = z.infer<typeof SkillRowSchema>;

const ImportedSchema = z.object({ name: z.string(), version: z.number() });

export const listSkillsRpc = defineRpc({
  name: "skills.list",
  input: z.object({ fresh: z.boolean().optional() }),
  output: z.object({ rows: z.array(SkillRowSchema), langfuseError: z.string().nullable() }),
});
export const importPathRpc = defineRpc({
  name: "skills.import.path",
  input: z.object({ path: z.string(), replace: z.boolean().optional() }),
  /** needsConfirm: a local skill of that name exists (name/version are the existing one); nothing was imported. */
  output: ImportedSchema.extend({ needsConfirm: z.boolean() }),
});
export const importFoundRpc = defineRpc({
  name: "skills.import.found",
  input: z.object({ id: z.string() }),
  output: ImportedSchema,
});
export const reimportRpc = defineRpc({
  name: "skills.reimport",
  input: z.object({ name: z.string() }),
  output: ImportedSchema,
});

export const SkillFileSchema = z.object({ path: z.string(), content: z.string() });
export type SkillFileText = z.infer<typeof SkillFileSchema>;

export const SkillRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), name: z.string() }),
  z.object({ kind: z.literal("langfuse"), name: z.string() }),
  z.object({ kind: z.literal("found"), id: z.string() }),
]);
export type SkillRefInput = z.infer<typeof SkillRefSchema>;

export const ReadSkillResultSchema = z.object({
  name: z.string(),
  /** Local or Langfuse version; null for found skills. */
  version: z.number().nullable(),
  /** Empty when error is set. */
  files: z.array(SkillFileSchema),
  error: z.string().nullable(),
});
export type ReadSkillResult = z.infer<typeof ReadSkillResultSchema>;

export const readSkillRpc = defineRpc({
  name: "skills.read",
  input: z.object({ ref: SkillRefSchema }),
  output: ReadSkillResultSchema,
});
export const saveSkillRpc = defineRpc({
  name: "skills.local.save",
  input: z.object({ name: z.string(), files: z.array(SkillFileSchema), expectedVersion: z.number() }),
  output: ImportedSchema,
});
export const createSkillRpc = defineRpc({
  name: "skills.local.create",
  input: z.object({ name: z.string() }),
  output: ImportedSchema,
});
export const deleteSkillRpc = defineRpc({
  name: "skills.local.delete",
  input: z.object({ name: z.string() }),
  output: z.object({}),
});

export const SyncTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), name: z.string() }),
  z.object({ kind: z.literal("found"), id: z.string() }),
]);
export type SyncTarget = z.infer<typeof SyncTargetSchema>;

export const SyncFileSchema = z.object({
  path: z.string(),
  /** From Langfuse latest to the local or found files. */
  change: z.enum(["same", "added", "removed", "changed"]),
  local: z.string().nullable(),
  langfuse: z.string().nullable(),
});
export type SyncFile = z.infer<typeof SyncFileSchema>;

export const SyncPreviewSchema = z.object({
  outcome: z.enum(["create", "identical", "fast-forward", "conflict"]),
  name: z.string(),
  /** Langfuse latest at preview time; null when the skill is not in Langfuse. */
  langfuseVersion: z.number().nullable(),
  /** The local copy's sync base version. */
  baseVersion: z.number().nullable(),
  /** Empty for identical. */
  files: z.array(SyncFileSchema),
  externalPaths: z.array(z.string()),
  /** contentHash of the files shown; push must send the same. */
  contentHash: z.string(),
  /** The files must be reviewed before pushing (external files not tracked for this skill). */
  reviewRequired: z.boolean(),
});
export type SyncPreview = z.infer<typeof SyncPreviewSchema>;

export const previewSyncRpc = defineRpc({
  name: "skills.sync.preview",
  input: z.object({ target: SyncTargetSchema }),
  output: SyncPreviewSchema,
});
export const pushSyncRpc = defineRpc({
  name: "skills.sync.push",
  input: z.object({
    target: SyncTargetSchema,
    expectedLangfuseVersion: z.number().nullable(),
    expectedHash: z.string(),
    confirmedExternal: z.array(z.string()),
  }),
  output: z.object({ version: z.number(), message: z.string() }),
});
export const takeSyncRpc = defineRpc({
  name: "skills.sync.take",
  input: z.object({ name: z.string(), langfuseVersion: z.number() }),
  output: z.object({ localVersion: z.number(), message: z.string() }),
});

/** SKILL.md for a new local skill. */
export function newSkillTemplate(name: string): string {
  return `---\nname: ${name}\ndescription: Describe when an agent should use this skill.\n---\n\n# ${name}\n\nInstructions for the agent.\n`;
}

/** The note sent to the agent: where the skill's files are and how to use them. */
export function attachmentText(name: string, origin: "Langfuse" | "local", version: number, dir: string): string {
  return [
    `Use the skill "${name}" (${origin} version ${version}).`,
    `Its files are in ${dir}. Read ${dir}/SKILL.md now and follow it for this task.`,
    `Where SKILL.md writes <skill-dir>, use ${dir}.`,
  ].join("\n");
}
