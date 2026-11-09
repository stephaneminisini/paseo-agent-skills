import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { draftKey } from "../shared/draft-registry";
import {
  addFile,
  addFolder,
  buildTree,
  type DraftResult,
  isDirty,
  openDraft,
  removePath,
  renamePath,
  type SkillDraft,
  setContent,
  type TreeNode,
} from "../shared/skill-draft";
import { readSkillRpc, saveSkillRpc } from "../shared/skills";
import { ActionButton } from "./action-button";
import { ConfirmModal } from "./confirm-modal";
import { drafts } from "./drafts";
import { FileTree } from "./file-tree";
import { MONOSPACE } from "./skill-viewer";

export interface SkillEditorProps {
  name: string;
  hostId: string;
  theme: PluginTheme;
  /** Called when leaving; `saved` tells the list to refresh. */
  onClose(saved: boolean): void;
}

type Prompt = { kind: "file" | "folder" } | { kind: "rename"; from: string };

/** Desktop and web editor for a local skill: file tree, text editor, Save. */
export function SkillEditor({ name, hostId, theme, onClose }: SkillEditorProps) {
  const { colors } = theme;
  const key = draftKey(hostId, name);
  const read = useRpc(readSkillRpc);
  const save = useRpc(saveSkillRpc);
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<SkillDraft | null>(() => drafts.resume(key));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<TreeNode | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const [promptError, setPromptError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"discard" | "back" | "delete" | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedOnce, setSavedOnce] = useState(false);
  const text = { color: colors.foreground };
  const muted = { color: colors.foregroundMuted };

  async function load() {
    setLoadError(null);
    try {
      const result = await read({ ref: { kind: "local", name } });
      const opened = openDraft(result.name, result.version ?? 0, result.files);
      drafts.put(key, opened);
      setDraft(opened);
      setSelected({ name: "SKILL.md", path: "SKILL.md", kind: "file", children: [] });
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }

  useEffect(() => {
    if (!drafts.resume(key)) void load();
    else setSelected({ name: "SKILL.md", path: "SKILL.md", kind: "file", children: [] });
    // Load once per skill; `load` reads the current props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  function update(next: SkillDraft) {
    drafts.put(key, next);
    setDraft(next);
  }

  function apply(result: DraftResult, select?: TreeNode | null): boolean {
    if (!result.ok) {
      setPromptError(result.error);
      return false;
    }
    update(result.draft);
    if (select !== undefined) setSelected(select);
    return true;
  }

  async function onSave() {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      await save({ name, files: draft.files, expectedVersion: draft.baseVersion });
      drafts.discard(key);
      setSavedOnce(true);
      await queryClient.invalidateQueries({ queryKey: ["skills"] });
      await load();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  function submitPrompt() {
    if (!draft || !prompt) return;
    const value = promptValue.trim();
    const base = selected?.kind === "folder" ? `${selected.path}/` : "";
    let done = false;
    if (prompt.kind === "file") {
      const path = value.includes("/") ? value : base + value;
      done = apply(addFile(draft, path), { name: path.split("/").pop() ?? path, path, kind: "file", children: [] });
    } else if (prompt.kind === "folder") {
      const path = value.includes("/") ? value : base + value;
      done = apply(addFolder(draft, path), null);
    } else if (prompt.kind === "rename") {
      done = apply(renamePath(draft, prompt.from, value), null);
    }
    if (done) setPrompt(null);
  }

  if (loadError) {
    return (
      <View style={{ gap: 12 }}>
        <ActionButton label="‹ Back" theme={theme} onPress={() => onClose(false)} />
        <Text style={{ color: colors.statusDanger }}>{loadError}</Text>
      </View>
    );
  }
  if (!draft) return <Text style={muted}>Loading…</Text>;

  const dirty = isDirty(draft);
  const file = selected?.kind === "file" ? draft.files.find((candidate) => candidate.path === selected.path) : undefined;

  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <ActionButton label="‹ Back" theme={theme} onPress={() => (dirty ? setConfirm("back") : onClose(savedOnce))} />
        <Text style={{ ...text, fontSize: 16, fontWeight: "600" }}>{name}</Text>
        <Text style={muted}>{`Local v${draft.baseVersion}`}</Text>
        {dirty ? <Text style={{ color: colors.statusWarning }}>Unsaved changes</Text> : null}
        <View style={{ flex: 1 }} />
        <ActionButton label="Discard" theme={theme} disabled={!dirty || saving} onPress={() => setConfirm("discard")} />
        <ActionButton
          label={saving ? "Saving…" : `Save (v${draft.baseVersion + 1})`}
          variant="primary"
          theme={theme}
          disabled={!dirty || saving}
          onPress={() => void onSave()}
        />
      </View>
      {saveError ? (
        <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>
          {saveError}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", gap: 16, alignItems: "flex-start" }}>
        <View style={{ width: 240, gap: 8 }}>
          <FileTree
            nodes={buildTree(draft.files, draft.emptyFolders)}
            selected={selected?.path ?? null}
            theme={theme}
            onSelect={setSelected}
          />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            <ActionButton label="+ File" theme={theme} disabled={saving} onPress={() => openPrompt({ kind: "file" }, "")} />
            <ActionButton label="+ Folder" theme={theme} disabled={saving} onPress={() => openPrompt({ kind: "folder" }, "")} />
            <ActionButton
              label="Rename"
              theme={theme}
              disabled={!selected || saving}
              onPress={() => selected && openPrompt({ kind: "rename", from: selected.path }, selected.path)}
            />
            <ActionButton label="Delete" theme={theme} disabled={!selected || saving} onPress={() => setConfirm("delete")} />
          </View>
        </View>
        <View style={{ flex: 1 }}>
          {file ? (
            <TextInput
              multiline
              // Read-only while saving: the editor reloads from the saved version afterwards.
              editable={!saving}
              value={file.content}
              onChangeText={(content) => update(setContent(draft, file.path, content))}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              style={{
                color: colors.foreground,
                backgroundColor: colors.surface1,
                borderColor: colors.border,
                borderWidth: 1,
                borderRadius: 8,
                padding: 12,
                minHeight: 420,
                fontFamily: MONOSPACE,
                fontSize: 13,
                textAlignVertical: "top",
              }}
            />
          ) : (
            <Text style={muted}>Select a file to edit it.</Text>
          )}
        </View>
      </View>
      {prompt ? (
        <Modal
          title={prompt.kind === "file" ? "New file" : prompt.kind === "folder" ? "New folder" : "Rename"}
          open
          onOpenChange={(open) => !open && setPrompt(null)}
        >
          <Modal.Content>
            <TextInput
              value={promptValue}
              onChangeText={(value) => {
                setPromptValue(value);
                setPromptError(null);
              }}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={prompt.kind === "folder" ? "templates" : "scripts/run.sh"}
              placeholderTextColor={colors.foregroundMuted}
              style={{ color: colors.foreground, backgroundColor: colors.surface2, borderRadius: 8, padding: 10 }}
            />
            {promptError ? <Text style={{ color: colors.statusDanger }}>{promptError}</Text> : null}
            <View style={{ flexDirection: "row", gap: 8 }}>
              <ActionButton
                label="OK"
                variant="primary"
                theme={theme}
                disabled={promptValue.trim().length === 0}
                onPress={submitPrompt}
              />
              <ActionButton label="Cancel" theme={theme} onPress={() => setPrompt(null)} />
            </View>
          </Modal.Content>
        </Modal>
      ) : null}
      {confirm === "discard" ? (
        <ConfirmModal
          title="Discard changes?"
          message={`Discard your unsaved changes to ${name}?`}
          confirmLabel="Discard"
          danger
          theme={theme}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            drafts.discard(key);
            void load();
          }}
        />
      ) : null}
      {confirm === "back" ? (
        <ConfirmModal
          title="Unsaved changes"
          message={`You have unsaved changes to ${name}. They stay as a draft until you discard them.`}
          confirmLabel="Continue"
          theme={theme}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            onClose(savedOnce);
          }}
        />
      ) : null}
      {confirm === "delete" && selected ? (
        <ConfirmModal
          title="Delete from draft?"
          message={`Delete ${selected.path}${selected.kind === "folder" ? " and everything in it" : ""} from this draft?`}
          confirmLabel="Delete"
          danger
          theme={theme}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            apply(removePath(draft, selected.path), null);
          }}
        />
      ) : null}
    </View>
  );

  function openPrompt(next: Prompt, initial: string) {
    setPromptValue(initial);
    setPromptError(null);
    setPrompt(next);
  }
}
