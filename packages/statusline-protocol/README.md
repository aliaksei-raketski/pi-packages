# @aliaksei-raketski/pi-statusline-protocol

Shared structured statusline protocol helpers for Pi packages.

This package is a normal JavaScript library consumed by Pi extensions such as `@aliaksei-raketski/pi-statusline` and `@aliaksei-raketski/pi-fast-mode`. Unlike extension packages that Pi can load from TypeScript source, this package is imported through npm package exports and must publish its compiled `dist` artifacts.

## Exports

- `STATUSLINE_STATUS_SET_EVENT`
- `STATUSLINE_STATUS_CLEAR_EVENT`
- `STATUSLINE_STATUS_SNAPSHOT_REQUEST_EVENT`
- `STATUSLINE_STATUS_SNAPSHOT_EVENT`
- helpers for publishing and subscribing to structured statusline status updates

## Build

From the repository root:

```bash
pnpm nx run @aliaksei-raketski/pi-statusline-protocol:build
```

## Test

From the repository root:

```bash
pnpm nx run @aliaksei-raketski/pi-statusline-protocol:test
```
