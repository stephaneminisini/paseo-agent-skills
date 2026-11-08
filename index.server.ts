import { homedir } from "node:os";
import path from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readLangfuseKeys } from "./server/key-file";
import { createLangfuseClient } from "./server/langfuse";
import { createLocalStore } from "./server/local-store";
import { createSkillService, SettingsUnavailableError } from "./server/skill-service";
import { configSettings } from "./shared/settings";
import {
  importFoundRpc,
  importPathRpc,
  listSkillsRpc,
  reimportRpc,
  searchSkillsRpc,
  testLangfuseRpc,
} from "./shared/skills";

const DATA_ROOT = path.join(homedir(), ".local", "share", "paseo-agent-skills");

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
    storeRoot: path.join(DATA_ROOT, "langfuse"),
    localStore: createLocalStore({ root: path.join(DATA_ROOT, "local") }),
    home: homedir(),
  });

  server.handle(searchSkillsRpc, ({ query }) => service.search(query));
  server.handle(testLangfuseRpc, () => service.testLangfuse());
  server.handle(listSkillsRpc, ({ fresh }) => service.list({ fresh }));
  server.handle(importPathRpc, ({ path: folder, replace }) => service.importPath(folder, replace));
  server.handle(importFoundRpc, ({ id }) => service.importFound(id));
  server.handle(reimportRpc, ({ name }) => service.reimport(name));
  return () => {};
}
