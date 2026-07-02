# @aliaksei-raketski/pi-angular-developer

A Pi package that vendors the official Angular `angular-developer` Agent Skill and replaces Angular MCP guidance with local helper scripts.

## Install

```bash
pi install npm:@aliaksei-raketski/pi-angular-developer
# or project-local
pi install -l npm:@aliaksei-raketski/pi-angular-developer
```

## Installed skill

- `skills/angular-developer`

This package is distributed as source files and markdown resources; Pi loads the skill directly from the installed package.

## Package contents

- Angular developer skill instructions and references.
- Local documentation helper scripts used by the skill.

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
