# @aliaksei-raketski/pi-tmux-bash

A Pi extension that replaces model-facing `bash` with owned tmux windows. It preserves normal foreground behavior while adding durable background runs, stable `@<windowId>` control, completion policies, optional interactive input and `!` routing, safe attach UX, resource quotas, and opt-in non-Git scopes.

## Prerequisite and installation

Install `tmux` on `PATH` (or configure an absolute `tmuxBinary`), then install:

```sh
pi install npm:@aliaksei-raketski/pi-tmux-bash
```

The package registers model-facing `bash` and `tmux` tools plus `/tmux-attach`, `/tmux-cleanup-preview`, and `/tmux-cleanup` where enabled.

## Command lifecycle and waiting

```json
{ "command": "pnpm nx test app" }
```

Explicit background process:

```json
{
  "command": "pnpm nx serve app",
  "background": true,
  "waitForCompletion": false
}
```

Example of required finite asynchronous work:

```json
{
  "command": "pnpm nx test app",
  "background": true,
  "waitForCompletion": true,
  "completionDelivery": "model"
}
```

Use `waitForCompletion: true` for every required finite command, including tests, builds, and subagents, regardless of duration or concurrent productive work. Use `false` only for persistent servers, watchers, or REPLs that are intentionally expected to remain alive. Waiting and completion delivery are independent.

The lifecycle is persisted as `reserved → starting → running → completed|failed|killed|orphaned`. A foreground timeout defaults to background execution and is awaited by default; `timeoutAction: "kill"` kills the validated owned window instead. Cancellation kills foreground work. Non-zero foreground exits remain normal bash tool errors with the actual status.

## Completion delivery policies

`defaultCompletionDelivery` is `model`; each bash call may override it with `completionDelivery`.

- `model` queues one bounded follow-up custom message, commits its wake handoff, then releases an awaited gate with `wake: "producer-message"`.
- `display` persists and shows one TUI/RPC notification without model context, then releases with `wake: "none"`. Without UI, the `tmux` tool's `list` action and durable entries retain the diagnostic.
- `next-turn` persists a bounded pending completion and releases with `wake: "none"`. The next natural model turn injects and consumes it once; it never creates a turn itself.

A display-only awaited command resumes an autonomous workflow only when a consumer explicitly enables the continuation protocol's single-winner `wake: none` auto-resume policy. Otherwise Pi remains idle until natural input.

Stable `completionId` values are persisted in manifests and session entries. Watcher, poller, adoption, and retry observations are idempotent. Before model redelivery after restart, the extension scans the active branch for an existing completion or consumed marker.

## Restart adoption

Adoption is off by default. Enable it only with a durable absolute directory:

```jsonc
{
  "adoptionPolicy": "same-pi-session",
  "durableOutputDir": "/home/me/.pi/agent/tmux-bash",
  "preserveOutputFiles": true,
  "adoptionScanTimeoutMs": 5000,
  "adoptPolling": true,
}
```

On `session_start`, the extension independently scans complete tmux ownership metadata and strict durable manifests before publishing its authoritative gate snapshot. It:

- adopts only the same `ctx.sessionManager.getSessionId()` and canonical workspace scope;
- restores only validated live awaited gates and optional pollers;
- delivers a completion written while Pi was offline without reconstructing a completed gate;
- marks a missing-window/no-sentinel run orphaned;
- ignores another session, changed ownership, malformed data, symlinks, unsafe permissions, and pre-enhancement windows missing the complete current metadata shape;
- treats tmux absence or scan timeout as a bounded startup diagnostic rather than a Pi startup failure.

Shutdown persists live intent, releases only in-process gates, stops timers, and does not kill preserved windows. Adoption cannot recover work whose tmux metadata or manifest was never fully committed, and cannot guarantee delivery if both the Pi session entry and durable completion marker are lost in the same storage failure.

There are no schema/protocol version fields or compatibility negotiation. Older windows carrying only `gitRoot`/`v1` options remain externally alive but unmanaged.

## `tmux` actions

Targets use stable IDs such as `@123`; numeric indexes and arbitrary sessions are rejected.

- `list` / `peek`: list in-scope runs or read a bounded tail. `list` includes resource usage diagnostics.
- `kill`: revalidate ownership, kill the run, and release its gate.
- `poll` / `unpoll` / `list-polls`: manage progress delivery independently of waiting.
- `await` / `unawait`: idempotently acquire or release a finite run's continuation gate without changing the process.
- `attach`: return safe structured argv and a shell-quoted display command; never take TUI control.
- `send-input` / `send-key`: opt-in literal UTF-8 input or one fixed control key.
- `cleanup-preview` / `cleanup`: preview or delete only validated eligible non-running artifacts.

### Interactive input

Enable input explicitly and include the actions:

```jsonc
{
  "interactiveInputEnabled": true,
  "maxInputBytes": 16384,
  "enabledTmuxActions": ["list", "peek", "kill", "await", "unawait", "send-input", "send-key"],
}
```

`send-input` uses tmux buffer/paste semantics and argv, never shell composition or tmux key syntax. `submit` defaults to `true`. `send-key` accepts only `enter`, `escape`, `ctrl-c`, or `ctrl-d`. Every call revalidates a live, in-scope, metadata-owned stable window. Input does not poll, await, unawait, or alter completion policy.

**Never put passwords, API keys, or other secrets in model tool arguments. Tool arguments remain session-visible.** Input text is not logged, displayed, or persisted in the manifest.

### Attach UX

The model action only presents `{ binary, args, display }`. `/tmux-attach [@id]` is the explicit user action. With no ID it selects among live in-scope runs, confirms how to return to Pi, revalidates ownership after confirmation, then temporarily stops/restarts the TUI around inherited-stdio tmux. RPC/non-TUI contexts only present the safe command.

Outside tmux the argv attaches the owned session and selects the stable window. Inside tmux it switches the active client to the owned session before selecting the stable window, without shell composition. Session names are data, not executable syntax.

## Optional `!` and `!!` routing

`routeUserBash` defaults to `false`. When true, the extension handles Pi's `user_bash` event with a `BashOperations` adapter backed by the same tmux supervisor.

- `event.cwd` is honored for each command;
- stdout/stderr bytes are forwarded in order;
- normal non-zero status is returned as the actual exit code;
- timeout and cancellation kill the foreground owned window when termination can be confirmed; if ownership or termination cannot be revalidated, the command remains monitored in the background and the result reports that uncertainty;
- no continuation gate, poller, background completion, or synthetic message is created;
- `PI_SESSION_ID`, session file, provider/model, and reasoning variables are removed;
- Pi still owns `!!` context exclusion because the extension returns standard operations/results.

No background syntax is added. Extension event ordering matters: only one `user_bash` router should own a command. Place tmux-bash deliberately relative to SSH, interactive-shell, sandbox, or other routers; leave `routeUserBash` off when another router should win.

## Resource limits and bounded output

Defaults are nonzero and apply per canonical workspace durable root:

```jsonc
{
  "maxConcurrentRuns": 16,
  "maxArtifactBytesPerRun": 10485760,
  "maxArtifactBytesTotal": 1073741824,
  "maxCompletedRuns": 100,
  "completedArtifactRetentionSeconds": 86400,
  "resourceScanIntervalSeconds": 60,
  "quotaPolicy": "reject-new",
}
```

A filesystem lock and reservation files serialize cross-process slot checks. Startup failures release reservations. Existing running work is reconciled and counted before new work; running work is never killed to satisfy quota.

The generated Node bounded-tee helper duplicates exact combined bytes to the tmux pane while compacting the private tail artifact in place. It never renames an open `tee` inode, preserves `PIPESTATUS[0]`, marks rotation, and keeps the file at or below `maxArtifactBytesPerRun`. Small command, wrapper, manifest, marker, and sentinel files count toward total usage.

`cleanup-preview` reports bounded oldest-first candidates and reclaimable bytes. With `quotaPolicy: "reject-new"`, launches reserve capacity for their eventual completed records and are rejected before `maxCompletedRuns` can be exceeded. Model cleanup observes configured retention. `/tmux-cleanup` can include retained completed runs only after explicit user confirmation. Cleanup rechecks that no owned live window exists and refuses symlinks, paths outside the durable root, live runs, and unowned resources.

## Workspace scope and non-Git fallback

Git always takes precedence. Scope identity is `{ kind, root, hash }`, where `root` is canonicalized through `realpath`; directories with the same basename never collide.

The default remains secure/erroring outside Git:

```jsonc
{ "nonGitScope": "error" }
```

Opt in to a canonical cwd scope:

```jsonc
{
  "nonGitScope": "cwd",
  "cwdTmuxSessionNameTemplate": "pi-cwd-{scopeHash}",
}
```

`tmuxSessionScope` now uses `"workspace"` or `"global"`; `tmuxWindowScope` uses `"pi-session"`, `"workspace"`, or `"all"`. The old window-filter value `"git-root"` is explicitly normalized to `"workspace"` for configuration migration, but old tmux metadata is not adopted.

## Continuation gates, Goal, and status

The package depends only on the generic continuation-gate protocol, not Pi Goal. An awaited model completion queues its producer message before releasing its gate with the committed handoff. Display/next-turn persist first and release with `wake: "none"`. Gates use the protocol's default continuation domain.

Statusline publication remains load-order-independent through `@aliaksei-raketski/pi-statusline-protocol`: `N bg job(s)` is running; `N bg jobs · M awaited` is awaiting. Zero live jobs clears status. Expanded list diagnostics can show adoption, completion policy, output rotation, pending completions, and quota usage without putting raw unbounded output into status.

## Public compiled helpers

Read-only consumers can install `@aliaksei-raketski/pi-tmux-bash-core`:

```ts
import {
  listManagedTmuxWindows,
  parseManagedRunManifest,
  resolveTmuxWorkspaceScope,
  TMUX_BASH_METADATA_KEYS,
} from '@aliaksei-raketski/pi-tmux-bash-core';
```

It ships compiled ESM and declarations and has no Pi extension resource or `ExtensionAPI` dependency. Its public boundary is intentionally read-only: canonical scope resolution with injected hosts, strict manifest/metadata parsing, naming, ownership comparison, bounded discovery with an injected executor, structured attach construction, and stable constants. It does not export launching, gates, completion mutation, input, deletion, or runtime maps.

## Configuration reference

Configuration is JSONC from `$PI_TMUX_BASH_CONFIG`, or `tmux-bash.jsonc` under Pi's global agent directory. Invalid values fail registration rather than weakening safety.

```jsonc
{
  "defaultTimeoutSeconds": 120,
  "maxTimeoutSeconds": 86400,
  "defaultTimeoutAction": "background",
  "defaultWaitForBackgroundCompletion": false,
  "defaultWaitAfterForegroundTimeout": true,
  "defaultCompletionDelivery": "model",

  "tmuxBinary": "tmux",
  "tmuxSessionScope": "workspace",
  "globalTmuxSessionName": "pi-tmux-bash",
  "gitRootTmuxSessionNameTemplate": "pi-{gitHash}",
  "cwdTmuxSessionNameTemplate": "pi-cwd-{scopeHash}",
  "tmuxWindowScope": "pi-session",
  "tmuxWindowNameTemplate": "{name}-{runId}",
  "nonGitScope": "error",

  "adoptionPolicy": "off",
  "adoptionScanTimeoutMs": 5000,
  "adoptPolling": true,
  "durableOutputDir": "/absolute/path/under/pi-agent/tmux-bash",

  "interactiveInputEnabled": false,
  "maxInputBytes": 16384,
  "routeUserBash": false,

  "pollDelivery": "display",
  "defaultPollIntervalSeconds": 30,
  "minimumModelPollIntervalSeconds": 15,
  "maxOutputBytes": 51200,
  "maxSpoolBytes": 10485760,
  "maxArtifactBytesPerRun": 10485760,
  "maxArtifactBytesTotal": 1073741824,
  "maxConcurrentRuns": 16,
  "maxCompletedRuns": 100,
  "completedArtifactRetentionSeconds": 86400,
  "resourceScanIntervalSeconds": 60,
  "quotaPolicy": "reject-new",

  "autoCloseWindowsOnCompletion": true,
  "preserveOutputFiles": false,
  "statusbarEnabled": true,
}
```

`maxSpoolBytes` is accepted as the direct migration alias for `maxArtifactBytesPerRun`; internal execution uses the latter. `enabledTmuxActions` narrows the public enum, and disabled interactive actions are omitted even if mistakenly listed. Omit `enabledTmuxActions` to inherit newly added safe actions; an explicit array remains pinned until you update it. `environmentDenylist` defaults to `TMUX`, `TMUX_PANE`, `PWD`, `OLDPWD`, `SHLVL`, and `_`.

Commands and input run with the user's permissions. Tmux is always invoked with argument arrays. Wrapper paths/environment values are quoted only where Bash syntax is required. Command text and output are bounded and sanitized before model/UI rendering.
