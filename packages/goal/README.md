# @aliaksei-raketski/pi-goal

Persistent autonomous goals for Pi with combined token/wall-clock budgets, a revisioned evidence ledger, conservative no-progress protection, restart policies, continuation-gate coordination, branch-local state, and structured statusline integration.

## Install

```sh
pi install npm:@aliaksei-raketski/pi-goal
```

The package includes the `goal` extension and the `goal-writer` skill.

## Commands

```text
/goal <objective>
/goal --tokens 50k <objective>
/goal --time 30m <objective>
/goal --tokens 50k --time 1.5h <objective>
/goal status
/goal waits
/goal evidence
/goal evidence reset
/goal pause
/goal resume
/goal continue
/goal clear
/goal restart pause
/goal restart restore-idle
/goal restart resume
/goal no-progress on
/goal no-progress off
/goal no-progress reset
/goal statusbar on
/goal statusbar off
/skill:goal-writer
```

`/goal` and `/goal status` show the objective, lifecycle state, token usage, active wall time, distinct agent turn-processing time, evidence summary, no-progress diagnostics, restart policy, statusbar setting, and current continuation gates.

Creating another goal replaces the current non-terminal goal after confirmation in TUI/RPC modes. A non-UI `/goal <objective>` invocation is itself an explicit replacement request. Model-driven replacement is allowed only through an explicit `create_goal` call representing user intent.

## Token and wall-clock budgets

Token budgets accept positive values such as `50000`, `50k`, and `1.5m`. Time budgets accept a positive finite number followed by `s`, `m`, `h`, or `d`; values are rounded to whole seconds and limited to one year. Flags may appear in either order and may use `--option=value` syntax.

```text
/goal --time 45s verify the focused regression
/goal --time 30m --tokens 50k finish migration and verify tests
/goal --tokens=100000 --time=1.5h complete the release audit
```

Wall time means real elapsed time while the goal lifecycle is `active`:

- active work and continuation-gate waits accrue;
- paused, complete, and `budget_limited` intervals do not accrue;
- clean shutdown checkpoints and closes the active interval;
- process downtime does not accrue after restart;
- after an unclean exit, the uncheckpointed tail since the last normal persistence point can be conservatively undercounted, but the offline gap is never charged;
- clock rollback is clamped to zero.

Normal active persistence, especially `turn_end`, checkpoints and immediately restarts the interval. One deadline timer enforces the remaining wall budget. Reaching token, wall-time, or both limits changes the goal to `budget_limited` and prevents further autonomous continuation.

A deadline never releases or bypasses continuation gates. If Pi is idle and unblocked, it queues one concise budget summary. Otherwise it persists a pending next-turn instruction and delivers it only through a natural, model-visible turn. Final-turn token accounting still applies when a goal completes during that turn.

## Evidence ledger and completion

Every new goal receives an empty, branch-local evidence ledger. The model uses `update_goal_evidence` with an `expectedRevision` to:

1. `initialize_requirements` with stable IDs;
2. `upsert_requirement` when the checklist changes;
3. `add_evidence` using a concise kind, reference, and claim;
4. `set_requirement_status` to `pending`, `in_progress`, `verified`, or `blocked`;
5. `remove_evidence` when a claim is invalidated.

The ledger is bounded to 50 requirements and 20 evidence items per requirement. It stores concise references and claims, never full command output, prompts, assistant text, file contents, or logs. Stale revisions, duplicate/unknown IDs, cross-goal updates, verified requirements without evidence, and blocked requirements without a blocker are rejected.

`update_goal` continues to accept only `{ status: "complete" }`, but completion is rejected unless:

- the ledger exists and is non-empty;
- it belongs to the current goal;
- every requirement is `verified`;
- every requirement has at least one evidence item;
- no pending, in-progress, or blocked item remains.

Ledger references are claims the model must inspect. The deterministic precondition supplements rather than replaces the strict prompt-to-artifact audit. Green tests and manifests remain proxy evidence unless they directly cover a requirement.

Use `/goal evidence` for a readable checklist. `/goal evidence reset` requires interactive confirmation and exists for user-owned recovery; the model tool cannot reset the ledger.

## Conservative no-progress detection

No-progress detection is an opt-in circuit breaker and defaults to off:

```text
/goal no-progress on
/goal no-progress off
/goal no-progress reset
```

Only turns initiated by automatic synthetic goal continuation are observed. User turns, explicit `/goal continue`, startup/restart turns, `/goal resume`, and producer/tmux completion turns do not advance the streak.

The detector stores a bounded four-observation window containing only deterministic 64-bit summary fingerprints, summary token counts, hashed ordered tool-name/success-error patterns, the evidence revision, timestamps, and counters. It stores no assistant text, prompts, tool arguments, tool output, or file content. An evidence revision change, materially different summary, or changed tool pattern resets the streak. Three consecutive conservative repeated comparisons pause the goal with `pauseReason: no_progress`; the detector never completes or clears a goal and never mutates gates.

Recovery requires `/goal resume`, which resets the streak while retaining bounded history for diagnostics. `/goal status` reports enablement and streak without exposing assistant content.

## Restart policy

The branch-local restart policy controls only restoration of a persisted active goal into a new extension runtime on startup or reload:

| Policy         | Behavior                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pause`        | Default. Restore paused with `pauseReason: reload`; require `/goal resume`.                                                                                                    |
| `restore-idle` | Restore active and restart the wall clock, but send no startup turn.                                                                                                           |
| `resume`       | Restore active, request gate snapshots, and queue at most one guarded restart continuation when Pi is idle, has no pending messages, and the default gate domain is unblocked. |

Normal `/goal resume`, new/fork/session-switch lifecycle paths, and `/tree` navigation use their explicit lifecycle behavior and never reuse old session-bound contexts. `/tree` restores the policy, ledger, detector state, settings, and goal state from the selected branch.

A gated `resume` policy remains active/waiting and never bypasses the gate. For a valid `wake: none` last-gate transition, the goal runtime uses the continuation-gate protocol's single-winner auto-resume claim. Producer-message handoffs wake Pi through the producer result and are not duplicated.

## Wait diagnostics and manual continuation

`/goal waits` lists current-session gates in the default `autonomous-continuation` domain with source, gate ID, reason, age, resource details, and lease policy/deadline/staleness. It is diagnostic only: the goal package never persists, releases, renews, or owns another extension's gates.

`/goal continue` requests exactly one turn for an active, idle goal. If gates exist, interactive confirmation is required to bypass the displayed acquisitions for that turn. Confirmation does not release gates, and new or reacquired gates abort delivery. Non-UI modes cannot bypass active gates.

## Goal-writer skill

Use `/skill:goal-writer` to draft or review a six-part completion contract:

1. outcome;
2. verification surface;
3. constraints;
4. boundaries;
5. iteration policy;
6. blocked stop condition.

The skill returns one pasteable `/goal` command, includes token and/or wall-time flags only when requested, and plans an evidence-ledger workflow without inventing verification commands.

## Model tools

- `create_goal`: creates or replaces a goal after explicit user intent; optional `tokenBudget` and `timeBudgetSeconds` can be combined;
- `get_goal`: returns the full bounded ledger, summary counts, progress diagnostics, settings, remaining budgets, and gates;
- `update_goal_evidence`: performs strict revision-checked ledger mutations;
- `update_goal`: accepts only `status: "complete"` after ledger-backed verification.

`create_goal` stays active. The other three tools are active only while the goal status is `active`. Paused, complete, cleared, and budget-limited goals cannot be mutated by model goal tools.

## Persistence and structural compatibility

Goal state is stored in Pi custom entries and restored from the active branch. The package uses one current, unversioned state shape; it does not emit or branch on goal-state versions. Historical entries missing enhancement fields receive structural defaults:

- no wall-time budget;
- zero completed active wall time;
- no running interval charged across downtime;
- no ledger or detector history;
- restart policy `pause`;
- no-progress detection off;
- no pending budget summary.

Malformed nested ledger or progress data is dropped without discarding an otherwise valid goal. All strings, counters, timestamps, and arrays are bounded and validated.

## Continuation gates

Automatic continuation runs only after `agent_settled`, when no messages are pending and the default gate domain is unblocked. An active goal can display `waiting` while wall time continues to accrue.

A producer should commit its wake handoff only after queueing its result message, then release a `producer-message` gate with that handoff ID. After the producer result turn settles, normal goal continuation may continue. Diagnose-only stale gates remain blocking.

## Statusline

The extension publishes the stable `goal` status through Pi's built-in footer API and `@aliaksei-raketski/pi-statusline-protocol`. Token budget appears first; compact active-wall elapsed or remaining time follows when available.

| State            | Example                                 | Fallback color |
| ---------------- | --------------------------------------- | -------------- |
| `active`         | `goal 12.3K/50K · 24m left`             | accent         |
| `waiting`        | `goal waiting (2) 12.3K/50K · 24m left` | warning        |
| `paused`         | `goal paused`                           | muted          |
| no progress      | `goal paused (no progress)`             | muted          |
| `complete`       | `goal achieved`                         | success        |
| `budget_limited` | `goal unmet 50K/50K · 0s left`          | error          |

`/goal statusbar off` clears fallback and structured status publication. Goal-event cards remain visible in the transcript.

## License and provenance

MIT. The completion-audit and goal-writing contracts adapt ideas from the MIT-licensed `aliaksei-raketski/pi-goal` reference implementation; see `NOTICE.md`.
