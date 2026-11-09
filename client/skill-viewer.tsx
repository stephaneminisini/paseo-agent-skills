import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Platform, Text, View } from "react-native";
import { buildTree } from "../shared/skill-draft";
import { readSkillRpc, type SkillRefInput } from "../shared/skills";
import { ActionButton } from "./action-button";
import { FileTree } from "./file-tree";

export const MONOSPACE = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, monospace" });

export interface SkillViewerProps {
  skillRef: SkillRefInput;
  theme: PluginTheme;
  compact: boolean;
  onClose(): void;
}

function badgeFor(ref: SkillRefInput, version: number | null): string {
  if (ref.kind === "local") return `Local v${version ?? "?"}`;
  if (ref.kind === "langfuse") return `Langfuse v${version ?? "?"}`;
  return "Found";
}

/** Read-only view of any skill's files, on every layout. */
export function SkillViewer({ skillRef, theme, compact, onClose }: SkillViewerProps) {
  const { colors } = theme;
  const read = useRpc(readSkillRpc);
  const query = useQuery({ queryKey: ["skill-read", skillRef], queryFn: () => read({ ref: skillRef }) });
  const [selected, setSelected] = useState<string | null>(compact ? null : "SKILL.md");
  const text = { color: colors.foreground };
  const muted = { color: colors.foregroundMuted };

  const header = (
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
      <ActionButton
        label="‹ Back"
        theme={theme}
        onPress={() => (compact && selected ? setSelected(null) : onClose())}
      />
      <Text style={{ ...text, fontSize: 16, fontWeight: "600" }}>{query.data?.name ?? ""}</Text>
      {query.data ? <Text style={muted}>{badgeFor(skillRef, query.data.version)}</Text> : null}
      {compact && skillRef.kind === "local" ? <Text style={muted}>Edit on desktop</Text> : null}
    </View>
  );

  if (query.isPending) return <View style={{ gap: 12 }}>{header}<Text style={muted}>Loading…</Text></View>;
  if (query.isError) {
    return (
      <View style={{ gap: 12 }}>
        {header}
        <Text style={{ color: colors.statusDanger }}>{query.error.message}</Text>
      </View>
    );
  }
  const { files, error } = query.data;
  const file = files.find((candidate) => candidate.path === selected);
  const content = file ? (
    <Text selectable style={{ ...text, fontFamily: MONOSPACE, fontSize: 13 }}>
      {file.content.length > 0 ? file.content : "(empty file)"}
    </Text>
  ) : null;
  const tree = (
    <FileTree
      nodes={buildTree(files)}
      selected={selected}
      theme={theme}
      onSelect={(node) => node.kind === "file" && setSelected(node.path)}
    />
  );

  return (
    <View style={{ gap: 12 }}>
      {header}
      {error ? <Text style={{ color: colors.statusWarning }}>{error}</Text> : null}
      {compact ? (
        (content ?? tree)
      ) : (
        <View style={{ flexDirection: "row", gap: 16, alignItems: "flex-start" }}>
          <View style={{ width: 220 }}>{tree}</View>
          <View style={{ flex: 1 }}>{content}</View>
        </View>
      )}
    </View>
  );
}
