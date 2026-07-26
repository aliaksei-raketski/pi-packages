# @aliaksei-raketski/pi-goal

Persistent autonomous goals for Pi with continuation-gate coordination, token accounting, branch-local state, and structured statusline integration.

## Install

```sh
pi install npm:@aliaksei-raketski/pi-goal
```

The package includes the `goal` extension and the `goal-writer` skill.

## Commands

```text
/goal <objective>
/goal --tokens 50k <objective>
/goal
/goal status
/goal waits
/goal pause
/goal resume
/goal continue
/goal clear
/goal statusbar on
/goal statusbar off
/skill:goal-writer
```

`/goal` and `/goal status` show the objective, lifecycle state, token/time usage, statusbar setting, and current continuation gates.

Creating another goal replaces the current non-terminal goal after confirmation in TUI/RPC modes. A non-UI `/goal <objective>` invocation is itself treated as an explicit replacement request. Model-driven replacement is allowed only through an explicit `create_goal` tool call representing user intent.

### Token budgets

Token budgets accept positive values such as `50000`, `50k`, and `1.5m`. Assistant usage is charged after each applicable turn. Reaching the budget changes an active goal to `budget_limited`, disables automatic continuation, and requests one concise progress/blocker summary. Near-budget usage is never proof of completion.

The final turn is still accounted when the model completes the goal during that turn.

### Wait diagnostics

`/goal waits` lists current-session continuation gates with domain, source, gate ID, reason, age, resource details, and lease policy/deadline/staleness. It is diagnostic only: the goal package never persists, releases, renews, or owns another extension's gates.

### Manual continuation

`/goal continue` requests exactly one turn for an active, idle goal. If gates exist, interactive confirmation is required to bypass the currently displayed gates for that turn. Confirmation does not release gates, and newly acquired gates abort delivery. Non-UI modes do not bypass active gates because they cannot obtain confirmation.

## Goal-writer skill

Use `/skill:goal-writer` to draft or review an objective before starting goal mode. The skill treats a goal as a six-part completion contract:

1. outcome;
2. verification surface;
3. constraints;
4. boundaries;
5. iteration policy;
6. blocked stop condition.

It returns a pasteable, evidence-based `/goal` command and avoids invented verification commands or vague completion criteria.

## Model tools

- `create_goal`: creates or replaces a goal only after explicit user intent;
- `get_goal`: reads the active goal, remaining budget, and continuation gates;
- `update_goal`: accepts only `status: "complete"` after a strict evidence audit.

`create_goal` stays active. `get_goal` and `update_goal` are active only while a goal is actively being pursued. The model cannot pause, clear, or budget-limit a goal through `update_goal`.

## Persistence, branching, and reload safety

Goal state is stored in Pi custom session entries and restored from the active branch. `/tree` navigation therefore restores the state belonging to the selected branch. Objectives, lifecycle state, usage, token budget, and the statusbar preference persist; continuation gates do not.

Reloading pauses an active goal rather than silently restarting autonomous work. Use `/goal resume` to continue explicitly. Completed goals are terminal; create a replacement goal to start again.

## Completion semantics

Every activation and continuation message contains the complete objective, current budget, and a deterministic evidence-based completion audit. The objective is wrapped as untrusted user data. The model must map each requirement to direct evidence and call `update_goal({ status: "complete" })` only after all requirements are verified.

Passing tests, manifests, green checks, elapsed effort, and plausible summaries are proxy evidence unless they cover the complete objective.

## Continuation gates

Automatic continuation runs only after Pi emits `agent_settled`, no messages are pending, and the current session has no continuation gates. An active goal can display `waiting` without being paused: the persisted goal remains `active`, while the status is derived from live gate state.

Gate release alone never wakes the model. A producer must commit its wake handoff only after queueing its result message, then release a `producer-message` gate with that handoff ID. After Pi processes that result and settles, the goal loop may continue if all gates are clear. Diagnose-only stale gates remain blocking.

```text
/goal --tokens 50k finish migration and verify tests

# The agent starts finite tests through a gate-aware async producer.
# Goal displays waiting without consuming synthetic turns.
# The producer's completion message wakes the agent.
# After that turn settles, normal goal continuation resumes.
```

## Statusline

The extension publishes the stable `goal` status through both Pi's built-in footer API and `@aliaksei-raketski/pi-statusline-protocol`. The custom statusline package is optional and load order does not matter.

| State            | Example              | Fallback color |
| ---------------- | -------------------- | -------------- |
| `active`         | `goal 12.3K/50K`     | accent         |
| `waiting`        | `goal waiting (2)`   | warning        |
| `paused`         | `goal paused`        | muted          |
| `complete`       | `goal achieved`      | success        |
| `budget_limited` | `goal unmet 50K/50K` | error          |

`/goal statusbar off` clears both fallback and structured status publication. Goal-event cards remain visible in the transcript.

## License and provenance

MIT. The completion-audit and goal-writing contracts adapt ideas from the MIT-licensed `aliaksei-raketski/pi-goal` reference implementation; see `NOTICE.md`.
