# Pi Packages

Nx monorepo for public npm-distributed [Pi](https://pi.dev) packages.

## Packages

| Workspace                    | npm package                               | Description                                                                         | Install                                                  |
| ---------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `packages/angular-developer` | `@aliaksei-raketski/pi-angular-developer` | Angular developer skill with local documentation helper scripts.                    | `pi install npm:@aliaksei-raketski/pi-angular-developer` |
| `packages/taiga-ui-docs`     | `@aliaksei-raketski/pi-taiga-ui-docs`     | Taiga UI docs skill backed by a bundled helper script.                              | `pi install npm:@aliaksei-raketski/pi-taiga-ui-docs`     |
| `packages/fast-mode`         | `@aliaksei-raketski/pi-fast-mode`         | Extension that enables fast-mode payload tuning for supported Claude/OpenAI models. | `pi install npm:@aliaksei-raketski/pi-fast-mode`         |
| `packages/statusline`        | `@aliaksei-raketski/pi-statusline`        | Extension for a customizable, ANSI-aware statusline footer.                         | `pi install npm:@aliaksei-raketski/pi-statusline`        |

## Development

Install dependencies:

```bash
pnpm install
```

List Nx projects:

```bash
pnpm exec nx show projects
```

Inspect a project:

```bash
pnpm exec nx show project @aliaksei-raketski/pi-fast-mode --json
```

Run checks for all Pi packages:

```bash
pnpm exec nx run-many \
  --projects=@aliaksei-raketski/pi-angular-developer,@aliaksei-raketski/pi-fast-mode,@aliaksei-raketski/pi-statusline,@aliaksei-raketski/pi-taiga-ui-docs \
  -t lint,typecheck
```

Run extension tests:

```bash
pnpm exec nx run @aliaksei-raketski/pi-fast-mode:test
pnpm exec nx run @aliaksei-raketski/pi-statusline:test
```

Explore the workspace graph:

```bash
pnpm exec nx graph
```

## Generating Pi packages and components

Use the local Nx generators instead of hand-rolling package metadata or Pi component folders.

Create a package container:

```bash
pnpm exec nx g @aliaksei-raketski/nx-pi:package my-package --dry-run --no-interactive
pnpm exec nx g @aliaksei-raketski/nx-pi:package my-package --no-interactive
```

Add components to an existing Pi package:

```bash
pnpm exec nx g @aliaksei-raketski/nx-pi:skill my-skill \
  --project=@aliaksei-raketski/pi-my-package \
  --no-interactive

pnpm exec nx g @aliaksei-raketski/nx-pi:prompt my-prompt \
  --project=@aliaksei-raketski/pi-my-package \
  --no-interactive

pnpm exec nx g @aliaksei-raketski/nx-pi:theme my-theme \
  --project=@aliaksei-raketski/pi-my-package \
  --no-interactive

pnpm exec nx g @aliaksei-raketski/nx-pi:extension my-extension \
  --project=@aliaksei-raketski/pi-my-package \
  --no-interactive
```

Check available options before applying changes:

```bash
pnpm exec nx g @aliaksei-raketski/nx-pi:package --help
pnpm exec nx g @aliaksei-raketski/nx-pi:skill --help
pnpm exec nx g @aliaksei-raketski/nx-pi:extension --help
```

## Trying extensions locally

```bash
pi -e ./packages/fast-mode
pi -e ./packages/statusline
```

## Syncing vendored skills

Some skill packages include their own maintenance scripts. For example:

```bash
pnpm --filter @aliaksei-raketski/pi-angular-developer sync
```

## Publishing

Packages are intended to be published to the public npm registry. Use Nx project metadata and package-level `package.json` versions as the source of truth during release automation.
