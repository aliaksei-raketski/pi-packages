# Angular Documentation Helpers

Use the local helper scripts bundled with this skill for:

- version-aware Angular best practices lookup
- official angular.dev documentation search

## Best practices

Before writing or modifying Angular code in an existing workspace, run one of the following commands:

```bash
# From skills/angular-developer/
node scripts/get-best-practices.mjs /absolute/path/to/workspace

# From any directory
node /absolute/path/to/skills/angular-developer/scripts/get-best-practices.mjs /absolute/path/to/workspace
```

If you do not pass a workspace path, the script searches upward from the current directory for `angular.json`.

## Angular documentation search

Use the local search helper:

```bash
node scripts/search-documentation.mjs "signals resource" --version 22 --limit 5
node scripts/search-documentation.mjs "signal forms validation" --version 22 --include-top-content
```

## Usage notes

- Run the scripts from `skills/angular-developer/`, or by using absolute script paths.
- If the project Angular version is known, pass the major version to `search-documentation.mjs` with `--version`.
- If deeper or current docs are needed, add `--include-top-content` to retrieve concise top-page context.
- Prefer vendored references under `references/` first, then use `search-documentation.mjs` for fresher/cross-topic lookup.
