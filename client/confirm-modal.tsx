import type { PluginTheme } from "@getpaseo/plugin";
import { Modal } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { ActionButton } from "./action-button";

export interface ConfirmModalProps {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  theme: PluginTheme;
  onConfirm(): void;
  onCancel(): void;
}

/** A yes/no question in a Paseo modal. */
export function ConfirmModal({ title, message, confirmLabel, danger, theme, onConfirm, onCancel }: ConfirmModalProps) {
  return (
    <Modal title={title} open onOpenChange={(open) => !open && onCancel()}>
      <Modal.Content>
        <Text style={{ color: theme.colors.foreground }}>{message}</Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <ActionButton label={confirmLabel} variant={danger ? "danger" : "primary"} theme={theme} onPress={onConfirm} />
          <ActionButton label="Cancel" theme={theme} onPress={onCancel} />
        </View>
      </Modal.Content>
    </Modal>
  );
}
