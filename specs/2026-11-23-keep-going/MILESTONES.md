# Milestones

## 2026-11-23: from pi-goal-x to agent-owned goals

- Scott forked pi-goal-x as a starting point but wants a new extension built on the opposite idea: give the AI the ability and the understanding, and let it decide. The pi-goal-x clone at ~/git/pi-goal stays as a reference only.
- A scout read pi-goal-x's history for the mechanics of waking (notes in /tmp/pi-goal-wake-lessons.md at the time). Pi 1.5's `agent_before_settle` with `continue: true` replaces most of its timer, polling and stale-ctx machinery: Pi already skips it on Esc and runs queued messages first. We kept the lessons: no wake after errors except a slow backoff, a no-progress fuse, subagents don't inherit goals, branch-scoped session entries, and small persisted wakes.
- First prototype (`keep_going` / `stop_going`, state snapshots). Real runs with gemini-4-hydrogen and only this extension loaded: the 1-2-3 counter woke twice and stopped itself as done; the wait-for-reply path asked for a colour and resumed when given "Teal"; the fuse tripped after three tool-less wakes.
- Scott asked for both uses in one: quick self-wake and a long-work notebook (steps, notes, a changelog with reasons), descriptions that carry his thinking, and a nudge to record verbatim conversations ("whenever I forced it to put huge verbatim discussions in the goals it worked SOOOOO much better"). Reshaped into `goal` / `end_goal` with an event-sourced record; the names no longer need to avoid pi-goal-x, which will be removed.
- Real runs on the new shape:
  - Palette: the agent read a conversation file, set a goal with steps and the conversation verbatim in context, found a loader constraint that contradicted "exactly 5 colors" (the conversation said "the 5 is just a guess"), made 4, recorded why, worked one step per wake, and ended done.
  - A short five-file task didn't use a goal at all, which is right for one turn.
  - Notebook (waking off), then about 30k tokens of unrelated reading, then a compaction in a separate process, then a new process: the whole goal was re-shown on the next user message, and the agent quoted "Budget is around 80 bucks." verbatim.
- `/compact` doesn't run in print mode; real-use checks use a throwaway helper extension that calls `ctx.compact()`.

## 2026-11-23: dogfooding, dashboard, edit-style notes

- Scott reloaded his Pi with this extension in place of pi-goal-x, and I used a goal for the extension's own development. Friction: adding a step meant resending the list, adding a note meant rewriting all notes, steps couldn't be reworded, and the full history re-dumped everything. Added add_steps, step rewording, add_notes, quieter replies, and a history that shows replaced values.
- Scott: "I feel like we can just straight up steel the other goal's ui/keybindings tbh.. .since its mit lol". Ported pi-goal-x's dashboard: the frame, colours, layout modes, step rows, the stable-height latch, dock measurement, and the Ctrl+Shift+T / scroll keys. It's mapped onto our record in extensions/ui/. The auditor toggle and Esc-pause chord weren't ported.
- Scott: "I wonder if add notes should instead be designed after the file edit tool where you can add to the end or make targeted edits or edditions and lets make sure all add/edit tools have a section for a note about why", and "just like extra inputs you can use can be nice right? extra info =D". Added notes_edits (old_text/new_text, unique match, all-or-nothing like the edit tool), add_steps with `after`, and an optional `why` on every step item, step update and notes edit, shown per line in the history. Any problem in a call now changes nothing and explains itself.
- Real run (gemini-4-hydrogen): one call changed the budget line with a why, inserted "check weather" after step 1 with a why, and marked a step done with a why. A bad old_text was rejected with nothing changed, and the history showed each why on its own line.
