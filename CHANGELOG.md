# Changelog

## [0.2.0] - 2026-11-24

- A goal always means waking now. `wake: "off"` is gone, so the agent can't park a goal and stop; it ends goals with `end_goal`. `after_reply` resumes when any message arrives, from you or another session. Older goals saved with waking off load as paused.
- `/goal off` pauses waking until you next message the agent. The agent is told, and messages from other sessions don't resume it.
- The idle and error safety stops pause instead of turning waking off. Error retries stop after 8 failures in a row.
- Esc cancels a pending timed wake. Waking no longer carries on past a run that a tool ended on purpose. Timed and retry wakes wait while you're typing.
- Session files stay small: tool results no longer carry the whole goal, and notes edits are stored as edits.
- Step history handles reorders, repeated step text, and rewording alongside additions. `wake_in` accepts "20 minutes" style units.
- The dashboard is denser, and the footer status line is gone because the dashboard already shows it.

## [0.1.0] - 2026-11-24

First release.

- `goal` and `end_goal`: the agent starts, revises and ends its own goals. Nothing needs approval.
- Waking: `on` (woken each time it finishes), `after_reply`, `off`, and `wake_in` for timed wakes such as waiting on CI.
- A notebook that survives compaction: steps, notes edited like a file, accumulating context records, and a next note. The whole goal is shown again after a compaction.
- History of every change, with an optional reason for the whole call and per step or edit.
- A dashboard above the editor (`Ctrl+Shift+T` to expand), adapted from pi-goal-x (MIT).
