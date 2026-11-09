import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface LangfuseKeys {
  publicKey: string;
  secretKey: string;
}

export type KeyName = "LANGFUSE_PUBLIC_KEY" | "LANGFUSE_SECRET_KEY";
export type KeyFileErrorReason = "missing" | "unreadable" | "too-open" | "missing-key";

/** A problem with the Langfuse key file. Messages never include key values. */
export class KeyFileError extends Error {
  constructor(
    public readonly reason: KeyFileErrorReason,
    public readonly path: string,
    message: string,
    public readonly key?: KeyName,
  ) {
    super(message);
    this.name = "KeyFileError";
  }
}

export interface ReadKeysOptions {
  homeDir?: string;
  platform?: NodeJS.Platform;
}

function expandHome(filePath: string, homeDir: string): string {
  if (filePath === "~") return homeDir;
  if (filePath.startsWith("~/")) return path.join(homeDir, filePath.slice(2));
  return filePath;
}

function errorCode(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
  return "unknown error";
}

function unquote(value: string): string {
  const first = value[0];
  if (value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)) {
    return value.slice(1, -1);
  }
  return value;
}

function parseKeyFile(contents: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    values.set(line.slice(0, separator).trim(), unquote(line.slice(separator + 1).trim()));
  }
  return values;
}

/**
 * Reads Langfuse keys from a dotenv-style file on the daemon machine.
 *
 * @throws {KeyFileError} reason "missing" when the file does not exist, "unreadable" when it
 *   cannot be read, "too-open" when group or others can access it (non-Windows), and
 *   "missing-key" when a required key line is absent or empty.
 */
export async function readLangfuseKeys(
  filePath: string,
  options: ReadKeysOptions = {},
): Promise<LangfuseKeys> {
  const resolved = expandHome(filePath, options.homeDir ?? homedir());
  const platform = options.platform ?? process.platform;
  let contents: string;
  try {
    const info = await stat(resolved);
    if (platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw new KeyFileError(
        "too-open",
        resolved,
        `Langfuse key file ${resolved} is readable by other users. Run: chmod 600 ${resolved}`,
      );
    }
    contents = await readFile(resolved, "utf8");
  } catch (error) {
    if (error instanceof KeyFileError) throw error;
    const code = errorCode(error);
    if (code === "ENOENT") {
      throw new KeyFileError("missing", resolved, `Langfuse key file not found at ${resolved}.`);
    }
    throw new KeyFileError(
      "unreadable",
      resolved,
      `Cannot read Langfuse key file at ${resolved}: ${code}.`,
    );
  }
  const values = parseKeyFile(contents);
  function required(key: KeyName): string {
    const value = values.get(key);
    if (!value) {
      throw new KeyFileError(
        "missing-key",
        resolved,
        `Langfuse key file ${resolved} has no ${key} line.`,
        key,
      );
    }
    return value;
  }
  return { publicKey: required("LANGFUSE_PUBLIC_KEY"), secretKey: required("LANGFUSE_SECRET_KEY") };
}
