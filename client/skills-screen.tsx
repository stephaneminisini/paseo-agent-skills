import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal, ScrollView } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { importFoundRpc, importPathRpc, listSkillsRpc, reimportRpc, type SkillRow } from "../shared/skills";
import { type Badge, filterRows, rowBadges, type SkillFilter } from "../shared/skills-view";
import { ActionButton } from "./action-button";

const FILTERS: ReadonlyArray<{ id: SkillFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "local", label: "Local" },
  { id: "langfuse", label: "Langfuse" },
  { id: "found", label: "Found" },
];

type PendingImport =
  | { kind: "path"; path: string; label: string }
  | { kind: "found"; id: string; label: string };

function BadgeChip({ badge, theme }: { badge: Badge; theme: PluginTheme }) {
  const { colors } = theme;
  const tint =
    badge.tone === "warning" ? colors.statusWarning : badge.tone === "success" ? colors.statusSuccess : colors.border;
  return (
    <View style={{ borderWidth: 1, borderColor: tint, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 1 }}>
      <Text style={{ color: colors.foreground, fontSize: 12 }}>{badge.label}</Text>
    </View>
  );
}

function details(row: SkillRow): string[] {
  const lines: string[] = [];
  if (row.local?.sourceLabel) lines.push(`Imported from ${row.local.sourceLabel}`);
  if (row.langfuse) {
    lines.push(
      row.langfuse.labeledVersion === null
        ? "Langfuse: no version carries the configured label"
        : `Langfuse: v${row.langfuse.labeledVersion} carries the configured label`,
    );
  }
  for (const entry of row.found) {
    lines.push(entry.importable ? `Found in ${entry.label}` : `Found in ${entry.label}: ${entry.reason ?? ""}`);
  }
  return lines;
}

/** Skills screen: every skill on this host and in Langfuse, with import actions. */
export function SkillsScreen({ theme, layout }: PluginScreenProps) {
  const { colors } = theme;
  const listSkills = useRpc(listSkillsRpc);
  const importPath = useRpc(importPathRpc);
  const importFound = useRpc(importFoundRpc);
  const reimport = useRpc(reimportRpc);
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["skills"], queryFn: () => listSkills({ fresh: true }) });
  const [filter, setFilter] = useState<SkillFilter>("all");
  const [pathDialog, setPathDialog] = useState(false);
  const [pathDraft, setPathDraft] = useState("");
  const [confirm, setConfirm] = useState<{ name: string; version: number; pending: PendingImport } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const editable = !layout.compact;
  const padding = layout.compact ? 16 : 24;
  const text = { color: colors.foreground };
  const muted = { color: colors.foregroundMuted };
  const rows = query.data?.rows ?? [];

  async function run(action: () => Promise<{ name: string; version: number }>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      setNotice(`Imported ${result.name} as local v${result.version}.`);
      await queryClient.invalidateQueries({ queryKey: ["skills"] });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  function execute(pending: PendingImport) {
    void run(() => (pending.kind === "path" ? importPath({ path: pending.path }) : importFound({ id: pending.id })));
  }

  /** Imports, asking first when the name already has a local skill. */
  function requestImport(pending: PendingImport, name: string | null) {
    const existing = name ? rows.find((row) => row.name === name)?.local : null;
    if (name && existing) {
      setConfirm({ name, version: existing.version, pending });
      return;
    }
    execute(pending);
  }

  let body;
  if (query.isPending) {
    body = <Text style={muted}>Loading skills…</Text>;
  } else if (query.isError) {
    body = (
      <View style={{ gap: 8 }}>
        <Text style={{ color: colors.statusDanger }}>{query.error.message}</Text>
        <View style={{ flexDirection: "row" }}>
          <ActionButton label="Retry" theme={theme} onPress={() => void query.refetch()} />
        </View>
      </View>
    );
  } else {
    const visible = filterRows(rows, filter);
    body =
      visible.length === 0 ? (
        <Text style={muted}>No skills here yet.</Text>
      ) : (
        <View style={{ borderTopWidth: 1, borderColor: colors.border }}>
          {visible.map((row) => {
            const importable = row.found.find((entry) => entry.importable);
            return (
              <View
                key={row.name}
                style={{ paddingVertical: 10, borderBottomWidth: 1, borderColor: colors.border, gap: 4 }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                  <Text style={{ ...text, fontWeight: "600" }}>{row.name}</Text>
                  {rowBadges(row).map((badge) => (
                    <BadgeChip key={badge.label} badge={badge} theme={theme} />
                  ))}
                  <View style={{ flex: 1 }} />
                  {editable && row.local?.sourceStatus === "updated" ? (
                    <ActionButton
                      label="Re-import"
                      theme={theme}
                      disabled={busy}
                      onPress={() => void run(() => reimport({ name: row.name }))}
                    />
                  ) : null}
                  {editable && importable ? (
                    <ActionButton
                      label="Import"
                      theme={theme}
                      disabled={busy}
                      onPress={() =>
                        requestImport({ kind: "found", id: importable.id, label: importable.label }, row.name)
                      }
                    />
                  ) : null}
                </View>
                {row.description ? (
                  <Text style={muted} numberOfLines={2}>
                    {row.description}
                  </Text>
                ) : null}
                {details(row).map((line) => (
                  <Text key={line} style={{ ...muted, fontSize: 12 }}>
                    {line}
                  </Text>
                ))}
              </View>
            );
          })}
        </View>
      );
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.surface0 }} contentContainerStyle={{ padding, gap: 16 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Text style={{ ...text, fontSize: 18, fontWeight: "600" }}>Skills</Text>
        <View style={{ flex: 1 }} />
        <ActionButton label="Refresh" theme={theme} onPress={() => void query.refetch()} />
        {editable ? (
          <ActionButton label="Import…" variant="primary" theme={theme} onPress={() => setPathDialog(true)} />
        ) : null}
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {FILTERS.map((option) => (
          <Pressable
            key={option.id}
            accessibilityRole="button"
            accessibilityState={{ selected: filter === option.id }}
            onPress={() => setFilter(option.id)}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 4,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: filter === option.id ? colors.surface2 : "transparent",
            }}
          >
            <Text style={text}>{option.label}</Text>
          </Pressable>
        ))}
      </View>
      {query.data?.langfuseError ? (
        <Text style={{ color: colors.statusWarning }}>{`Langfuse: ${query.data.langfuseError}`}</Text>
      ) : null}
      {notice ? <Text style={{ color: colors.statusSuccess }}>{notice}</Text> : null}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>
          {error}
        </Text>
      ) : null}
      {body}
      {pathDialog ? (
        <Modal title="Import skill folder" open onOpenChange={(open) => !open && setPathDialog(false)}>
          <Modal.Content>
            <Text style={muted}>Folder on this host that contains SKILL.md.</Text>
            <TextInput
              value={pathDraft}
              onChangeText={setPathDraft}
              placeholder="~/.claude/skills/my-skill"
              placeholderTextColor={colors.foregroundMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={{
                color: colors.foreground,
                backgroundColor: colors.surface2,
                borderRadius: 8,
                padding: 10,
              }}
            />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <ActionButton
                label="Import"
                variant="primary"
                theme={theme}
                disabled={busy || pathDraft.trim().length === 0}
                onPress={() => {
                  setPathDialog(false);
                  execute({ kind: "path", path: pathDraft.trim(), label: pathDraft.trim() });
                }}
              />
              <ActionButton label="Cancel" theme={theme} onPress={() => setPathDialog(false)} />
            </View>
          </Modal.Content>
        </Modal>
      ) : null}
      {confirm ? (
        <Modal title="Replace local skill?" open onOpenChange={(open) => !open && setConfirm(null)}>
          <Modal.Content>
            <Text style={text}>
              {`Replace local ${confirm.name} v${confirm.version} with a new version from ${confirm.pending.label}?`}
            </Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <ActionButton
                label="Replace"
                variant="primary"
                theme={theme}
                onPress={() => {
                  const { pending } = confirm;
                  setConfirm(null);
                  execute(pending);
                }}
              />
              <ActionButton label="Cancel" theme={theme} onPress={() => setConfirm(null)} />
            </View>
          </Modal.Content>
        </Modal>
      ) : null}
    </ScrollView>
  );
}
