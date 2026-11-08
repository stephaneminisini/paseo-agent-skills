# Setup

## Install

Install on each host whose agents should use skills:

```bash
paseo plugin add git:stephaneminisini/paseo-agent-skills
paseo plugin ls            # agent-skills should be running
```

For a local checkout, see the [README](../README.md#development).

## Key file

The plugin reads Langfuse API keys from a file on the host, never from settings:

```bash
mkdir -p ~/.config/paseo-agent-skills
cat > ~/.config/paseo-agent-skills/langfuse.env <<'KEYS'
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
KEYS
chmod 600 ~/.config/paseo-agent-skills/langfuse.env
```

The file must not be readable by other users. If you already use the Saved Prompts plugin, point
**Key file path** at `~/.config/paseo-saved-prompts/langfuse.env` instead and keep one file.

## Settings

Open **Settings → host → Plugins → Agent Skills → Langfuse**:

| Setting       | Default                                        |
| ------------- | ---------------------------------------------- |
| Base URL      | `https://us.cloud.langfuse.com`                |
| Label         | `production`                                   |
| Key file path | `~/.config/paseo-agent-skills/langfuse.env` |

Save, then press **Test connection**. It shows the Langfuse project name.

## First test

Local skills need no key file. Open **Skills** in the sidebar, choose **Found**, and import a
skill, or use **Import...** with a folder path such as `~/.claude/skills/my-skill`. It is stored
under `~/.local/share/paseo-agent-skills/local/<name>/v<version>/`.

To write one from scratch, press **New skill**, edit `SKILL.md` and add files in the editor, then
**Save**.

Then start a new workspace, open **Attach > Skill**, pick the skill, and send. Langfuse skills
picked there are downloaded to `~/.local/share/paseo-agent-skills/langfuse/<name>/v<version>/`.
