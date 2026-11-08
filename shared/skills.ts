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

/** The note sent to the agent: where the skill's files are and how to use them. */
export function attachmentText(name: string, version: number, dir: string): string {
  return [
    `Use the skill "${name}" (Langfuse version ${version}).`,
    `Its files are in ${dir}. Read ${dir}/SKILL.md now and follow it for this task.`,
    `Where SKILL.md writes <skill-dir>, use ${dir}.`,
  ].join("\n");
}
