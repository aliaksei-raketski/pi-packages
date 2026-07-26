# @aliaksei-raketski/pi-tmux-bash

A first-party Pi extension that replaces the model-facing `bash` tool with tmux-backed command execution. Foreground commands retain normal shell-tool behavior, while commands that outlive the foreground timeout continue in managed tmux windows and report completion later.

## Prerequisite

Install `tmux` and ensure it is available on `PATH`, or set `tmuxBinary` to an absolute path in configuration.

## Install

```sh
pi install npm:@aliaksei-raketski/pi-tmux-bash
```

The package registers two model-facing tools:

- `bash` — runs every model command in an extension-owned tmux window;
- `tmux` — lists, inspects, polls, awaits, unawaits, or kills only managed windows in scope.

Pi's user `!` and `!!` commands are intentionally unchanged.

## Usage

Foreground execution:

```json
{ "command": "pnpm nx test my-project" }
```

Explicit background execution:

```json
{ "command": "pnpm nx serve app", "background": true, "waitForCompletion": false }
```

Finite asynchronous work that should suspend synthetic goal continuation:

```json
{
  "command": "pnpm nx test app",
  "background": true,
  "waitForCompletion": true
}
```

> **Use `waitForCompletion` for required finite asynchronous work, even while
> other productive work can continue. Do not use it for persistent servers,
> watchers, or REPLs.**

Background completion is delivered automatically as a follow-up model message while the same Pi runtime remains active. The message is queued before the continuation gate is released.

## Foreground timeout behavior

The default foreground timeout is 120 seconds. `timeoutAction` controls what happens at the limit:

- `background` (default) leaves the command running and returns its stable window ID;
- `kill` kills the owned window and reports a tool error.

An unexpected foreground-to-background transition is awaited by default because the original call expressed foreground intent. Set `waitForCompletion: false` to opt out. Explicit background calls are not awaited by default.

Cancellation kills the managed window. Non-zero foreground exits throw a tool error containing bounded output and the exit code.

## `tmux` actions

All target actions require stable IDs such as `@123`; numeric window indexes are rejected.

| Action       | Behavior                                                               |
| ------------ | ---------------------------------------------------------------------- |
| `list`       | List managed windows in configured scope.                              |
| `peek`       | Read a bounded tail from the output artifact.                          |
| `kill`       | Kill only the matching managed window and release its gate.            |
| `poll`       | Start periodic progress delivery.                                      |
| `unpoll`     | Stop polling without changing wait state.                              |
| `list-polls` | List active pollers.                                                   |
| `await`      | Idempotently acquire a continuation gate for a running finite command. |
| `unawait`    | Release the gate without killing the command.                          |

Polling and waiting are independent. Polls provide progress; continuation gates suppress only synthetic idle continuation. A model-delivered poll may wake the agent while a gate remains active.

## Attaching

Every background result includes an attach hint. Outside tmux it resembles:

```sh
tmux attach-session -t pi-0123456789 \; select-window -t @123
```

Inside tmux, use:

```sh
tmux select-window -t @123
```

Window titles are presentation only. Ownership is enforced with tmux user-option metadata and the runtime registry, never inferred from titles or indexes.

## Output and truncation

Each command receives a private per-session artifact directory (mode `0700` where supported):

- `<runId>.command` — exact command body while the command is running;
- `<runId>.sh` — generated wrapper while the command is running;
- `<runId>.out` — combined stdout/stderr, bounded by `maxSpoolBytes`;
- `<runId>.exit` — atomically published exit status.

Model-visible output is tail-truncated by independent byte and context-line limits. Compact and expanded tool cards have separate presentation limits, so reducing UI output does not discard model context. Truncation notices identify the full output path. Unless `preserveOutputFiles` is enabled, wrappers containing environment values are deleted as soon as the command exits. Shutdown schedules detached cleanup for a live command's directory after its final process exits. Command output and tmux metadata are treated as untrusted text.

## Scope and sessions

By default, tmux sessions are derived from the Git root, while model actions are restricted to commands created by the current Pi session. Commands outside a Git worktree return a clear error. The tmux window ID (`#{window_id}`) is stable even when window indexes change.

Completed commands can close their tmux window automatically while their output artifact remains available for the lifetime of the Pi session.

## Continuation gates and Pi Goal

This package communicates through `@aliaksei-raketski/pi-continuation-gate-protocol`; it does not import or depend on the goal package. When used with `@aliaksei-raketski/pi-goal`:

1. a finite background command acquires a generic gate;
2. goal continuation remains idle while the gate exists;
3. tmux completion is queued as a follow-up;
4. the gate is released with `wake: "producer-message"`;
5. goal continuation can resume after the completion turn settles.

Every finite background command whose result is required—including tests, builds, and subagents—should use `waitForCompletion: true`, regardless of its duration or whether other productive work can continue concurrently. Continuation gates do not block the current agent run; they suppress only synthetic idle continuation.

Use `waitForCompletion: false` only for processes intentionally expected to remain alive indefinitely, such as servers, watchers, and REPLs. If required finite work was started without a gate, acquire one with the `tmux` tool's `await` action before becoming idle.

The extension exposes the configured `defaultWaitForBackgroundCompletion` value in both its model prompt guidance and the `waitForCompletion` tool-schema description. The same guidance explicitly distinguishes required finite work from persistent processes and warns that slow or long-running does not mean persistent.

## Statusline integration

The extension publishes `tmux-bash` status through `@aliaksei-raketski/pi-statusline-protocol` and also uses Pi's built-in footer status fallback:

- `1 bg job` / `2 bg jobs` uses the `running` state and `accent` fallback color;
- `2 bg jobs · 1 awaited` uses the `awaiting` state and `warning` fallback color.

Only active managed background commands are counted; completed commands and idle tmux shells are not. Zero jobs clears both fallback and structured status. A snapshot provider makes extension load order irrelevant. Set `statusbarEnabled` to `false` to disable both forms.

## Configuration

The extension loads JSONC from `$PI_TMUX_BASH_CONFIG` when set, otherwise from `tmux-bash.jsonc` in Pi's global agent directory. Invalid configuration fails extension registration instead of silently weakening scope or security.

Common options:

```jsonc
{
  "defaultTimeoutSeconds": 120,
  "maxTimeoutSeconds": 86400,
  "defaultTimeoutAction": "background",
  "defaultWaitForBackgroundCompletion": false,
  "defaultWaitAfterForegroundTimeout": true,
  "tmuxBinary": "tmux",
  "tmuxSessionScope": "git-root",
  "tmuxWindowScope": "pi-session",
  "autoCloseWindowsOnCompletion": true,
  "pollDelivery": "display",
  "defaultPollIntervalSeconds": 30,
  "minimumModelPollIntervalSeconds": 15,
  "maxOutputBytes": 51200,
  "maxSpoolBytes": 10485760,
  "foregroundContextLines": 2000,
  "completionContextLines": 20,
  "pollContextLines": 80,
  "peekContextLines": 200,
  "completedCompactDisplayLines": 5,
  "completedExpandedDisplayLines": 20,
  "completionDeliveryMaxAttempts": 5,
  "completionDeliveryRetryBaseMs": 250,
  "preserveOutputFiles": false,
  "statusbarEnabled": true,
}
```

`maxOutputBytes` bounds each read into model context, while `maxSpoolBytes` is the hard on-disk quota for a command log. The four context-line settings independently limit foreground, completion, poll, and peek results. The compact and expanded display settings affect only completed tool cards. Completion delivery uses bounded exponential backoff controlled by the attempt and base-delay settings.

`enabledTmuxActions` can narrow the public `tmux` schema. `environmentDenylist` excludes sensitive/process-specific variables from generated wrappers; `TMUX`, `TMUX_PANE`, `PWD`, `OLDPWD`, `SHLVL`, and `_` are denied by default.

## Shutdown and security boundary

Tmux processes can continue after Pi exits, but baseline v1 does not adopt them after restart and cannot promise post-exit completion messages. Shutdown removes watchers, timers, gates, and status providers; it does not kill preserved background tmux windows. Unless output preservation is configured, a detached cleanup helper removes artifacts after surviving commands exit.

Commands run with the user's permissions. The extension uses argument-array subprocess invocation for tmux, shell-quotes wrapper paths and environment values, restricts actions to managed stable IDs, and never provides arbitrary tmux target access.
