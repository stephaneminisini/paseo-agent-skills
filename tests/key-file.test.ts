import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyFileError, readLangfuseKeys } from "../server/key-file";

const SECRET = "sk-lf-very-secret";
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "saved-prompts-keys-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeKeyFile(contents: string, mode = 0o600): Promise<string> {
  const file = path.join(dir, "langfuse.env");
  await writeFile(file, contents);
  await chmod(file, mode);
  return file;
}

async function rejection(promise: Promise<unknown>): Promise<KeyFileError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(KeyFileError);
  return error as KeyFileError;
}

describe("readLangfuseKeys", () => {
  it("parses CRLF lines, comments, blank lines and quoted values", async () => {
    const file = await writeKeyFile(
      `# Langfuse keys\r\n\r\nLANGFUSE_PUBLIC_KEY=pk-lf-1\r\nLANGFUSE_SECRET_KEY="${SECRET}"\r\n`,
    );
    await expect(readLangfuseKeys(file, { platform: "linux" })).resolves.toEqual({
      publicKey: "pk-lf-1",
      secretKey: SECRET,
    });
  });

  it("expands a leading tilde against the home directory", async () => {
    await writeKeyFile(`LANGFUSE_PUBLIC_KEY=pk\nLANGFUSE_SECRET_KEY=sk\n`);
    await expect(
      readLangfuseKeys("~/langfuse.env", { homeDir: dir, platform: "linux" }),
    ).resolves.toEqual({ publicKey: "pk", secretKey: "sk" });
  });

  it("reports a missing file", async () => {
    const error = await rejection(readLangfuseKeys(path.join(dir, "nope.env"), { platform: "linux" }));
    expect(error.reason).toBe("missing");
  });

  it("refuses a file other users can read", async () => {
    const file = await writeKeyFile(`LANGFUSE_PUBLIC_KEY=pk\nLANGFUSE_SECRET_KEY=${SECRET}\n`, 0o644);
    const error = await rejection(readLangfuseKeys(file, { platform: "linux" }));
    expect(error.reason).toBe("too-open");
    expect(error.message).toContain(`chmod 600 ${file}`);
  });

  it("skips the permission check on Windows", async () => {
    const file = await writeKeyFile(`LANGFUSE_PUBLIC_KEY=pk\nLANGFUSE_SECRET_KEY=sk\n`, 0o644);
    await expect(readLangfuseKeys(file, { platform: "win32" })).resolves.toEqual({
      publicKey: "pk",
      secretKey: "sk",
    });
  });

  it("names the missing key", async () => {
    const file = await writeKeyFile(`LANGFUSE_PUBLIC_KEY=pk\n`);
    const error = await rejection(readLangfuseKeys(file, { platform: "linux" }));
    expect(error.reason).toBe("missing-key");
    expect(error.key).toBe("LANGFUSE_SECRET_KEY");
  });

  it("never puts the secret in an error message", async () => {
    const file = await writeKeyFile(`LANGFUSE_SECRET_KEY=${SECRET}\n`, 0o644);
    const tooOpen = await rejection(readLangfuseKeys(file, { platform: "linux" }));
    await chmod(file, 0o600);
    const missingKey = await rejection(readLangfuseKeys(file, { platform: "linux" }));
    expect(tooOpen.message).not.toContain(SECRET);
    expect(missingKey.message).not.toContain(SECRET);
  });
});
