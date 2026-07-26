---
name: goal-writer
description: Drafts and reviews strong persistent /goal objectives for Pi. Use when the user asks to write, improve, audit, or compare a long-running goal with explicit outcomes, evidence, constraints, boundaries, iteration policy, and blocked stop conditions.
license: MIT
---

# Goal Writer

## Purpose

Write `/goal` objectives that are safe for persistent autonomous work. A goal
is a completion contract, not merely a larger prompt. It must define the
outcome, evidence, constraints, boundaries, iteration policy, and blocked stop
condition.

## Six-part objective contract

Every goal must cover:

1. **Outcome** — the state that must be true when work is done.
2. **Verification surface** — concrete tests, commands, artifacts, diffs,
   screenshots, logs, reports, benchmarks, or other auditable checks.
3. **Constraints** — behavior, compatibility, quality, or assets that must not
   regress.
4. **Boundaries** — allowed and forbidden files, systems, tools, data,
   permissions, or approaches.
5. **Iteration policy** — how to inspect results and choose the next
   highest-value action after each attempt.
6. **Blocked stop condition** — when to stop with evidence, attempted paths,
   the exact blocker, remaining uncertainty, and the input needed to continue.

Never return vague goals such as “improve this,” “finish the feature,” or “make
it work.” Convert rough intent into auditable completion criteria.

## Workflow

1. Default to the packaged Pi `/goal` command unless the user requests another
   harness.
2. Inspect relevant files, issues, tests, scripts, plans, benchmarks, or
   external sources before naming verification commands. Do not invent
   commands or evidence.
3. Ask at most three clarifying questions only when an answer materially
   changes the completion contract. Otherwise state safe assumptions.
4. Draft one pasteable `/goal` command. Include `--tokens <budget>` and/or
   `--time <duration>` only when the user requests those budgets. Wall-clock
   durations use `s`, `m`, `h`, or `d` suffixes.
5. Follow it with a short checklist showing how the result covers all six
   parts.
6. For high-risk or ambiguous work, offer a safer narrow objective and a
   broader discovery-oriented objective, then recommend one.
7. When reviewing a goal, identify missing parts, unsupported completion
   claims, proxy-only evidence, unbounded scope, and weak stop language before
   supplying the revision.

## Template

<!-- markdownlint-disable MD013 -->

```text
/goal <desired end state>, verified by <specific direct evidence>, while preserving <constraints>. Work within <allowed scope/tools> and avoid <forbidden scope/approaches>. Between iterations, <inspect results, re-check requirements, and choose the next action>. If blocked or no defensible path remains, stop with <confirmed evidence, attempted paths, exact blocker, remaining uncertainty, and next input needed>.
```

<!-- markdownlint-enable MD013 -->

With user-requested budgets:

```text
/goal --tokens 50k <same six-part completion contract>
/goal --time 30m <same six-part completion contract>
/goal --tokens 50k --time 1.5h <same six-part completion contract>
```

Time budgets measure real elapsed time only while the goal is active. Gate
waits count; paused, terminal, budget-limited, and process-offline time do not.

## Writing standards

- Make the objective self-contained enough to survive context compaction and
  continuation turns.
- Name exact checks only after confirming they exist. If unknown, instruct the
  agent to inspect project guidance and scripts first.
- Require inspection of real artifacts before completion. Passing tests,
  manifests, and green checks are proxy evidence unless they directly cover
  every objective requirement.
- Plan an evidence-ledger checklist: initialize stable requirement IDs, inspect
  the current revision, add concise evidence references and claims, and mark a
  requirement verified only after direct inspection. Completion is rejected
  until every ledger requirement is verified with evidence.
- Separate direct evidence, proxy evidence, blocked claims, and remaining
  uncertainty.
- Name regressions and forbidden approaches when they matter.
- Permit iteration without inviting unlimited drift.
- Use concrete stop language: “If blocked, stop with the exact blocker and
  what would unlock progress.”
- Ensure the result is pasteable as one `/goal` command.

## Review checklist

Before returning a goal, verify:

- Can the agent determine exactly when the outcome is achieved?
- Can the user independently audit every completion claim?
- Are constraints and forbidden approaches explicit?
- Are allowed scope and permissions clear?
- Does the iteration policy prioritize the next defensible action?
- Does the blocked condition cover missing tests, credentials, network, data,
  environment, and product decisions where relevant?
- Does the objective avoid treating proxy evidence as direct proof?
- Is the command self-contained and pasteable?
