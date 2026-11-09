# Setup

## Install

Install on each host whose agents should use skills:

```bash
paseo plugin add git:stephaneminisini/paseo-langfuse-skills
paseo plugin ls            # langfuse-skills should be running
```

For a local checkout, see the [README](../README.md#development).

## Key file

The plugin reads Langfuse API keys from a file on the host, never from settings:

```bash
mkdir -p ~/.config/paseo-langfuse-skills
cat > ~/.config/paseo-langfuse-skills/langfuse.env <<'KEYS'
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
KEYS
chmod 600 ~/.config/paseo-langfuse-skills/langfuse.env
```

The file must not be readable by other users. If you already use the Saved Prompts plugin, point
**Key file path** at `~/.config/paseo-saved-prompts/langfuse.env` instead and keep one file.

## Settings

Open **Settings → host → Plugins → Langfuse Skills → Langfuse**:

| Setting       | Default                                        |
| ------------- | ---------------------------------------------- |
| Base URL      | `https://us.cloud.langfuse.com`                |
| Label         | `production`                                   |
| Key file path | `~/.config/paseo-langfuse-skills/langfuse.env` |

Save, then press **Test connection**. It shows the Langfuse project name.

## First test

Start a new workspace, open **Attach → Skill**, pick a skill, and send. Check that
`~/.local/share/paseo-langfuse-skills/skills/<name>/v<version>/` holds `SKILL.md` and
`.langfuse-skill.json`.
