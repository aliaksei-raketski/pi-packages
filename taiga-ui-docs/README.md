# Taiga UI Docs Pi Package

A Pi package that ships one skill (`taiga-ui-docs`) with a bundled helper script for Taiga UI documentation.

The skill replaces the `@taiga-ui/mcp` tool surface with CLI-equivalent commands:

- `node scripts/taiga-ui-docs.mjs overview`
- `node scripts/taiga-ui-docs.mjs list [query]`
- `node scripts/taiga-ui-docs.mjs example <name...>`
- `node scripts/taiga-ui-docs.mjs migration`

## Install

```bash
pi install ./taiga-ui-docs
# or project-local
pi install -l ./taiga-ui-docs
```

## Skill

See `skills/taiga-ui-docs/SKILL.md`.

## Helper script

```bash
node scripts/taiga-ui-docs.mjs --help
```

The script is intentionally self-contained:

- Node 18+ (`node` built-ins + global `fetch` only)
- no build step
- no external dependencies
- JSON output on stdout

## Commands

From `skills/taiga-ui-docs/`:

```bash
node scripts/taiga-ui-docs.mjs overview --pretty
node scripts/taiga-ui-docs.mjs list button --limit 100 --pretty
node scripts/taiga-ui-docs.mjs example Button --max-chars 24000 --pretty
node scripts/taiga-ui-docs.mjs migration --pretty
```

You can point the parser at a local `llms-full.txt` for offline use:

```bash
node scripts/taiga-ui-docs.mjs list button --source-file ./llms-full.txt --pretty
```
