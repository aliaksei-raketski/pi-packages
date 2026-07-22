<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

# General Guidelines for working with Nx

- For navigating/exploring the workspace, invoke the `nx-workspace` skill first - it has patterns for querying projects, targets, and dependencies
- When running tasks (for example build, lint, test, e2e, etc.), always prefer running the task through `nx` (i.e., `nx run`, `nx run-many`, `nx affected`) instead of using the underlying tooling directly
- Prefix nx commands with the workspace's package manager (e.g., `pnpm nx build`, `npm exec nx test`) - avoids using globally installed CLI
- For Nx plugin best practices, check `node_modules/@nx/<plugin>/PLUGIN.md`. Not all plugins have this file - proceed without it if unavailable.
- NEVER guess CLI flags - always check `--help` or the local Nx documentation helper first when unsure

## Scaffolding & Generators

- For scaffolding tasks (creating apps, libs, project structure, setup), ALWAYS invoke the `nx-generate` skill FIRST before exploring or using documentation lookup

## When to use the Nx documentation helper

- USE for: advanced config options, unfamiliar flags, migration guides, plugin configuration, edge cases
- DON'T USE for: basic generator syntax (`nx g @nx/react:app`), standard commands, things you already know
- The `nx-generate` skill handles generator discovery internally - don't use documentation lookup just to look up generator syntax
- In this workspace, the packaged helper is available after sync at `packages/nx-developer/skills/nx-docs/scripts/search-documentation.mjs`

<!-- nx configuration end-->

# Project-Specific Guidance

## Nx Command Invocation

- In this workspace, run Nx with `pnpm nx ...` for ad hoc Nx commands. Do not use a globally installed `nx`.
- Use `pnpm nx <args>` directly; do not insert `--` after `nx` because it is passed through to the Nx CLI.
- Existing package scripts may call `nx` directly because npm scripts resolve `node_modules/.bin` automatically.

## Pi Package Management

- For creating or managing Pi packages in this workspace, use the provided Nx generators instead of manually creating package structure or editing Pi package metadata.
- Use `@aliaksei-raketski/nx-pi:package` for new Pi package containers.
- Use the Pi component generators for package internals: `@aliaksei-raketski/nx-pi:extension`, `@aliaksei-raketski/nx-pi:skill`, `@aliaksei-raketski/nx-pi:prompt`, and `@aliaksei-raketski/nx-pi:theme`.
- For existing Pi packages, add or update components through those generators as well; do not hand-roll folders, `package.json` `pi` entries, `files` allowlists, keywords, test config, or TypeScript config unless a generator is missing required behavior.
- Check generator options with `pnpm nx g <generator> --help` and prefer `--dry-run` before applying changes.
