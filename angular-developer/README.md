# Angular Developer Pi Package

A Pi package that vendors the official Angular `angular-developer` Agent Skill and replaces Angular MCP guidance with local helper scripts.

## Installed skill

- `skills/angular-developer`

## Key helpers

- `skills/angular-developer/scripts/get-best-practices.mjs`
- `skills/angular-developer/scripts/search-documentation.mjs`

From the skill directory:

```bash
node scripts/get-best-practices.mjs --help
node scripts/search-documentation.mjs "signals" --version 22 --limit 3 --json
```

## Sync

Run from package root:

```bash
node scripts/sync-angular-skill.mjs
```

Use `ANGULAR_SKILLS_REF` to override the synced ref.

After sync, consider validating the helper scripts:

```bash
node skills/angular-developer/scripts/search-documentation.mjs "signals" --version 22 --limit 2 --json
node skills/angular-developer/scripts/get-best-practices.mjs --help
```
