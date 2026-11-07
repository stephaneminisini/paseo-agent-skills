import { z } from "zod";
import type { LangfuseKeys } from "./key-file";

export type LangfuseErrorKind = "config" | "auth" | "http" | "network" | "invalid-response";

/** A failed Langfuse call. Messages never include key values. */
export class LangfuseError extends Error {
  constructor(
    public readonly kind: LangfuseErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "LangfuseError";
  }
}

export interface SkillSummary {
  name: string;
  description: string;
}

export interface SkillRef {
  name: string;
  version: number;
  description: string;
}

export interface SkillFile {
  path: string;
  content: string;
  contentType: string;
  sha256Hash: string;
}

export interface SkillVersion {
  name: string;
  version: number;
  files: SkillFile[];
}

export interface LangfuseClient {
  /** Every skill in the project, across all pages. */
  listSkills(): Promise<SkillSummary[]>;
  /** The version carrying `label`; null when none does. */
  resolveSkill(name: string, label: string): Promise<SkillRef | null>;
  /** One exact version with file contents. */
  getSkillVersion(name: string, version: number): Promise<SkillVersion>;
  testConnection(): Promise<{ projectName: string }>;
}

export interface LangfuseClientOptions {
  baseUrl: string;
  keys: LangfuseKeys;
  fetchImpl?: typeof fetch;
}

const PAGE_LIMIT = 50;

const description = z
  .string()
  .nullish()
  .transform((value) => value ?? "");

const ProjectsSchema = z.object({
  data: z.array(z.object({ id: z.string(), name: z.string() })).min(1),
});
const SkillListSchema = z.object({
  data: z.array(z.object({ name: z.string(), description })),
  meta: z.object({ page: z.number(), totalPages: z.number() }),
});
const SkillRefSchema = z.object({ name: z.string(), version: z.number(), description });
const SkillVersionSchema = z.object({
  name: z.string(),
  version: z.number(),
  files: z.array(
    z.object({
      path: z.string(),
      content: z.string(),
      contentType: z.string(),
      sha256Hash: z.string(),
    }),
  ),
});

function skillPath(name: string): string {
  return `/api/public/skills/${encodeURIComponent(name)}`;
}

/**
 * Creates a client for the Langfuse public skills API.
 *
 * Every method rejects with {@link LangfuseError}: kind "config" for an empty base URL,
 * "auth" for HTTP 401/403, "http" for other non-2xx statuses, "network" when the server
 * cannot be reached, and "invalid-response" when a body fails validation.
 */
export function createLangfuseClient(options: LangfuseClientOptions): LangfuseClient {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const authorization = `Basic ${Buffer.from(
    `${options.keys.publicKey}:${options.keys.secretKey}`,
  ).toString("base64")}`;

  async function getJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    if (baseUrl.length === 0) {
      throw new LangfuseError("config", "Set the Langfuse base URL in plugin settings.");
    }
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        headers: { authorization, accept: "application/json" },
      });
    } catch (error) {
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new LangfuseError("network", `Cannot reach Langfuse at ${baseUrl}: ${reason}.`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new LangfuseError(
        "auth",
        `Langfuse rejected the keys (HTTP ${response.status}).`,
        response.status,
      );
    }
    if (!response.ok) {
      throw new LangfuseError(
        "http",
        `Langfuse request failed (HTTP ${response.status}).`,
        response.status,
      );
    }
    const parsed = schema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) {
      console.error("[langfuse-skills] Unexpected Langfuse response", {
        path,
        issues: parsed.error.issues,
      });
      throw new LangfuseError("invalid-response", "Langfuse returned an unexpected response.");
    }
    return parsed.data;
  }

  return {
    async listSkills() {
      const skills: SkillSummary[] = [];
      for (let page = 1; ; page += 1) {
        const query = new URLSearchParams({ page: String(page), limit: String(PAGE_LIMIT) });
        const result = await getJson(`/api/public/skills?${query}`, SkillListSchema);
        skills.push(...result.data);
        if (page >= result.meta.totalPages || result.data.length === 0) return skills;
      }
    },
    async resolveSkill(name, label) {
      try {
        const ref = await getJson(
          `${skillPath(name)}?${new URLSearchParams({ label })}`,
          SkillRefSchema,
        );
        return { name: ref.name, version: ref.version, description: ref.description };
      } catch (error) {
        if (error instanceof LangfuseError && error.status === 404) return null;
        throw error;
      }
    },
    async getSkillVersion(name, version) {
      const query = new URLSearchParams({ version: String(version), includeContent: "true" });
      const skill = await getJson(`${skillPath(name)}?${query}`, SkillVersionSchema);
      return {
        name: skill.name,
        version: skill.version,
        files: skill.files.map(({ path, content, contentType, sha256Hash }) => ({
          path,
          content,
          contentType,
          sha256Hash,
        })),
      };
    },
    async testConnection() {
      const { data } = await getJson("/api/public/projects", ProjectsSchema);
      const [project] = data;
      if (!project) throw new LangfuseError("invalid-response", "Langfuse returned no project.");
      return { projectName: project.name };
    },
  };
}
