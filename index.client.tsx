import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SettingsScreen } from "./client/settings-screen";
import { SkillsScreen } from "./client/skills-screen";
import { SkillsSidebarItem } from "./client/skills-sidebar-item";
import { skillsSource } from "./shared/skills";

export default function contribute(client: PluginClientContext) {
  client.addAttachmentSource(skillsSource);
  client.addSettingsScreen({
    id: "config",
    title: "Langfuse",
    icon: "Sparkles",
    Component: SettingsScreen,
  });
  client.addScreen({ id: "skills", title: "Skills", Component: SkillsScreen });
  client.addSidebarHeaderItem({ id: "skills", title: "Skills", Component: SkillsSidebarItem });
  return () => {};
}
