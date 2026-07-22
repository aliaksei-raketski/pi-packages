---
name: nx-developer
description: General Nx workspace guidance. USE WHEN working in an Nx workspace, answering Nx architecture/configuration questions, choosing Nx commands, or deciding which Nx-specific skill/helper to use. Routes to nx-workspace, nx-generate, nx-run-tasks, nx-plugins, nx-import, and nx-docs as appropriate.
---

# Nx Developer

Use this skill as the general router for Nx work. Load the more focused Nx skills when they match the task.

## General Nx command rules

- Prefer Nx commands (`nx run`, `nx run-many`, `nx affected`, `nx show`, `nx graph`) over calling underlying tools directly.
- Prefix Nx commands with the workspace package manager, for example `pnpm nx ...`, `npm exec nx ...`, `yarn nx ...`, or `bunx nx ...`. Check the lockfile before choosing.
- Use `--no-interactive` for generators and commands that could prompt.
- Do not guess unfamiliar CLI flags. Use `<package-manager> nx <command> --help` first, then the `nx-docs` skill for deeper/current documentation.

## Workspace exploration routing

Use the `nx-workspace` skill when answering questions about projects, targets, dependencies, or workspace architecture.

Useful CLI commands:

```bash
pnpm nx show projects --json
pnpm nx show project <project-name> --json
pnpm nx graph --print
```

For project-specific structure and inferred targets, prefer `pnpm nx show project <project-name> --json` over reading `project.json` directly.

## Generator/scaffolding routing

Use the `nx-generate` skill before scaffolding projects, libraries, plugins, package structure, or other generated artifacts.

Key rules:

- Prefer local workspace generators over external plugin generators when both apply.
- Check generator help with `pnpm nx g <generator> --help`.
- Read the generator source when behavior or file placement matters.
- Run a dry run first when supported.

## Task running routing

Use the `nx-run-tasks` skill when running build, test, lint, typecheck, serve, e2e, or other Nx targets.

Prefer:

```bash
pnpm nx run <project>:<target>
pnpm nx run-many -t <target>
pnpm nx affected -t <target>
```

## Plugin and import routing

- Use `nx-plugins` when discovering or adding Nx plugins.
- Use `nx-import` when migrating/importing existing projects into an Nx workspace.
- Use `link-workspace-packages` when sibling workspace packages need dependency links or imports fail for workspace packages.

## Documentation lookup routing

Use the `nx-docs` skill when CLI help is not enough, especially for advanced configuration, migrations, plugin setup, release configuration, caching, affected behavior, or project graph behavior.

The local helper can be run from the `nx-docs` skill directory:

```bash
node scripts/search-documentation.mjs "targetDefaults nx.json" --limit 4
```

Or from any directory with an absolute path to that script.

## Plugin best practices

When plugin-specific best practices are needed, check `node_modules/@nx/<plugin>/PLUGIN.md` if it exists. Not every plugin ships this file.

## Not included yet

Nx Cloud CI monitoring/self-healing automation is intentionally not included in this package yet. Use standard Nx/Nx Cloud CLI workflows or repository-specific guidance until script-based support is added.
