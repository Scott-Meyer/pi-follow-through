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

## 2026-11-24: waking, for real

- Scott: "So I notice that you chat complted, and didn't have a question for me, why didn't your goal wake you?" The session log showed every stop came right after I set `after_reply` myself: I'd treated one pending input as blocking all work. The guidance now says to ask and keep going on what doesn't depend on the answer. Then I left waking on, ended the turn, and the goal woke me (wake 1); that wake is what wrote this entry.
- Timed wakes (`wake_in`) were built and verified in RPC mode. Scott called them "that weird timer thing", so whether they stay is open.
- Found while dogfooding: `step_updates` used to apply after `add_steps` in the same call, so step numbers shifted under the agent. Updates now apply first; insert positions and update numbers both refer to the list as the agent sees it.

## 2026-11-24: named pi-follow-through; denser dashboard

- Scott on the dashboard, with a screenshot: "I cannot possibly think of anything that would improve it, thats why I said fine because its not great but I cannot think of anything better". The screenshot showed 11 rows: 4 rows of finished steps, a Current row repeating the ▸ step, a progress bar stranded at the far right, a footer status repeating the box, and "waiting for you" while the agent was working. Made the compact view denser: a 3-row window focused on the current step with "↑ N done" above it, counts in the Steps rule, notebook counts in the bottom border, no Current row unless it's scrolled out of view, no footer status, and "working" wins over the wake label.
- Scott picked pi-follow-through over pi-keep-going ("okay"), pi-heading, pi-own-goal and pi-onward. The repo moved to ~/git/pi-follow-through. The extension's own actor in history is now "extension"; records written as "keep-going" still read correctly.

## 2026-11-24: pre-release review

An independent reviewer (fresh context) read the code against Pi's runtime source before release. These fixes went in:
- Session files grew quadratically: every tool result carried the whole goal in `details`, and every notes append stored the full notes. Now `details` is a ~100-byte summary and notes edits and appends are stored as ops. A notes edit plus an append was replayed correctly in a new process.
- `/goal off` could be undone silently: the notice waited for the next turn, and `wake_in` turned waking back on. The notice now steers into a running turn, and `wake_in` doesn't override a user's off; the reply says so. Verified in a real run.
- A timed wake fired after Esc. Esc now clears the sleep, with a history entry. Verified in RPC mode with `abort`: no wake followed.
- Waking carried on past a run a tool had ended deliberately (`terminate`); it no longer does.
- A step reorder, or a change to one of two steps with the same text, was dropped as "no change". Diffs are now positional when the steps line up, and "steps reordered" otherwise.
- Overdue sleeps woke the agent on /tree or a fork. Catch-up wakes now happen only after startup, resume or reload.
- Error retries fired during a sleep; sleeps over about 24.8 days misfired (setTimeout's limit); errors retried forever. Fixed: retries respect sleep, long sleeps re-arm in steps, and there's an 8-error fuse.
- "20 minutes" style units failed (regex alternation order). Fixed.
- The idle fuse counted goal bookkeeping as progress, and the wake text now points at `wake_in` for outside waits.
- The full view after compaction had no size cap; context there is now capped at 40k chars, newest first, and goal() still shows everything.
- Widget: growth no longer cuts off the bottom border; newlines in model text are flattened; Esc in the expanded view also stops a running agent.
- Descriptions now say that starting a goal turns waking on unless `wake: "off"`, that there's one goal at a time, and how step numbering works within a call.

## 2026-11-24: no more waking off

- Scott: "Ais keep making goals then chat completing, I don't like that they can have a goal with waking off". The flux session (gpt-6.2-sol) showed it: goals started with `wake: "off"` "to record acceptance criteria", flipped back to off "to wait for colleague message", then idle until Scott asked "what am I supposed to do next?".
- Removed `off`. A goal always wakes until `end_goal`. `after_reply` resumes on any incoming message (user or another session), since the flux agent was waiting on a colleague. The idle and error fuses pause (`after_reply`) instead of turning waking off. `/goal off` is now a user pause that only the user's next message resumes; the agent is told and can end the goal if that's what Scott meant. Older records with `off` load as `after_reply`.
- Verified in RPC mode with a helper that delivers a custom message the way another session would. (1) An agent waiting with after_reply was resumed by the message, recorded it and ended. (2) `/goal off` was steered into a running count, the agent stopped, the peer message got "pong" but no wake, and the user's next message resumed it.

## 2026-11-24: FlightDeck prompts for a waiting goal

- Scott: "can you work with flightdeck to have a goal changing to waiting for the user prompt me just like a question promps me?" FlightDeck's bridge only marked a tab waiting for a blocking ask_user_question, so a goal that paused looked like an ordinary Stop.
- Agreed with flightdeck:flightdeck: this extension emits `pi-follow-through:goal:v1` (waiting / resumed / ended / cleared), and FlightDeck maps waiting to its existing waiting state. Verified the emitter with a listener extension in RPC mode: waiting arrived on settle with the agent's reason, resumed arrived on the user's reply, and `/goal off` emitted nothing.
