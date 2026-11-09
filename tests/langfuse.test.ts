import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createLangfuseClient, LangfuseError } from "../server/langfuse";

const KEYS = { publicKey: "pk", secretKey: "sk" };

interface SeenRequest {
  path: string;
  query: URLSearchParams;
  authorization: string | undefined;
}

type Handler = (url: URL, rawPath: string, response: ServerResponse) => void;

const servers: Array<{ close(): void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function startServer(handler: Handler): Promise<{ baseUrl: string; seen: SeenRequest[] }> {
  const seen: SeenRequest[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const rawPath = request.url?.split("?")[0] ?? "";
    seen.push({ path: rawPath, query: url.searchParams, authorization: request.headers.authorization });
    handler(url, rawPath, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, seen };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const FILES = [
  { path: "SKILL.md", content: "# Cut release", contentType: "text/plain", sha256Hash: "h1", contentLength: 13 },
  { path: "bundle-migrations.sh", content: "echo hi", contentType: "text/plain", sha256Hash: "h2", contentLength: 7 },
];

function langfuseStub(url: URL, rawPath: string, response: ServerResponse): void {
  if (url.pathname === "/api/public/projects") {
    json(response, 200, { data: [{ id: "proj-1", name: "Acme" }] });
    return;
  }
  if (url.pathname === "/api/public/skills") {
    const page = Number(url.searchParams.get("page"));
    const data =
      page === 1
        ? [{ name: "cut-release", description: "Cut a release" }]
        : [{ name: "team/triage", description: null }];
    json(response, 200, { data, meta: { page, limit: 50, totalItems: 2, totalPages: 2 } });
    return;
  }
  if (rawPath === "/api/public/skills/team%2Fcut-release" || rawPath === "/api/public/skills/cut-release") {
    const name = decodeURIComponent(rawPath.replace("/api/public/skills/", ""));
    if (url.searchParams.get("label") === "production") {
      json(response, 200, { name, version: 2, description: "Cut a release", labels: ["production"] });
      return;
    }
    if (url.searchParams.get("version") === "2" && url.searchParams.get("includeContent") === "true") {
      json(response, 200, { name, version: 2, description: "Cut a release", files: FILES });
      return;
    }
  }
  json(response, 404, { message: "Skill version not found", error: "LangfuseNotFoundError" });
}

async function rejection(promise: Promise<unknown>): Promise<LangfuseError> {
  const error = await promise.then(
    () => {
      throw new Error("expected rejection");
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(LangfuseError);
  return error as LangfuseError;
}

describe("createLangfuseClient", () => {
  it("lists skills across pages with basic auth", async () => {
    const { baseUrl, seen } = await startServer(langfuseStub);
    const client = createLangfuseClient({ baseUrl, keys: KEYS });
    expect(await client.listSkills()).toEqual([
      { name: "cut-release", description: "Cut a release" },
      { name: "team/triage", description: "" },
    ]);
    expect(seen.map((request) => request.query.get("page"))).toEqual(["1", "2"]);
    expect(seen[0]?.authorization).toBe(`Basic ${Buffer.from("pk:sk").toString("base64")}`);
  });

  it("resolves the labeled version with an encoded name", async () => {
    const { baseUrl, seen } = await startServer(langfuseStub);
    const client = createLangfuseClient({ baseUrl, keys: KEYS });
    expect(await client.resolveSkill("team/cut-release", "production")).toEqual({
      name: "team/cut-release",
      version: 2,
      description: "Cut a release",
    });
    expect(seen[0]?.path).toBe("/api/public/skills/team%2Fcut-release");
    expect(seen[0]?.query.get("label")).toBe("production");
  });

  it("returns null when no version carries the label", async () => {
    const { baseUrl } = await startServer(langfuseStub);
    const client = createLangfuseClient({ baseUrl, keys: KEYS });
    expect(await client.resolveSkill("cut-release", "staging")).toBeNull();
  });

  it("fetches one exact version with its files", async () => {
    const { baseUrl } = await startServer(langfuseStub);
    const client = createLangfuseClient({ baseUrl, keys: KEYS });
    expect(await client.getSkillVersion("cut-release", 2)).toEqual({
      name: "cut-release",
      version: 2,
      files: FILES.map(({ path, content, contentType, sha256Hash }) => ({
        path,
        content,
        contentType,
        sha256Hash,
      })),
    });
  });

  it("reports rejected keys as auth errors", async () => {
    const { baseUrl } = await startServer((_url, _raw, response) => json(response, 401, {}));
    const error = await rejection(createLangfuseClient({ baseUrl, keys: KEYS }).listSkills());
    expect(error.kind).toBe("auth");
    expect(error.message).not.toContain("sk");
  });

  it("reports an unreachable server as a network error", async () => {
    const error = await rejection(
      createLangfuseClient({ baseUrl: "http://127.0.0.1:1", keys: KEYS }).listSkills(),
    );
    expect(error.kind).toBe("network");
  });

  it("rejects a version body without files", async () => {
    const { baseUrl } = await startServer((_url, _raw, response) =>
      json(response, 200, { name: "cut-release", version: 2 }),
    );
    const error = await rejection(
      createLangfuseClient({ baseUrl, keys: KEYS }).getSkillVersion("cut-release", 2),
    );
    expect(error.kind).toBe("invalid-response");
  });

  it("returns the project name from testConnection", async () => {
    const { baseUrl } = await startServer(langfuseStub);
    expect(await createLangfuseClient({ baseUrl, keys: KEYS }).testConnection()).toEqual({
      projectName: "Acme",
    });
  });
});
