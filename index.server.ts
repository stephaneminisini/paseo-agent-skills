import { homedir } from "node:os";
import path from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readLangfuseKeys } from "./server/key-file";
import { createLangfuseClient } from "./server/langfuse";
import { createSkillService, SettingsUnavailableError } from "./server/skill-service";
import { configSettings } from "./shared/settings";
import { searchSkillsRpc, testLangfuseRpc } from "./shared/skills";

export default function contribute(server: PluginServerContext) {
  const config = server.registerSettings(configSettings);

  const service = createSkillService({
    async readConfig() {
      const state = await config.read();
      if (state.status !== "ready") throw new SettingsUnavailableError(state.error);
      return state.values;
    },
    readKeys: (filePath) => readLangfuseKeys(filePath),
    createLangfuse: (options) => createLangfuseClient(options),
    storeRoot: path.join(homedir(), ".local", "share", "paseo-langfuse-skills", "skills"),
  });

  server.handle(searchSkillsRpc, ({ query }) => service.search(query));
  server.handle(testLangfuseRpc, () => service.testLangfuse());
  return () => {};
}
