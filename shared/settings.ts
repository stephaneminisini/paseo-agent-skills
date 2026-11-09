import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** Langfuse Cloud, US region. EU region: https://cloud.langfuse.com */
export const DEFAULT_LANGFUSE_BASE_URL = "https://us.cloud.langfuse.com";
export const DEFAULT_KEY_FILE_PATH = "~/.config/paseo-langfuse-skills/langfuse.env";

export const ConfigSchema = z.object({
  baseUrl: z.string().trim().default(DEFAULT_LANGFUSE_BASE_URL),
  label: z.string().trim().min(1, "Enter a label").default("production"),
  keyFilePath: z.string().trim().min(1, "Enter the key file path").default(DEFAULT_KEY_FILE_PATH),
});

export type Config = z.infer<typeof ConfigSchema>;

export const configSettings = defineSettings({
  id: "config",
  scope: "host",
  version: 1,
  schema: ConfigSchema,
});
