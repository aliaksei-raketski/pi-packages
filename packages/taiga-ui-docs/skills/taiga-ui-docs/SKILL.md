---
name: taiga-ui-docs
description: Use when implementing, debugging, reviewing, migrating, or looking up Angular Taiga UI components. Provides a bundled helper script equivalent to Taiga UI MCP docs tools for overview/import guidance, section lists, exact component documentation/examples, and migration guide content from llms-full.txt.
compatibility: Requires Node.js 18+ for scripts/taiga-ui-docs.mjs.
---

# Taiga UI Docs

Use the bundled script as the source of truth for Taiga UI docs. Do not guess Taiga UI import paths, component APIs, migration commands, or examples from memory.

## Available scripts

- `scripts/taiga-ui-docs.mjs` — self-contained Node.js 18+ helper script that fetches/parses Taiga UI `llms-full.txt` and returns JSON.

## Workflow

For fresh implementation work, start with overview, then list, then exact examples:

```bash
node scripts/taiga-ui-docs.mjs overview --pretty
node scripts/taiga-ui-docs.mjs list <query> --pretty --limit 100
node scripts/taiga-ui-docs.mjs example <ComponentName> --pretty --max-chars 24000
```

For upgrades:

```bash
node scripts/taiga-ui-docs.mjs migration --pretty
```

If output is truncated, continue with returned `nextOffset`:

```bash
node scripts/taiga-ui-docs.mjs example <ComponentName> --pretty --offset <nextOffset> --max-chars 24000
```

## Rules

- Use script JSON output as the source of truth.
- For multiple known components, call `example` with multiple names.
- If `example` returns suggestions, retry with the closest suggestion.
- Diagnostics are on `stderr`; command results are JSON on `stdout`.
- `--help` prints full options.

## Source override

Default source URL: `https://taiga-ui.dev/llms-full.txt`.

```bash
node scripts/taiga-ui-docs.mjs list button --source-file ./llms-full.txt --pretty
node scripts/taiga-ui-docs.mjs overview --source-url https://taiga-ui.dev/llms-full.txt --pretty
SOURCE_URL=https://taiga-ui.dev/llms-full.txt node scripts/taiga-ui-docs.mjs migration --pretty
```
