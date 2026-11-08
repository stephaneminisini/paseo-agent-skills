import type { PluginTheme } from "@getpaseo/plugin";
import { Pressable, Text } from "react-native";

export interface ActionButtonProps {
  label: string;
  theme: PluginTheme;
  onPress(): void;
  variant?: "primary" | "plain" | "danger";
  disabled?: boolean;
}

export function ActionButton({ label, theme, onPress, variant = "plain", disabled }: ActionButtonProps) {
  const { colors } = theme;
  const background =
    variant === "primary" ? colors.accent : variant === "danger" ? colors.statusDanger : colors.surface2;
  const foreground = variant === "plain" ? colors.foreground : colors.accentForeground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={{
        paddingVertical: 8,
        paddingHorizontal: 14,
        borderRadius: 8,
        backgroundColor: background,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text style={{ color: foreground, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}
