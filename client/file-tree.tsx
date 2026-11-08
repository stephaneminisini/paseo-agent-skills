import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { TreeNode } from "../shared/skill-draft";

export interface FileTreeProps {
  nodes: TreeNode[];
  selected: string | null;
  theme: PluginTheme;
  onSelect(node: TreeNode): void;
}

/** Indented file tree; folders start expanded and collapse on tap. */
export function FileTree({ nodes, selected, theme, onSelect }: FileTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const { colors } = theme;

  function render(list: TreeNode[], depth: number): React.ReactNode[] {
    return list.flatMap((node) => {
      const open = !collapsed.has(node.path);
      const row = (
        <Pressable
          key={node.path}
          accessibilityRole="button"
          accessibilityState={{ selected: selected === node.path }}
          onPress={() => {
            if (node.kind === "folder") {
              setCollapsed((current) => {
                const next = new Set(current);
                if (next.has(node.path)) next.delete(node.path);
                else next.add(node.path);
                return next;
              });
            }
            onSelect(node);
          }}
          style={{
            paddingVertical: 4,
            paddingLeft: 8 + depth * 14,
            paddingRight: 8,
            borderRadius: 4,
            backgroundColor: selected === node.path ? colors.surface2 : "transparent",
          }}
        >
          <Text style={{ color: node.kind === "folder" ? colors.foregroundMuted : colors.foreground }} numberOfLines={1}>
            {node.kind === "folder" ? `${open ? "▾" : "▸"} ${node.name}/` : node.name}
          </Text>
        </Pressable>
      );
      return node.kind === "folder" && open ? [row, ...render(node.children, depth + 1)] : [row];
    });
  }

  return <View>{render(nodes, 0)}</View>;
}
