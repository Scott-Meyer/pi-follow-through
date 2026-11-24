# pi-follow-through

Goals for Pi that belong to the agent.

An agent stops when it finishes a turn, and on long work it loses detail every time the conversation is compacted. This extension lets the agent handle both itself:

- **Wake me each time I finish, until I stop it.** The agent sets this up, so it knows why it's being woken. It can turn waking off when it's no longer the right thing.
- **A notebook that survives compaction.** It holds what the agent is after and why, optional steps, notes, and verbatim excerpts of the conversations behind it.

A goal always means waking: the agent is woken each time it finishes until it ends the goal. It can pause while it waits on someone, or sleep while it waits on something outside.

Nothing needs approval and nothing grades the result. The agent can start a goal because you asked for one or because it judged it shouldn't stop yet. It changes the goal as it learns: if the rig should have 177 bones, not 178, it changes that and says why. It ends the goal as done, or as dropped when that's the right call. If you want it to work differently, tell the agent.

## What the agent gets

Two tools: `goal` and `end_goal`. Everything in a goal except the goal sentence itself is optional:

| | |
|---|---|
| `goal`, `why` | What it's after and why it matters |
| `steps`, `add_steps`, `step_updates` | A checklist: send the whole list, insert steps, or tick and reword single steps |
| `notes`, `add_notes`, `notes_edits` | A notebook edited like a file: replace, append, or targeted edits |
| `context` | Records that only accumulate: conversation excerpts, how decisions came about |
| `next` | A note to its next turn |
| `wake` | `on` (the default) or `after_reply`: pause until a message arrives from you or another session |
| `wake_in` | Don't wake me before `10m`, `2h`, or a given time |

Every change goes in a history with an optional reason: `change` for the whole call, or `why` on any single step or edit. After a compaction, the agent is shown the whole goal again.

## What you get

A dashboard above the editor while a goal is active. `Ctrl+Shift+T` expands it to show the steps, notes, the latest context and the history with reasons. In the expanded view, arrow keys and PgUp/PgDn scroll and Esc closes it. In the compact view, `Ctrl+Shift+↑/↓` scroll long step lists.

- `/goal` shows the whole goal.
- `/goal history` adds every earlier version.
- `/goal off` pauses waking until you next message the agent. The agent is told, and messages from other sessions don't resume it.

## Install

Add the package path to `packages` in `~/.pi/agent/settings.json`. Don't run it alongside `pi-goal-x`.

## Credit

The dashboard and its keys are adapted from [pi-goal-x](https://github.com/tmonk/pi-goal-x) (MIT). This is a different idea, though: pi-goal-x keeps the agent inside a goal it can't create, revise or end on its own.

## License

MIT
