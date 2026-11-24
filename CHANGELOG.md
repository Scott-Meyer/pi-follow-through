# Changelog

## [0.1.0] - 2026-11-24

First release.

- `goal` and `end_goal`: the agent starts, revises and ends its own goals. Nothing needs approval.
- Waking: `on` (woken each time it finishes), `after_reply`, `off`, and `wake_in` for timed wakes such as waiting on CI.
- A notebook that survives compaction: steps, notes edited like a file, accumulating context records, and a next note. The whole goal is shown again after a compaction.
- History of every change, with an optional reason for the whole call and per step or edit.
- A dashboard above the editor (`Ctrl+Shift+T` to expand), adapted from pi-goal-x (MIT).
