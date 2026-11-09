import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { collapseDiff, limitLines, lineDiff } from "../shared/diff";

/** Diff lines rendered at once; more would stall the modal. */
const MAX_RENDERED_LINES = 1500;
import { previewSyncRpc, pushSyncRpc, type SyncPreview, type SyncTarget, takeSyncRpc } from "../shared/skills";
import { ActionButton } from "./action-button";
import { MONOSPACE } from "./skill-viewer";

export interface SyncDialogProps {
  target: SyncTarget;
  theme: PluginTheme;
  /** `changed` is true when a version was created in Langfuse or locally. */
  onClose(changed: boolean): void;
}

type State =
  | { kind: "loading" }
  | { kind: "review"; preview: SyncPreview }
  | { kind: "working" }
  | { kind: "done"; message: string; changed: boolean }
  | { kind: "error"; message: string; preview: SyncPreview | null };

const CHANGE_LABEL = { same: "unchanged", added: "only here", removed: "only in Langfuse", changed: "changed" } as const;

/** Sync to Langfuse: pushes directly when safe, otherwise shows the review with a line diff. */
export function SyncDialog({ target, theme, onClose }: SyncDialogProps) {
  const { colors } = theme;
  const preview = useRpc(previewSyncRpc);
  const push = useRpc(pushSyncRpc);
  const take = useRpc(takeSyncRpc);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [selected, setSelected] = useState<string | null>(null);
  const [includeExternal, setIncludeExternal] = useState(false);
  const text = { color: colors.foreground };
  const muted = { color: colors.foregroundMuted };

  function fail(error: unknown, current: SyncPreview | null) {
    setState({ kind: "error", message: error instanceof Error ? error.message : String(error), preview: current });
  }

  async function doPush(current: SyncPreview, external: boolean) {
    setState({ kind: "working" });
    try {
      const result = await push({
        target,
        expectedLangfuseVersion: current.langfuseVersion,
        expectedHash: current.contentHash,
        confirmedExternal: external ? current.externalPaths : [],
      });
      setState({ kind: "done", message: result.message, changed: true });
    } catch (error) {
      fail(error, current);
    }
  }

  async function doTake(current: SyncPreview) {
    if (current.langfuseVersion === null) return;
    setState({ kind: "working" });
    try {
      const result = await take({ name: current.name, langfuseVersion: current.langfuseVersion });
      setState({ kind: "done", message: result.message, changed: true });
    } catch (error) {
      fail(error, current);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await preview({ target });
        if (cancelled) return;
        if (result.outcome === "identical") {
          setState({ kind: "done", message: `Already in Langfuse as v${result.langfuseVersion}.`, changed: true });
        } else if (
          (result.outcome === "create" || result.outcome === "fast-forward") &&
          result.externalPaths.length === 0 &&
          !result.reviewRequired
        ) {
          await doPush(result, false);
        } else {
          setSelected(result.files.find((file) => file.change !== "same")?.path ?? result.files[0]?.path ?? null);
          setState({ kind: "review", preview: result });
        }
      } catch (error) {
        if (!cancelled) fail(error, null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Preview once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => onClose(state.kind === "done" && state.changed);
  const reviewed = state.kind === "review" ? state.preview : state.kind === "error" ? state.preview : null;
  const shown = useMemo(() => {
    const file = reviewed?.files.find((candidate) => candidate.path === selected);
    if (!file) return null;
    const diff = lineDiff(file.langfuse ?? "", file.local ?? "");
    return { file, display: diff === null ? null : limitLines(collapseDiff(diff), MAX_RENDERED_LINES) };
  }, [reviewed, selected]);
  const current = state.kind === "review" ? state.preview : state.kind === "error" ? state.preview : null;

  let body;
  if (state.kind === "loading" || state.kind === "working") {
    body = <Text style={muted}>{state.kind === "loading" ? "Comparing with Langfuse…" : "Syncing…"}</Text>;
  } else if (state.kind === "done") {
    body = (
      <View style={{ gap: 12 }}>
        <Text style={{ color: colors.statusSuccess }}>{state.message}</Text>
        <View style={{ flexDirection: "row" }}>
          <ActionButton label="Close" theme={theme} onPress={close} />
        </View>
      </View>
    );
  } else if (!current) {
    body = (
      <View style={{ gap: 12 }}>
        <Text style={{ color: colors.statusDanger }}>{state.kind === "error" ? state.message : ""}</Text>
        <View style={{ flexDirection: "row" }}>
          <ActionButton label="Close" theme={theme} onPress={close} />
        </View>
      </View>
    );
  } else {
    const file = shown?.file;
    const display = shown?.display ?? null;
    const heading =
      current.outcome === "create"
        ? "This skill is not in Langfuse yet."
        : target.kind === "found" || current.baseVersion === null
          ? `This skill already exists in Langfuse as v${current.langfuseVersion}.`
          : `Langfuse v${current.langfuseVersion} changed since your last sync (v${current.baseVersion}).`;
    const needsConfirm = current.externalPaths.length > 0;
    body = (
      <View style={{ gap: 12 }}>
        <Text style={text}>{heading}</Text>
        {current.reviewRequired ? (
          <Text style={{ color: colors.statusWarning }}>
            This skill was imported before files from outside its folder were tracked. Check the files before pushing.
          </Text>
        ) : null}
        {state.kind === "error" ? <Text style={{ color: colors.statusDanger }}>{state.message}</Text> : null}
        <View style={{ gap: 2 }}>
          {current.files.map((candidate) => (
            <Pressable
              key={candidate.path}
              accessibilityRole="button"
              onPress={() => setSelected(candidate.path)}
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                paddingVertical: 4,
                paddingHorizontal: 8,
                borderRadius: 4,
                backgroundColor: candidate.path === selected ? colors.surface2 : "transparent",
              }}
            >
              <Text style={text}>{candidate.path}</Text>
              <Text style={candidate.change === "same" ? muted : { color: colors.statusWarning }}>
                {CHANGE_LABEL[candidate.change]}
              </Text>
            </Pressable>
          ))}
        </View>
        {file ? (
          <View style={{ backgroundColor: colors.surface1, borderRadius: 8, padding: 8 }}>
            <Text style={{ ...muted, marginBottom: 4 }}>{`${file.path}: Langfuse → this copy`}</Text>
            {display === null ? (
              <Text style={muted}>Too large to compare line by line.</Text>
            ) : (
              display.lines.map((line, index) =>
                line.kind === "skip" ? (
                  <Text key={index} style={{ ...muted, fontFamily: MONOSPACE, fontSize: 12 }}>
                    {`… ${line.count} unchanged lines …`}
                  </Text>
                ) : (
                  <Text
                    key={index}
                    selectable
                    style={{
                      fontFamily: MONOSPACE,
                      fontSize: 12,
                      color:
                        line.kind === "added"
                          ? colors.statusSuccess
                          : line.kind === "removed"
                            ? colors.statusDanger
                            : colors.foreground,
                    }}
                  >
                    {`${line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "} ${line.text}`}
                  </Text>
                ),
              )
            )}
            {display && display.hidden > 0 ? (
              <Text style={muted}>{`${display.hidden} more lines not shown.`}</Text>
            ) : null}
          </View>
        ) : null}
        {needsConfirm ? (
          <View style={{ gap: 6 }}>
            <Text style={{ color: colors.statusWarning }}>
              {`These files came from outside the skill folder through symlinks: ${current.externalPaths.join(", ")}`}
            </Text>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: includeExternal }}
              onPress={() => setIncludeExternal((value) => !value)}
            >
              <Text style={text}>{`${includeExternal ? "☑" : "☐"} Include files from outside the skill folder`}</Text>
            </Pressable>
          </View>
        ) : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <ActionButton
            label="Push mine anyway"
            variant="primary"
            theme={theme}
            disabled={needsConfirm && !includeExternal}
            onPress={() => void doPush(current, includeExternal)}
          />
          {target.kind === "local" && current.langfuseVersion !== null ? (
            <ActionButton label="Take Langfuse's" theme={theme} onPress={() => void doTake(current)} />
          ) : null}
          <ActionButton label="Cancel" theme={theme} onPress={close} />
        </View>
      </View>
    );
  }

  return (
    <Modal title="Sync to Langfuse" open onOpenChange={(open) => !open && close()}>
      <Modal.Content>{body}</Modal.Content>
    </Modal>
  );
}
