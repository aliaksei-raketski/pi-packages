# @aliaksei-raketski/pi-nx-developer

Pi package that vendors the official Nx Agent Skills with a local Nx documentation helper.

## Install

```bash
pi install npm:@aliaksei-raketski/pi-nx-developer
# or project-local
pi install -l npm:@aliaksei-raketski/pi-nx-developer
```

## Installed skills

- `link-workspace-packages`
- `nx-developer`
- `nx-docs`
- `nx-generate`
- `nx-import`
- `nx-plugins`
- `nx-run-tasks`
- `nx-workspace`

`monitor-ci` is intentionally excluded until Nx Cloud automation is replaced by local scripts.

If a workspace already contains project-local generated Nx skills under `.agents/skills`, Pi will prefer those local skills over same-named package skills and report collisions. Remove or disable the project-local duplicates if you want this package's copies to be used in that workspace.

## Documentation helper

Use the bundled helper from the installed `nx-docs` skill directory:

```bash
node scripts/search-documentation.mjs "targetDefaults nx.json" --limit 4
node scripts/search-documentation.mjs "nx release independent changelog" --limit 5 --json --pretty
```

Or from any directory with an absolute path to the installed script.

## Sync vendored skills

Run from this package root:

```bash
node scripts/sync-nx-skills.mjs
```

Use `NX_AI_AGENTS_CONFIG_REF` to sync a different upstream ref:

```bash
NX_AI_AGENTS_CONFIG_REF=<ref> node scripts/sync-nx-skills.mjs
```

After sync, validate the docs helper:

```bash
node skills/nx-docs/scripts/search-documentation.mjs "targetDefaults nx.json" --limit 2
node skills/nx-docs/scripts/search-documentation.mjs "nx release independent changelog" --limit 2 --json --pretty
```

## Attribution

Portions of the vendored Nx Agent Skills are derived from [`nrwl/nx-ai-agents-config`](https://github.com/nrwl/nx-ai-agents-config). See [NOTICE.md](NOTICE.md).
