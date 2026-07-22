---
name: nx-docs
description: Search current Nx documentation. USE WHEN answering questions about Nx configuration, advanced options, migrations, plugin setup, release configuration, caching, affected/project graph behavior, or when CLI help is insufficient. Prefer standard Nx CLI help for basic command syntax.
---

# Nx Documentation Search

Use this skill when you need current Nx documentation beyond basic CLI help.

## Local helper

Run the bundled helper from this skill directory:

```bash
node scripts/search-documentation.mjs "targetDefaults nx.json" --limit 4
```

Or run it from any directory with an absolute script path:

```bash
node /absolute/path/to/skills/nx-docs/scripts/search-documentation.mjs "nx release independent changelog" --limit 5 --json --pretty
```

Read [references/docs-helpers.md](references/docs-helpers.md) for full usage notes.

## When to use docs search

Use documentation search for:

- advanced `nx.json` configuration
- target defaults, named inputs, caching, and task pipeline behavior
- release configuration and changelog/versioning behavior
- migrations and version-specific behavior
- plugin setup and edge cases
- affected/project graph behavior when CLI output is not enough

Prefer standard CLI help for basic command syntax and flags:

```bash
pnpm nx <command> --help
pnpm nx g <generator> --help
```

## Other Nx information sources

- Workspace/project data: use standard Nx CLI commands such as `pnpm nx show projects --json`, `pnpm nx show project <name> --json`, and `pnpm nx graph --print`.
- Plugin best practices: check `node_modules/@nx/<plugin>/PLUGIN.md` when relevant and when the file exists.
