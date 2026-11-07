import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SettingsScreen } from "./client/settings-screen";
import { skillsSource } from "./shared/skills";

export default function contribute(client: PluginClientContext) {
  client.addAttachmentSource(skillsSource);
  client.addSettingsScreen({
    id: "config",
    title: "Langfuse",
    icon: "Sparkles",
    Component: SettingsScreen,
  });
  return () => {};
}
