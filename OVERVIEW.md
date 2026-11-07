# Langfuse Skills

Langfuse Skills lets you attach a skill stored in
[Langfuse](https://langfuse.com/docs/skill-management) to one agent launch. Open **New
workspace** (or any composer), pick **Attach > Skill**, and choose a skill. The agent receives a
short note telling it where the skill's files are and to read its `SKILL.md`. It works the same
for Claude Code, Codex, and other providers.

## How it works

- The picker lists skills that have a version carrying your label (`production` by default).
  Search matches the skill name and description.
- When a skill appears in the picker, the plugin downloads that exact version to the Paseo host,
  under `~/.local/share/paseo-langfuse-skills/skills/<name>/v<version>/`. Each version is
  downloaded once and reused afterwards. A newer version goes into its own folder, so agents
  using an older version are not affected.
- The skill is not installed into `~/.claude/skills` or `~/.codex/skills`. Only the agent you
  attach it to is told about it.
- Every file is checked against the hash Langfuse reports. Paths that would leave the skill
  folder are refused. Only text files are supported; a skill version containing another kind of
  file is not offered.

## Setup

- A Langfuse project with skills (Langfuse Cloud or self-hosted), and a public/secret API key
  pair for it.
- A key file on the Paseo host containing `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`,
  readable only by you (`chmod 600`). Keys are never stored in Paseo settings.
- In the plugin settings, set the Langfuse base URL, the label to use, and the key file path,
  then press **Test connection**.
- Settings and downloaded skills are per host. Configure each host where you start agents.
- Requires Paseo 0.15.0 or later. Tested on Linux; macOS is expected to work.

See the [README](https://github.com/stephaneminisini/paseo-langfuse-skills#readme) for the key
file format and development commands.

## Writing skills for this plugin

- Refer to files that ship with the skill as `<skill-dir>/<file>`. The note tells the agent which
  folder that is.
- Run scripts through their interpreter, for example `bash <skill-dir>/run.sh`. Langfuse does not
  keep file permissions, so downloaded scripts are not executable.

## Data and permissions

- The plugin's server part sends your Langfuse keys only to the configured Langfuse URL, to list
  skills and download skill files.
- Downloaded skill files stay on the Paseo host. The plugin never runs them.
- The attachment note is sent to your agent provider with your message. When the agent reads
  `SKILL.md` or other skill files, their contents go to the provider like any other file the
  agent reads, and the agent runs any skill scripts under its normal permissions.
- Old skill versions are not deleted automatically. Remove folders under
  `~/.local/share/paseo-langfuse-skills/skills/` to free space.
