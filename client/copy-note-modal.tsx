import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { copyText, Modal, useToast } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text, View } from "react-native";
import { skillNoteRpc } from "../shared/skills";
import { ActionButton } from "./action-button";

export interface CopyNoteModalProps {
  name: string;
  version: number;
  theme: PluginTheme;
  onClose(): void;
}

/** Copies the skill note for pasting into a schedule prompt, pinned or following the latest version. */
export function CopyNoteModal({ name, version, theme, onClose }: CopyNoteModalProps) {
  const { colors } = theme;
  const note = useRpc(skillNoteRpc);
  const toast = useToast();
  const [shown, setShown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const muted = { color: colors.foregroundMuted };

  async function copy(mode: "pinned" | "current") {
    setError(null);
    try {
      const { text } = await note({ name, mode });
      setShown(text);
      try {
        await copyText(text);
        toast.show("Note copied", { variant: "success" });
      } catch {
        toast.error("Could not copy. Select the text below and use Copy.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <Modal title={`Copy note for ${name}`} open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content>
        <Text style={muted}>
          Paste the note into a schedule prompt, or any prompt, to give that agent this skill.
        </Text>
        <View style={{ gap: 4 }}>
          <ActionButton label={`Pinned to v${version}`} variant="primary" theme={theme} onPress={() => void copy("pinned")} />
          <Text style={muted}>Keeps using v{version} even after you save new versions.</Text>
        </View>
        <View style={{ gap: 4 }}>
          <ActionButton label="Always the latest version" theme={theme} onPress={() => void copy("current")} />
          <Text style={muted}>Follows every save, including edits you have not checked yet.</Text>
        </View>
        {error ? <Text style={{ color: colors.statusDanger }}>{error}</Text> : null}
        {shown ? (
          <Text selectable style={{ color: colors.foreground, backgroundColor: colors.surface1, padding: 8, borderRadius: 6 }}>
            {shown}
          </Text>
        ) : null}
      </Modal.Content>
    </Modal>
  );
}
