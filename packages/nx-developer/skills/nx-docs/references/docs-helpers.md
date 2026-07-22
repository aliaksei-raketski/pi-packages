# Nx Documentation Helpers

Use the local helper script bundled with this skill to search current Nx documentation without relying on always-on docs tooling.

## Search Nx documentation

From `skills/nx-docs/`:

```bash
node scripts/search-documentation.mjs "targetDefaults nx.json" --limit 4
node scripts/search-documentation.mjs "nx release independent changelog" --limit 5 --json --pretty
```

From any directory, use an absolute script path:

```bash
node /absolute/path/to/skills/nx-docs/scripts/search-documentation.mjs "namedInputs production" --limit 3
```

## Options

- positional query terms are joined with spaces
- `--limit <n>` / `--limit=<n>`: number of results, default `4`, clamped to `1` through `15`
- `--json`: output JSON
- `--pretty`: pretty-print JSON output
- `--help`: show CLI help

## When to prefer other sources

- Use `pnpm nx <command> --help` for basic CLI syntax and flags.
- Use `pnpm nx show projects --json`, `pnpm nx show project <name> --json`, and `pnpm nx graph --print` for local workspace facts.
- Use `node_modules/@nx/<plugin>/PLUGIN.md` for plugin best practices when the file exists.

## Notes

The helper queries the same public Nx documentation embedding endpoint used for AI documentation context and prints source URLs for each section. The endpoint is unauthenticated but external, so network access is required.
