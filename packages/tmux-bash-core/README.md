# @aliaksei-raketski/pi-tmux-bash-core

Compiled, Pi-independent, read-only helpers shared by `pi-tmux-bash` and local diagnostics.

```ts
import {
  listManagedTmuxWindows,
  parseManagedRunManifest,
  resolveTmuxWorkspaceScope,
} from '@aliaksei-raketski/pi-tmux-bash-core';
```

The package exposes strict scope/manifest/metadata parsing, stable naming and ownership constants, bounded tmux discovery through an injected executor, and structured attach command construction. It intentionally does not expose command launch, mutable runtime maps, continuation gates, completion delivery, interactive input, or artifact deletion.
