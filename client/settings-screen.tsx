import type { PluginSurfaceProps, SettingsState } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Text } from "react-native";
import { isConfigDirty } from "../shared/config-form";
import { testLangfuseRpc } from "../shared/skills";
import { type Config, configSettings } from "../shared/settings";

type ReadyConfig = Extract<SettingsState<typeof configSettings.schema>, { status: "ready" }>;

type TestState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "ok"; projectName: string }
  | { status: "failed"; message: string };

function LangfuseForm({ settings, theme }: { settings: ReadyConfig } & Pick<PluginSurfaceProps, "theme">) {
  // Keep the revision from when the form loaded so another client's save becomes a conflict.
  const [revision, setRevision] = useState(settings.revision);
  const [draft, setDraft] = useState<Config>(settings.values);
  const [test, setTest] = useState<TestState>({ status: "idle" });
  const testLangfuse = useRpc(testLangfuseRpc);
  const text = { color: theme.colors.foreground };

  function update(patch: Partial<Config>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  const dirty = isConfigDirty(draft, settings.values);
  // Adopt a newer revision once the saved values match the draft, as after our own save.
  useEffect(() => {
    if (!dirty) setRevision(settings.revision);
  }, [dirty, settings.revision]);

  async function save() {
    await settings.save(draft, revision);
  }

  async function runTest() {
    setTest({ status: "running" });
    try {
      const { projectName } = await testLangfuse({});
      setTest({ status: "ok", projectName });
    } catch (error) {
      setTest({ status: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  }

  return (
    <>
      <SettingsSection title="Langfuse">
        <SettingsCard>
          <SettingsInput
            label="Base URL"
            hint="Langfuse Cloud US by default. EU: https://cloud.langfuse.com. Self-hosted: your instance URL."
            placeholder="https://us.cloud.langfuse.com"
            initialValue={draft.baseUrl}
            disabled={settings.saving}
            onChangeText={(baseUrl) => update({ baseUrl })}
          />
          <SettingsInput
            label="Label"
            hint="The skill version carrying this label is attached."
            initialValue={draft.label}
            disabled={settings.saving}
            onChangeText={(label) => update({ label })}
          />
          <SettingsInput
            label="Key file path"
            hint="Path on the daemon machine."
            initialValue={draft.keyFilePath}
            disabled={settings.saving}
            onChangeText={(keyFilePath) => update({ keyFilePath })}
          />
          <SettingsRow
            label="Key file format"
            hint={`LANGFUSE_PUBLIC_KEY=pk-lf-...\nLANGFUSE_SECRET_KEY=sk-lf-...\nThen run: chmod 600 ${draft.keyFilePath}`}
          />
          <SettingsAction
            label="Test connection"
            hint="Uses the saved settings and the key file."
            actionLabel={test.status === "running" ? "Testing…" : "Test"}
            disabled={test.status === "running" || dirty}
            onPress={() => void runTest()}
          />
        </SettingsCard>
        {test.status === "ok" ? (
          <Text style={{ color: theme.colors.statusSuccess }}>{`Connected to ${test.projectName}`}</Text>
        ) : null}
        {test.status === "failed" ? (
          <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>
            {test.message}
          </Text>
        ) : null}
      </SettingsSection>
      <SettingsCard>
        <SettingsAction
          label={dirty ? "Unsaved changes" : "All changes saved"}
          error={settings.saveError}
          actionLabel="Save"
          disabled={!dirty || settings.saving}
          onPress={() => void save()}
        />
      </SettingsCard>
      {settings.saveError ? <Text style={text}>Reload this page to see the latest settings.</Text> : null}
    </>
  );
}

export function SettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(configSettings);
  const text = { color: theme.colors.foreground };
  if (settings.status === "loading") return <Text style={text}>Loading settings…</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Langfuse">
        <Text style={text}>{settings.error}</Text>
        <SettingsAction label="Try again" actionLabel="Reload" onPress={() => void settings.reload()} />
      </SettingsSection>
    );
  }
  return <LangfuseForm settings={settings} theme={theme} />;
}
