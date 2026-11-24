# Goals the agent owns

## Why

A Pi agent stops when it finishes a turn, and on long work it loses detail every time the conversation is compacted. pi-goal-x handles both by putting the agent inside a goal it can't create on its own, can't revise, and can't end without an auditor's approval. The agent is managed, not trusted, and when the work changes shape it fights the goal instead of using it.

This extension gives the agent the abilities directly:
- **Wake me each time I finish, until I stop it.** The agent sets this up itself, so it knows why it's being woken. It can turn it off when it stops being the right thing.
- **A notebook that survives compaction.** It holds what the agent is after and why, optional steps, notes, and the record of how things came about.

It's one goal with both uses, and every part is optional. A quick self-wake is a goal with only a sentence in it. A long project is a goal with steps, notes and verbatim conversation. When Scott asks for a goal, the agent makes one and gets the same effect a goal plugin gives, except the agent was part of setting it up. If Scott wants it to work differently, he tells the agent, not the software.

## Principles

- **The agent's judgment, not a harness.** Nothing needs approval, and nothing grades the outcome. Dropping a goal that turned out wrong is a good outcome.
- **Details are plans, not contracts.** "178 bones" was a guess; changing it to 177 with a reason is good judgment.
- **How you got here matters more than where you landed.** Scott found that goals worked far better when the AI kept real, often verbatim, records of the conversations behind them. When the exact requirement turns out wrong deep in the work, the reasoning behind it is what lets the agent adapt. The tools nudge toward recording that.
- **Help without blocking.** AIs slip, for example by dropping a step while rewriting a list, or by forgetting after compaction. The extension makes slips visible and recoverable instead of forbidding things.
- **Tool descriptions carry the thinking.** They explain what the tools are for and why, so the agent can make good calls itself. Context, not rules.

## Who uses it

- **The agent** is the main user. It sees two tools, `goal` and `end_goal`, with descriptions that explain the ideas above.
- **Scott** sees a status line while a goal is active, can read the whole goal and its history with `/goal`, can stop waking with `/goal off`, or can just talk to the agent.

## What it does

### The goal
Every part except the goal sentence is optional, and all of it can change at any time:
- **goal:** the outcome, the way you'd explain it to a colleague.
- **why:** why it matters, so a future agent makes better calls.
- **steps:** a checklist. The agent can send the whole list, add steps at the end or after a given step, or change one step's status or wording by number or text.
- **notes:** the notebook of what truly matters (decisions, constraints, Scott's preferences, gotchas). It's edited like a file: replace the whole thing, append to the end, or make targeted edits that replace one exact passage and leave the rest alone. Old versions stay in history.
- **context:** records that accumulate and are never overwritten: conversation excerpts (verbatim is often best), how a requirement came about, what was tried.
- **next:** a note to the agent's next turn.
- **wake:** `on` (woken each time it finishes; the default), `after_reply` (held until Scott replies, then on again), or `off` (a notebook only). Needing one thing from Scott rarely blocks everything, so the guidance is to ask and keep working on the rest; `after_reply` is for when nothing else can move.
- **wake_in:** "don't wake me before then", as a duration (`10m`, `2h30m`) or a time. It's for waiting on CI, a deploy, or someone else's work. Until then finishing a turn doesn't wake the agent, though Scott still gets answers; afterwards waking carries on. It survives restarts, and if Pi was closed when the time passed, the wake comes when Pi is back.

There's one goal per session at a time. Ending it and starting another is fine.

### History
Every change is recorded with what changed, who changed it (the agent, Scott, or the extension itself), and why. Reasons are optional extra info at two levels: one `change` for the whole call, and a `why` on any individual step or notes edit. Each `why` appears next to its own line in the history, so a future agent reading it sees not just what moved but the thinking behind it. `goal()` with no arguments shows everything, including recent history. `goal({history: true})` shows every earlier version. Nothing is lost.

### Being woken
- When a run ends and nothing else is about to happen, the agent gets another turn with a short wake: the goal, why, step progress, its next note, the wake count, and how long it's been going. It closes with a reminder that it can change the plan, end the goal, or wait for Scott.
- After a compaction, the next wake (or Scott's next message) shows the whole goal again, context included. This also works when the compaction happened in an earlier Pi process.
- There's no wake after Esc, and none while Scott's messages are queued; those go first.

### Gentle help
- The reply to every change spells out what changed ("steps removed: …", "notes rewritten 1200 → 300 chars"), so accidental drops are caught right away.
- Changing the goal or why, or removing things, without a reason gets a tip that a reason makes the history more useful.
- The wake mentions when the next note hasn't changed in a while.
- Tools accept loose input (plain strings, `[x] text`, `in progress`).
- As with a file edit, a call that can't be fully applied changes nothing and says exactly why: text not found, ambiguous step matches, a step number that doesn't exist. The reply includes the current state so the fix is easy.

### Ending
`end_goal` with `done` or `dropped` and a reason Scott will see. The goal stays readable afterward.

### When things go wrong
- **Provider errors:** Pi's own retries come first. If a run still ends in an error, the agent is woken again after a growing pause (30s, 1m, 2m, then every 5m), and the wake says what happened. Anything Scott types cancels the pending retry.
- **No progress:** if three wakes in a row use no tools, waking turns itself off and leaves a visible note. The goal stays, and the agent can turn waking back on.
- **Subagents:** a forked subagent doesn't inherit its parent's goal, but it can set its own.

## Out of scope
- Auditors, completion contracts, drafting interviews, Sisyphus mode, oracles, and rules about when the agent may use goals.
- Sharing goals across sessions or machines.

## Open
- Package name: `pi-keep-going` is a working name.
- Whether timed wakes earn their place; Scott called them "that weird timer thing".
- The dashboard "looks fine I guess"; what it's missing is an open question.
