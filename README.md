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
