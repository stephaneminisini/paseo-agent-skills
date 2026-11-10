# Agent Skills

Agent Skills lets you attach a skill to one agent launch, whatever the provider. Skills come from
a local store on the Paseo host or from [Langfuse](https://langfuse.com/docs/skill-management).
Open **New workspace** (or any composer), pick **Attach > Skill**, and choose a skill. The agent
receives a short note telling it where the skill's files are and to read its `SKILL.md`. It works
the same for Claude Code, Codex, and other providers.

## Skills screen

The **Skills** screen in the sidebar lists every skill in one list, filtered by **All**,
**Local**, **Langfuse** or **Found**:

- **Local**: skills in the plugin's store on this host. Each import creates a new version; older
  versions stay on disk, so agents already using one are not affected.
- **Langfuse**: skills in your Langfuse project. The picker uses the version that carries your
  label (`production` by default).
- **Found**: skill folders already on this host, in `~/.claude/skills`, `~/.codex/skills`,
  `~/.agents/skills`, and the skills of installed Claude Code plugins. Import one to use it with
  any provider.

Import a found skill with one click, or use **Import...** with a folder path. An imported skill
is an independent copy. When its source folder changes later, the row shows **Source updated**
and offers **Re-import**; when the folder is gone, **Source missing**. Skills from Claude Code
plugins follow the plugin across updates.

Tap a skill to open it. On desktop and web, a local skill opens in the editor: a file tree on the
left (add files and folders, rename, delete) and the selected file on the right. **Save** creates
the next version; agents already using an earlier version keep it. Unsaved changes stay as a
draft while the app is open, marked **Unsaved** in the list, and are lost when the app reloads.
**New skill** starts from a `SKILL.md` template, and **Delete** removes a local skill from the list
and the picker while agents already using it keep their copy.

Langfuse and found skills open read-only. On a phone every skill opens read-only: pick a file to
read it.

## Use a skill in a schedule

Schedules take a plain prompt, so they have no **Attach** menu. Press **Copy note** on a local
skill and paste the note into the schedule's prompt instead. Choose:

- **Pinned to vN**: the schedule keeps using that version, even after you save new ones.
- **Always the latest version**: the note points at the skill's `current` folder, which follows
  every save, including edits you have not checked yet. Deleting the skill removes `current`, so
  the schedule's agent stops finding it instead of using a deleted skill.

## Sync to Langfuse

**Sync** pushes a local or found skill to Langfuse as a new version, so other hosts can use it.
Langfuse labels it `latest`; promote it to `production` in Langfuse when it is ready. Sync never
changes labels and never deletes anything.

- Not in Langfuse yet, or Langfuse unchanged since your last sync: the new version is created
  right away.
- Already identical: nothing is sent.
- Langfuse changed since your last sync (or a found skill differs from Langfuse): a review shows
  each file as changed, only here or only in Langfuse, with a line diff. Choose **Push mine
  anyway**, **Take Langfuse's** (saves Langfuse's copy as a new local version; local skills only),
  or **Cancel**. If Langfuse gets yet another version while you review, the push is refused and
  you review again.
- Files that came into a skill through a symlink pointing outside its folder are listed, and you
  must tick **Include files from outside the skill folder** before pushing.

Local rows show the sync state: **Langfuse vN** when in sync, **Not in Langfuse**, **Local
changes**, or **Langfuse changed**. Sync is available on desktop and web.

## Limits

- Text files only. A skill folder with any other kind of file (images, fonts, native libraries)
  is shown as **Not importable**, with the file that blocks it.
- A skill may have at most 200 files and 2 MB.
- A skill's name is the `name` in its `SKILL.md` frontmatter.
- A skill's name cannot be changed; create a new skill instead.
- Langfuse skills are read-only here; change them by syncing a local copy.

## Setup

- Local skills need no setup.
- For Langfuse: a project with skills (Langfuse Cloud or self-hosted) and a public/secret API key
  pair. Put the keys in a key file on the Paseo host containing `LANGFUSE_PUBLIC_KEY` and
  `LANGFUSE_SECRET_KEY`, readable only by you (`chmod 600`). Keys are never stored in Paseo
  settings. In the plugin settings, set the base URL, label and key file path, then press
  **Test connection**.
- Settings, local skills and downloads are per host. Configure each host where you start agents.
- Requires Paseo 0.15.0 or later. Tested on Linux; macOS is expected to work.

See the [README](https://github.com/stephaneminisini/paseo-agent-skills#readme) for the key file
format and development commands.

## Writing skills

- Refer to files that ship with the skill as `<skill-dir>/<file>`. The note tells the agent which
  folder that is.
- Run scripts through their interpreter, for example `bash <skill-dir>/run.sh`. Copied and
  downloaded scripts are not executable.

## Data and permissions

- Local skills are stored under `~/.local/share/paseo-agent-skills/local/`, Langfuse downloads
  under `~/.local/share/paseo-agent-skills/langfuse/`. Old versions are not deleted
  automatically.
- Import reads the source folder and never writes to it. The plugin scans the found locations
  listed above, and reads `~/.claude/plugins/installed_plugins.json` to find plugin skills.
- Your Langfuse keys are sent only to the configured Langfuse URL, to list, download and (on
  Sync) create skill versions. Sync sends every file of the skill to Langfuse, including files
  reached through symlinks once you confirm them.
- The plugin never runs skill files. The attachment note goes to your agent provider with your
  message; when the agent reads skill files, their contents go to the provider like any other
  file it reads, and it runs skill scripts under its normal permissions.
