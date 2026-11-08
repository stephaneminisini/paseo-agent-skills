import { describe, expect, it } from "vitest";
import { isConfigDirty } from "../shared/config-form";
import { ConfigSchema } from "../shared/settings";

describe("ConfigSchema", () => {
  it("fills defaults", () => {
    expect(ConfigSchema.parse({})).toEqual({
      baseUrl: "https://us.cloud.langfuse.com",
      label: "production",
      keyFilePath: "~/.config/paseo-agent-skills/langfuse.env",
    });
  });

  it("rejects an empty label", () => {
    expect(ConfigSchema.safeParse({ label: "  " }).success).toBe(false);
  });

  it("treats a trimmed-equal draft as saved", () => {
    const saved = ConfigSchema.parse({});
    expect(isConfigDirty({ ...saved, label: " production " }, saved)).toBe(false);
    expect(isConfigDirty({ ...saved, label: "staging" }, saved)).toBe(true);
  });
});
