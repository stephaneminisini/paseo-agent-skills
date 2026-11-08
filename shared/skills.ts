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

/** The note sent to the agent: where the skill's files are and how to use them. */
export function attachmentText(name: string, origin: "Langfuse" | "local", version: number, dir: string): string {
  return [
    `Use the skill "${name}" (${origin} version ${version}).`,
    `Its files are in ${dir}. Read ${dir}/SKILL.md now and follow it for this task.`,
    `Where SKILL.md writes <skill-dir>, use ${dir}.`,
  ].join("\n");
}
