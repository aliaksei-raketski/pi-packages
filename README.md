# Pi Packages

Monorepo for public npm-distributed [Pi](https://pi.dev) packages.

## Packages

| Workspace | npm package | Install |
| --- | --- | --- |
| `packages/angular-developer` | `@aliaksei-raketski/pi-angular-developer` | `pi install npm:@aliaksei-raketski/pi-angular-developer` |
| `packages/taiga-ui-docs` | `@aliaksei-raketski/pi-taiga-ui-docs` | `pi install npm:@aliaksei-raketski/pi-taiga-ui-docs` |
| `packages/fast-mode` | `@aliaksei-raketski/pi-fast-mode` | `pi install npm:@aliaksei-raketski/pi-fast-mode` |
| `packages/statusline` | `@aliaksei-raketski/pi-statusline` | `pi install npm:@aliaksei-raketski/pi-statusline` |

## Development

Install dependencies:

```bash
npm install
```

Run checks:

```bash
npm run check
```

The check includes a lockfile alignment validation (`npm ci --dry-run`).
If it fails, fix lockfile alignment by running:

```bash
npm run lockfile:fix
```

## Releasing

The repository uses **Release Please** with Conventional Commits. Merges to `main`
that contain commit types like `feat:`/`fix:`/`feat!:` will create/update the
release PR and generate changelogs under each package's `CHANGELOG.md`.

Useful commit patterns:

- `feat(scope): ...` -> minor
- `fix(scope): ...` -> patch
- `feat(scope)!: ...` / `fix(scope)!: ...` -> major

Release PRs are generated automatically by:

```bash
.github/workflows/release-please.yml
```

These release and publish workflows are triggered only after `CI` completes successfully on `main`, so a failed CI run does not start release or publishing.
The publish workflow also short-circuits unless the latest `main` push changed both `.release-please-manifest.json` and at least one `packages/<package>/package.json`, to avoid running on non-release pushes.

When adding a new package, also update:

- `release-please-config.json` with a new package entry (for example `packages/my-package` with `release-type: node`, `package-name`, and optional `changelog-path`).
- `.release-please-manifest.json` with the current package version.
- package metadata and `package-lock.json` alignment by running:

```bash
npm run lockfile:fix
```

Try extensions locally:

```bash
npm run try:fast-mode
# or
pi -e ./packages/fast-mode

npm run try:statusline
# or
pi -e ./packages/statusline
```

Preview package contents:

```bash
npm run pack:dry-run
```

Sync vendored skills:

```bash
npm run sync
```

## Publishing

Packages are published to the public npm registry from GitHub Actions.
