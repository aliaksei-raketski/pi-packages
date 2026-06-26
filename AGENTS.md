# AGENTS.md

Guidance for coding agents working in this repository.

## Repository overview

This is a private npm workspaces monorepo for public Pi packages. Workspace packages live under `packages/*` and may provide Pi skills, Pi extensions, helper scripts, or other package assets.

When working in a package, read its `package.json`, `README.md`, and relevant source/skill files before changing behavior.

## Tooling and commands

Use npm, not pnpm or yarn. Keep `package-lock.json` in sync when dependencies or workspace metadata change.

Common commands:

```bash
npm install          # install/update dependencies
npm run lint        # Biome check
npm run format      # Biome format --write
npm run typecheck   # TypeScript no-emit check
npm test            # node --test via tsx
npm run pack:dry-run
npm run check       # lint + typecheck + tests + dry-run pack
npm run sync        # run workspace sync scripts, if present
```

Before handing off code changes, run `npm run check` when practical. If you cannot run it, say so and explain why.

## Code style

- TypeScript is strict (`noUnusedLocals`, `noUnusedParameters`). Avoid unused exports, variables, and imports.
- This repo uses ESM and `moduleResolution: "Bundler"`.
- Keep relative TypeScript imports explicit with `.ts` extensions, matching existing code.
- Biome formatting rules: tabs for indentation, double quotes, semicolons, 100-column line width.
- Prefer small, focused modules and tests for pure logic.
- Keep command-line helpers deterministic: JSON/data on stdout, diagnostics on stderr when applicable.
- Do not edit `node_modules/`, generated build output, local cache directories, or package tarballs.

## Working with packages

- Keep each workspace package self-contained and publishable from its package directory.
- Keep package `README.md` files aligned with user-facing commands, behavior, and installation instructions.
- Add or update tests when changing executable TypeScript behavior.
- If a package has a sync or generation script, prefer changing the source/overlay/script that produces generated content rather than hand-editing generated output. Run sync scripts only when you intend to refresh that content.
- When adding a new workspace package, add the package under `packages/`, include the required package metadata/assets, and update the root `README.md` package table.
- Use short, unprefixed workspace directory names under `packages/` (for example `packages/fast-mode`); publishable npm package names use the scoped `@aliaksei-raketski/pi-<workspace>` form (for example `@aliaksei-raketski/pi-fast-mode`).

## Pi package metadata

Each published workspace must keep its `package.json` Pi metadata accurate:

- Skill packages use `pi.skills` pointing at the skills directory.
- Extension packages use `pi.extensions` pointing at their entrypoint.
- Keep the `files` array restrictive so npm packages contain only runtime/package assets.
- Keep `engines`, `license`, repository metadata, and publish config accurate.
- Packages are public and published by GitHub Actions; do not publish manually from local runs.

## CI and publishing

CI runs on Node.js 24 with `npm ci` followed by `npm run check`.
Publishing runs the same verification, then publishes workspace versions that are not already on npm.
When changing publishable package contents, consider whether the affected workspace version should be bumped.
