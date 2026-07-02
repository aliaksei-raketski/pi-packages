# @aliaksei-raketski/nx-pi

Nx plugin with generators for creating and maintaining Pi package workspaces.

## Generators

Use these generators from the repository root:

```bash
pnpm nx g @aliaksei-raketski/nx-pi:package my-package --dry-run --no-interactive
pnpm nx g @aliaksei-raketski/nx-pi:extension my-extension --project=@aliaksei-raketski/pi-my-package --no-interactive
pnpm nx g @aliaksei-raketski/nx-pi:skill my-skill --project=@aliaksei-raketski/pi-my-package --no-interactive
pnpm nx g @aliaksei-raketski/nx-pi:prompt my-prompt --project=@aliaksei-raketski/pi-my-package --no-interactive
pnpm nx g @aliaksei-raketski/nx-pi:theme my-theme --project=@aliaksei-raketski/pi-my-package --no-interactive
```

Check generator options before applying changes:

```bash
pnpm nx g @aliaksei-raketski/nx-pi:package --help
pnpm nx g @aliaksei-raketski/nx-pi:extension --help
```

## Development

```bash
pnpm nx run @aliaksei-raketski/nx-pi:build
pnpm nx run @aliaksei-raketski/nx-pi:test
```
