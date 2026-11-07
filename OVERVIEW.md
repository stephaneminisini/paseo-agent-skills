# Langfuse Skills

Attach a skill stored in [Langfuse](https://langfuse.com/docs/skill-management) to one agent
launch. Works with any agent provider, including Claude Code and Codex.

## How it works

1. In the composer, open **Attach → Skill** and search by name or description. Only skills with a
   version carrying your label (default `production`) are listed.
2. The plugin stores that version's files on the host, once per version, under
   `~/.local/share/paseo-langfuse-skills/skills/<name>/v<version>/`. A version already on disk is
   reused. A new version gets its own folder, so agents using an older one are not affected.
3. The agent receives a short note naming the folder and telling it to read `SKILL.md`.

The skill is not installed into `~/.claude/skills` or `~/.codex/skills`; only the agent you attach
it to sees it. Old versions stay on disk until you delete them.

## Writing skills for this plugin

- Refer to files that ship with the skill as `<skill-dir>/<file>`. The note tells the agent which
  folder that is. Do not hardcode `~/.claude/skills/<name>/`.
- Run scripts with their interpreter, for example `bash <skill-dir>/run.sh`. Langfuse does not
  keep file permissions, so scripts are not executable on disk.
- Text files only. A skill version with a non-text file is refused with a message naming the file.
- Every file is checked against its Langfuse hash. Paths that would leave the skill folder are
  refused. The plugin never runs skill files; the agent does, under its usual permissions.
