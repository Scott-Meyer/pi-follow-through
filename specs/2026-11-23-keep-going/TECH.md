# Agent-owned goals: technical notes

Target: Pi 1.5.x. `extensions/goal-record.ts` is the goal record: events, the fold, diffs and rendering. It's pure data with no Pi imports. `extensions/goal.ts` wires it into Pi: tools, command, lifecycle hooks.

## Waking

Pi has the primitive: an `agent_before_settle` handler may append entries and return `continue: true`. Pi runs it only after retries, compaction and queued messages are done, and it skips it when the run was aborted (Esc). That covers most of what pi-goal-x built timers, idle polling and stale-ctx guards for.

When the goal is active with `wake: on` and the boundary `outcome` is `completed`, return a `custom_message` draft (the wake) with `continue: true`. The wake is short: goal, why, step progress, next note, wake count and elapsed time, plus how to change, end or wait. After a compaction it carries the whole goal instead. It's persisted at the tail of history, so it's cache-friendly and keeps the goal in context after compaction.

The tools don't terminate the turn, so the agent can keep working or say something to Scott after a change or after ending.

## Errors

A boundary `outcome` of `error` (after Pi's own retries) doesn't continue immediately. `agent_settled` schedules a delayed `pi.sendMessage(wake, { triggerTurn: true, deliverAs: "followUp" })` on a backoff ladder (about 30s, 1m, 2m, 5m, then 5m). The timer:
- is cleared by any user input, `end_goal`, `/goal off`, or session shutdown;
- sends only if `ctx.isIdle() && !ctx.hasPendingMessages()` at fire time;
- catches stale-ctx errors after reload or replacement and gives up quietly.

The wake says the last run ended in an error and includes the error message. Quota and auth errors use the same ladder: the agent and Scott can see what's happening and stop it.

## Timed wakes

`wake_in` sets `sleepUntil` on the goal (an event field). While it's in the future, `agent_before_settle` doesn't continue. One in-memory timer per goal fires at that time. If Pi is idle, it sends the wake with `sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`. If Pi is busy, the run's own settle wakes normally, since the time has passed. A wake mark at or after `sleepUntil` ends the sleep in the fold, so no extra event is needed. The timer is re-armed from the record on restore; if the time already passed, it fires right away. It was verified in RPC mode: the agent ran `date`, slept 20s, was woken, ran `date` again, and ended the goal.

## No-progress fuse

Count tool executions per run. If a wake's run makes no tool calls three times in a row, don't continue. Record `wake: off` (by the extension) with a visible note. The agent can turn it back on. The wake message includes "your last wake used no tools", so the agent can notice before the fuse trips.

## State

The record is event-sourced. Every change is one `goal-event` custom entry (`start`, `change` with the fields it set plus an optional context record and reason, or `end`). Wake counts come from the `details` of wake messages. The current goal is the fold of the events and wake marks on the branch, so:
- history is the event list itself; old versions are recoverable and nothing is rewritten;
- entries stay small and append-only, and verbatim context is stored once rather than copied into every snapshot;
- fork, tree navigation, resume and restart are branch-correct without files or locks.

Changes made at a boundary (the idle fuse) use `custom` drafts; changes everywhere else use `pi.appendEntry`. Timers and per-run counters live in memory only. After a restart nothing is replayed: if waking is on, the next settle wakes.

On restore, if the branch has a compaction entry after the last full view of the goal, the next wake or user run shows the whole goal again.

## Waiting for Scott

`goal({ wake: "after_reply" })` holds waking. The next user-started run (`before_agent_start` with `messageType: "user"`) records `wake: on` (by the extension, reason "the user replied") and adds a short note so the agent knows waking is back on.

## Scott turning it off

`/goal off` records `wake: off` (by the user) and queues `pi.sendMessage(..., { deliverAs: "nextTurn" })`, so the agent learns about it on its next turn. The goal itself stays.

## Subagents

A forked subagent child (`PI_SUBAGENT_CHILD=1` or `PI_SUBAGENT_DEPTH > 0`) ignores inherited snapshots whose `sessionId` differs from its own, so it never runs the parent's goal. It can still set its own.

## Agent-facing text

The tool descriptions, `promptSnippet` and `promptGuidelines` explain what the capability is and why it exists, following the ai-writing skill: context, not rules. They stay stable so the tool schema doesn't churn the prompt cache. Nothing goes in the system prompt dynamically.

## UI

The dashboard is adapted from pi-goal-x's unified dashboard (MIT): the same box frame, colours, layout modes (wide 100+, medium 70+, narrow 50+, minimal), step rows and keys. It's mapped onto our record in `extensions/ui/dashboard.ts` (pure: model in, lines out) and `extensions/ui/widget.ts` (the widget component and keys).
- **Compact**, above the editor while a goal is active: title, `goal: <state> [elapsed · wakes · tokens]`, a steps window with a progress bar, the current step, the next note, and a notebook line (notes and context counts).
- **Expanded** with Ctrl+Shift+T: goal, why, all steps, next, notes, the latest context record, and history newest first. The whole body scrolls with ↑/↓/PgUp/PgDn/Home/End; Esc or Ctrl+Shift+T collapses.
- In compact mode, Ctrl+Shift+↑/↓/PgUp/PgDn/Home/End scroll the steps, but only when they overflow, so the keys are never swallowed for a short list.
- Kept from pi-goal-x because they took them real bugs to learn: the stable-height latch and dock-chrome measurement (stop the terminal jumping or wiping scrollback), ignoring keys while a dialog's editor has focus, and consuming kitty repeat/release events for our keys.
- Not ported: the auditor toggle (Ctrl+Shift+A), the Esc pause chord (Pi's own Esc already stops the run, and nothing wakes until the user speaks), configurable keybindings, and the debug panel.
- The footer status line (`ctx.ui.setStatus`) stays as a one-line summary. `/goal` prints the whole goal; `/goal history` adds every earlier version; `/goal off` stops waking.
- Message renderers for wakes and notes: compact, one line, expandable.

## Testing

Evidence comes from real use. We run Pi with only this extension loaded, `pi -ne -e ./extensions/goal.ts`, against a real model, so the global pi-goal-x isn't loaded. Scenarios: set, wake several times, revise, wait for Scott and resume, stop; Esc stops the immediate wake; `/goal off`; reload or restart mid-goal; compaction mid-goal; the fuse trips. Automated tests only where they state a promise, such as restoring from a branch with entries X giving state Y. None that mirror the implementation.
