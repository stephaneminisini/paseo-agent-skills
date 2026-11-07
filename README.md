# paseo-langfuse-skills

A [Paseo](https://paseo.sh) plugin that attaches [Langfuse skills](https://langfuse.com/docs/skill-management)
to an agent launch. See [OVERVIEW.md](OVERVIEW.md) for what it does and [docs/setup.md](docs/setup.md)
for setup.

## Install

```bash
paseo plugin add git:stephaneminisini/paseo-langfuse-skills
```

## Key file

```bash
mkdir -p ~/.config/paseo-langfuse-skills
cat > ~/.config/paseo-langfuse-skills/langfuse.env <<'KEYS'
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
KEYS
chmod 600 ~/.config/paseo-langfuse-skills/langfuse.env
```

## Development

```bash
npm install
npm run typecheck
npm test
paseo plugin install /absolute/path/to/paseo-langfuse-skills
paseo plugin reload langfuse-skills   # after changes
```
