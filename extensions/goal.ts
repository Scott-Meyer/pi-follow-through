/**
 * Goals the agent owns. The agent can hold what it's working toward across
 * turns and compactions, and, if it wants, have itself woken each time it
 * finishes until it ends the goal. See specs/2026-11-23-keep-going/PRODUCT.md.
 */
import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { GoalDashboard } from "./ui/widget.ts";
import {
	clip, describeChange, editText, foldGoal, isActive, parseSteps, renderBrief, renderSteps, renderFull, renderFullHistory, since, stepProgress, updateSteps,
	type Actor, type Goal, type GoalEvent, type GoalFields, type StepInput, type TextEdit, type StepUpdate, type Wake, type WakeMark,
} from "./goal-record.ts";

const EVENT_ENTRY = "goal-event";
const WAKE_MESSAGE = "goal-wake";
const NOTE_MESSAGE = "goal-note";
const STATUS_KEY = "goal";

/** Consecutive wakes with no tool use before waking turns itself off. */
const IDLE_FUSE = 3;
/** A `next` note unchanged for this many wakes gets a gentle mention. */
const STALE_NEXT_WAKES = 6;
/** Delays before re-waking after a run that ended in a provider error. */
const ERROR_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000];

const nowIso = () => new Date().toISOString();

function isSubagentChild(): boolean {
	return process.env.PI_SUBAGENT_CHILD === "1" || Number(process.env.PI_SUBAGENT_DEPTH ?? "0") > 0;
}

const GOAL_DESCRIPTION = `A goal is yours: a place to hold what you're working toward when it's bigger than one turn, and, if you want, a way to have yourself woken each time you finish until you end it. Use as much of it as helps. It can be a quick "keep waking me until this is done", or a full notebook for long work you know will be compacted many times: steps, notes, and the background of how things came to be.

Nobody has to approve it, and nothing grades it. Start one because the user asked for a goal or to keep at something, or because you judge you shouldn't stop yet. Change any part as you learn; plans are guesses, and when the details turn out wrong (the rig should have 177 bones, not 178), changing them is good judgment, not a failure. Say why in \`change\`. Every change is kept in a history with your reason, so you and the user can always see how the goal got to where it is, and nothing is ever lost.

What helps most later is often how you got here, not just where you landed. Deep in the work, when the exact requirement turns out not to be right, knowing the conversation and reasoning behind it is what lets you adapt well instead of guessing. So it's worth putting real excerpts of the discussion in \`context\`, verbatim when the wording matters, rather than only a summary. After a compaction the whole goal, context included, is shown to you again.

Call goal with no arguments to see everything.`;

const END_DESCRIPTION = `End your goal. "done" when you've finished; "dropped" when it's no longer worth doing or turned out to be the wrong goal, which is a perfectly good outcome when it's the right call. Waking stops, and the goal and its history stay readable. The reason is shown to the user, so say what actually happened. If you only need something from the user, goal({wake: "after_reply"}) pauses waking until they answer instead of ending it.`;

export default function goalExtension(pi: ExtensionAPI) {
	let goal: Goal | undefined;
	// Per-run bookkeeping, memory only.
	let runIsWake = false;
	let nextRunIsWake = false;
	let runToolCalls = 0;
	let idleStreak = 0;
	let showFullNext = false;
	let lastRunError: string | undefined;
	let errorAttempts = 0;
	let errorTimer: ReturnType<typeof setTimeout> | undefined;
	let retryAt: number | undefined;
	let busy = false;
	let tokens = 0;
	const dashboard = new GoalDashboard(() => isActive(goal)
		? { goal, live: { busy, tokens, retryInSeconds: retryAt ? Math.max(0, (retryAt - Date.now()) / 1000) : undefined } }
		: undefined);

	function clearErrorTimer() {
		if (errorTimer) clearTimeout(errorTimer);
		errorTimer = undefined;
		retryAt = undefined;
	}

	// Events and wake marks on this branch, oldest first; the goal is their fold.
	let items: Array<GoalEvent | WakeMark> = [];
	let acceptStart: (start: Extract<GoalEvent, { kind: "start" }>) => boolean = () => true;
	function refold() {
		goal = foldGoal(items, acceptStart);
	}

	/** Persist an event now (outside a boundary) and refold. */
	function record(event: GoalEvent) {
		pi.appendEntry(EVENT_ENTRY, event);
		items.push(event);
		refold();
	}

	/** Track an event or mark that a boundary draft will persist. */
	function track(item: GoalEvent | WakeMark) {
		items.push(item);
		refold();
	}

	function updateStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		dashboard.sync(ctx);
		try {
			if (!isActive(goal)) return ctx.ui.setStatus(STATUS_KEY, undefined);
			const progress = goal.steps.length ? ` · ${stepProgress(goal.steps)?.split(";")[0]}` : "";
			const label = goal.wake === "on"
				? `↻ ${clip(goal.goal, 48)}${progress} · ${goal.wakes} wake${goal.wakes === 1 ? "" : "s"}`
				: goal.wake === "after_reply"
					? `⏸ goal waiting for you: ${clip(goal.next ?? goal.goal, 48)}`
					: `◇ ${clip(goal.goal, 48)}${progress}`;
			ctx.ui.setStatus(STATUS_KEY, label);
		} catch {
			// stale ctx after reload; the next session_start redraws
		}
	}

	function restore(ctx: ExtensionContext) {
		clearErrorTimer();
		idleStreak = 0;
		errorAttempts = 0;
		const sessionId = ctx.sessionManager.getSessionId();
		items = [];
		// Compaction may have happened in an earlier process; if the whole goal
		// hasn't been shown since the last one, show it next time.
		let lastCompaction = -1;
		let lastFullView = -1;
		const branch = ctx.sessionManager.getBranch();
		branch.forEach((raw, index) => {
			const entry = raw as { type: string; customType?: string; data?: unknown; details?: unknown; message?: { role?: string; customType?: string; details?: unknown } };
			if (entry.type === "compaction") lastCompaction = index;
			if (entry.type === "custom" && entry.customType === EVENT_ENTRY) items.push(entry.data as GoalEvent);
			const custom = entry.type === "custom_message"
				? { customType: entry.customType, details: entry.details }
				: entry.type === "message" && entry.message?.role === "custom" ? { customType: entry.message.customType, details: entry.message.details } : undefined;
			if (!custom) return;
			if (custom.customType === WAKE_MESSAGE && custom.details) items.push(custom.details as WakeMark);
			if ((custom.customType === WAKE_MESSAGE || custom.customType === NOTE_MESSAGE) && (custom.details as { full?: boolean } | undefined)?.full) lastFullView = index;
		});
		showFullNext = lastCompaction > lastFullView;
		tokens = 0;
		// A forked subagent never runs its parent's goal; it can start its own.
		acceptStart = (start) => !isSubagentChild() || start.sessionId === sessionId;
		refold();
		if (goal) {
			const start = Date.parse(goal.startedAt);
			for (const raw of branch) {
				const entry = raw as { type: string; message?: { role?: string; timestamp?: number; usage?: { input?: number; output?: number } } };
				if (entry.type === "message" && entry.message?.role === "assistant" && (entry.message.timestamp ?? 0) >= start) tokens += (entry.message.usage?.input ?? 0) + (entry.message.usage?.output ?? 0);
			}
		}
		updateStatus(ctx);
	}

	function wakeContent(g: Goal, opts: { full?: boolean; error?: string } = {}): string {
		const nudges: string[] = [];
		if (opts.error) nudges.push(`Your last run ended in an error (${clip(opts.error, 300)}), so this wake came after a pause.`);
		if (idleStreak > 0) nudges.push(`Your last ${idleStreak === 1 ? "wake" : `${idleStreak} wakes`} used no tools; after ${IDLE_FUSE} in a row, waking turns itself off.`);
		if (g.next && g.wakes - g.nextSetAtWake >= STALE_NEXT_WAKES) nudges.push(`Your next note hasn't changed in ${g.wakes - g.nextSetAtWake} wakes; worth refreshing if things have moved on.`);
		return [
			`[goal] You asked to be woken each time you finish, until you end the goal or turn waking off. Wake ${g.wakes}, ${since(g.startedAt)} in.`,
			opts.full ? `The conversation was compacted, so here is your whole goal again.\n\n${renderFull(g)}` : renderBrief(g),
			...nudges,
			`Carry on. If what you've learned changes the goal or the plan, change it with goal and say why. end_goal when it's done or no longer the right thing; goal({wake: "after_reply"}) if you need the user.`,
		].join("\n");
	}

	pi.registerMessageRenderer(WAKE_MESSAGE, (message, { expanded, outputPad }, theme) => {
		const details = message.details as { wake?: number; goal?: string } | undefined;
		const box = new Box(outputPad, 0, (t) => theme.bg("customMessageBg", t));
		const head = theme.fg("accent", `↻ wake ${details?.wake ?? ""}`) + theme.fg("muted", ` · ${clip(details?.goal ?? "", 80)}`);
		const body = typeof message.content === "string" ? message.content : "";
		box.addChild(new Text(expanded ? `${head}\n${theme.fg("dim", body)}` : head, 0, 0));
		return box;
	});
	pi.registerMessageRenderer(NOTE_MESSAGE, (message, { expanded, outputPad }, theme) => {
		const box = new Box(outputPad, 0, (t) => theme.bg("customMessageBg", t));
		const body = typeof message.content === "string" ? message.content : "";
		box.addChild(new Text(theme.fg("muted", expanded ? body : clip(body, 200)), 0, 0));
		return box;
	});

	const WHY_ITEM = "Optional: why this one changed. Shown next to it in the history, which helps a future you who's wondering how things got this way.";
	const StepItem = Type.Union([
		Type.String(),
		Type.Object({
			text: Type.String(),
			status: Type.Optional(Type.String({ description: "todo, doing, done or dropped" })),
			why: Type.Optional(Type.String({ description: WHY_ITEM })),
		}),
	]);
	const NewStepItem = Type.Union([
		Type.String(),
		Type.Object({
			text: Type.String(),
			status: Type.Optional(Type.String({ description: "todo, doing, done or dropped" })),
			after: Type.Optional(Type.Number({ description: "Insert after this step number (0 for the top). Default: the end." })),
			why: Type.Optional(Type.String({ description: WHY_ITEM })),
		}),
	]);

	pi.registerTool({
		name: "goal",
		label: "Goal",
		description: GOAL_DESCRIPTION,
		promptSnippet: "Hold your own goal across turns and compactions; optionally be woken until you end it",
		promptGuidelines: [
			"goal is yours to use whenever it helps: the user asks for a goal or for you to keep at something, you judge you shouldn't stop yet, or you want notes that survive compaction. Record how requirements and decisions came about, real conversation excerpts included, in goal's context; once you're deep in the work, that reasoning is usually what lets you adapt the details well.",
		],
		parameters: Type.Object({
			goal: Type.Optional(Type.String({ description: "The outcome you're after, the way you'd explain it to a colleague. Needed to start; omit to keep the current one. Specifics are your current plan, not a contract." })),
			why: Type.Optional(Type.String({ description: "Why it matters and to whom. A future you makes better calls knowing this. Empty string clears." })),
			steps: Type.Optional(Type.Array(StepItem, { description: "Optional checklist, as the whole list should be now (strings, \"[x] text\", or {text, status}). The reply lists anything added or removed, so an accidental drop is easy to catch." })),
			add_steps: Type.Optional(Type.Array(NewStepItem, { description: "New steps, added at the end or after a given step number." })),
			step_updates: Type.Optional(Type.Array(Type.Object({
				step: Type.Union([Type.Number(), Type.String()], { description: "1-based number, or (part of) the step's text" }),
				status: Type.Optional(Type.String({ description: "todo, doing, done or dropped" })),
				text: Type.Optional(Type.String({ description: "New wording for the step" })),
				why: Type.Optional(Type.String({ description: WHY_ITEM })),
			}), { description: "Change single steps (status, wording) without resending the list." })),
			notes: Type.Optional(Type.String({ description: "Your notebook of what truly matters: decisions, constraints, the user's preferences, gotchas, anything you'd hate to lose to compaction. Replaces all of the notes; earlier versions stay in history. Empty string clears. For smaller changes, add_notes and notes_edits leave the rest alone." })),
			add_notes: Type.Optional(Type.String({ description: "Appended to the end of your notes." })),
			notes_edits: Type.Optional(Type.Array(Type.Object({
				old_text: Type.String({ description: "Exact text currently in the notes; must appear once." }),
				new_text: Type.String({ description: "What replaces it. Empty removes it. To insert, include a nearby line in old_text and repeat it here with your addition." }),
				why: Type.Optional(Type.String({ description: WHY_ITEM })),
			}), { description: "Targeted edits to the notes, like editing a file: each one replaces one exact passage and leaves everything else as it is." })),
			context: Type.Optional(Type.String({ description: "Adds a record to the goal's background: conversation excerpts (verbatim is often best), how a requirement or decision came about, what was tried and why it didn't work. Records accumulate and are never overwritten." })),
			next: Type.Optional(Type.String({ description: "A note to the next you: where you are and what you'd do next. Empty string clears." })),
			wake: Type.Optional(StringEnum(["on", "after_reply", "off"] as const, { description: "on (the default when starting): be woken each time you finish. after_reply: hold off until the user replies, then wake again; good when you need something from them. off: keep the goal as a notebook without waking." })),
			change: Type.Optional(Type.String({ description: "Optional: a few words on why you're making this change as a whole. It goes in the history next to it; the per-item why fields cover individual steps and edits." })),
			history: Type.Optional(Type.Boolean({ description: "true shows every earlier version of what changed, for when the details of the history matter." })),
		}, { additionalProperties: false }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const at = nowIso();
			const problems: string[] = [];
			const set: GoalFields = {};
			const text = (v: string | undefined) => (v === undefined ? undefined : v.trim() || null);
			if (params.goal !== undefined && params.goal.trim()) set.goal = params.goal.trim();
			if (params.why !== undefined) set.why = text(params.why);
			if (params.notes !== undefined) set.notes = text(params.notes);
			if (params.next !== undefined) set.next = text(params.next);
			if (params.wake !== undefined) set.wake = params.wake as Wake;
			const context = params.context?.trim() || undefined;
			const active = isActive(goal) ? goal : undefined;
			const stepWhy = new Map<string, string>();
			const noteWhy = (items: Array<StepInput>) => {
				for (const item of items) if (typeof item === "object" && item && "why" in item && typeof item.why === "string" && item.why.trim() && item.text) stepWhy.set(item.text.trim(), item.why.trim());
			};

			if (params.steps !== undefined) {
				set.steps = parseSteps(params.steps as StepInput[]);
				noteWhy(params.steps as StepInput[]);
			}
			if (params.add_steps?.length) {
				const list = [...(set.steps ?? active?.steps ?? [])];
				// Insert in reverse order of position so earlier inserts don't shift later anchors.
				const adds = (params.add_steps as Array<StepInput & { after?: number }>).map((item, order) => ({ item, order, after: typeof item === "object" && typeof item.after === "number" ? item.after : list.length }));
				for (const a of adds) if (a.after < 0 || a.after > list.length) problems.push(`add_steps: there is no step ${a.after} to insert after (there are ${list.length})`);
				adds.sort((x, y) => y.after - x.after || y.order - x.order);
				for (const a of adds) list.splice(Math.max(0, Math.min(list.length, a.after)), 0, ...parseSteps([a.item]));
				set.steps = list;
				noteWhy(params.add_steps as StepInput[]);
			}
			if (params.step_updates?.length) {
				const result = updateSteps(set.steps ?? active?.steps ?? [], params.step_updates as StepUpdate[]);
				set.steps = result.steps;
				problems.push(...result.problems);
				for (const [k, v] of result.why) stepWhy.set(k, v);
			}
			let notesLines: string[] | undefined;
			if (params.notes_edits?.length) {
				const base = set.notes !== undefined ? set.notes ?? "" : active?.notes ?? "";
				const result = editText(base, params.notes_edits as TextEdit[], "notes");
				problems.push(...result.problems);
				set.notes = result.text.trim() ? result.text : null;
				notesLines = result.lines;
			}
			if (params.add_notes?.trim()) {
				const base = set.notes !== undefined ? set.notes ?? "" : active?.notes ?? "";
				set.notes = base ? `${base.replace(/\s+$/, "")}\n${params.add_notes.trim()}` : params.add_notes.trim();
				if (notesLines || params.notes === undefined) (notesLines ??= []).push(`notes: added "${clip(params.add_notes.trim(), 80)}"`);
			}

			// Like a file edit: if any part can't be applied, nothing is changed.
			if (problems.length) {
				return { isError: true, content: [{ type: "text", text: `Nothing was changed:\n- ${problems.join("\n- ")}\n\nFix those and send the call again.${active ? `\n\n${renderBrief(active)}${active.steps.length ? `\nSteps:\n${renderSteps(active.steps)}` : ""}${params.notes_edits?.length ? `\nNotes as they are now:\n${active.notes ?? "(empty)"}` : ""}` : ""}` }], details: goal };
			}

			const hasChange = Object.keys(set).length > 0 || !!context;
			if (!hasChange) {
				if (!goal) return { content: [{ type: "text", text: "No goal in this session yet. Start one with goal({goal: \"...\"})." }], details: undefined };
				const body = params.history ? `${renderFull(goal)}\n\nFull history:\n${renderFullHistory(goal)}` : renderFull(goal);
				return { content: [{ type: "text", text: active ? body : `Your last goal has ended; starting a new one replaces it.\n\n${body}` }], details: goal };
			}

			const summary = active ? describeChange(active, set, context, { notesLines, stepWhy }) : ["started"];
			if (!active) {
				if (!set.goal) {
					return { isError: true, content: [{ type: "text", text: "Nothing to update: no goal is active. Include `goal` (what you're after) to start one; everything else is optional." }], details: goal };
				}
				record({ kind: "start", goalId: randomUUID(), sessionId: ctx.sessionManager.getSessionId(), at, by: "agent", set: { wake: "on", ...set }, context, reason: params.change?.trim() || undefined });
			} else {
				if (summary.length === 0) {
					return { content: [{ type: "text", text: `No change; that's what the goal already says.\n\n${renderBrief(active)}` }], details: active };
				}
				record({ kind: "change", goalId: active.id, at, by: "agent", set, context, reason: params.change?.trim() || undefined, summary, notesEdited: notesLines !== undefined && params.notes === undefined });
			}
			idleStreak = 0;
			updateStatus(ctx);
			const g = goal as Goal;
			const anyWhy = !!params.change?.trim() || stepWhy.size > 0 || (params.notes_edits ?? []).some((e) => e.why?.trim());
			const lines = [
				active ? `Updated:\n- ${summary.join("\n- ")}` : `Goal started. ${g.wake === "on" ? "You'll be woken each time you finish until you end it or turn waking off." : g.wake === "after_reply" ? "Waking starts once the user replies." : "Waking is off; it's a notebook for now."}`,
				active && !anyWhy && (set.goal !== undefined || set.why !== undefined || summary.some((s) => s.startsWith("steps removed") || s.startsWith("notes cleared") || s.startsWith("notes rewritten"))) ? "Tip: a few words of why (`change`, or `why` on a step or edit) make the history much more useful later." : undefined,
				"",
				renderBrief(g),
				// The full list only when its shape changed; a status tick is already in the summary.
				g.steps.length && set.steps && (!active || summary.some((l) => /^steps (added|removed)|reworded/.test(l))) ? `\nSteps:\n${renderSteps(g.steps)}` : undefined,
			];
			return { content: [{ type: "text", text: lines.filter((l) => l !== undefined).join("\n") }], details: g };
		},
	});

	pi.registerTool({
		name: "end_goal",
		label: "End goal",
		description: END_DESCRIPTION,
		promptSnippet: "End your goal as done or dropped",
		parameters: Type.Object({
			outcome: StringEnum(["done", "dropped"] as const),
			reason: Type.String({ description: "What actually happened, in a line or two. The user sees it." }),
		}, { additionalProperties: false }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!isActive(goal)) return { content: [{ type: "text", text: "No goal is active; nothing to end." }], details: goal };
			clearErrorTimer();
			record({ kind: "end", goalId: goal.id, at: nowIso(), by: "agent", outcome: params.outcome as "done" | "dropped", reason: params.reason.trim() });
			updateStatus(ctx);
			return { content: [{ type: "text", text: `Goal ended (${params.outcome}). You won't be woken for it anymore; goal() still shows it and its history.` }], details: goal };
		},
	});

	pi.registerCommand("goal", {
		description: "Show the agent's goal and history; `/goal off` stops waking (the agent is told)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "off") {
				if (!isActive(goal) || goal.wake === "off") return ctx.ui.notify("Nothing is waking the agent.", "info");
				clearErrorTimer();
				const g = goal;
				record({ kind: "change", goalId: g.id, at: nowIso(), by: "user", set: { wake: "off" }, reason: "turned off with /goal off", summary: ["waking off"] });
				updateStatus(ctx);
				pi.sendMessage({ customType: NOTE_MESSAGE, content: `[goal] The user turned waking off for your goal "${clip(g.goal, 200)}". The goal itself is still there; you won't be woken for it unless waking is turned back on.`, display: true }, { deliverAs: "nextTurn" });
				return ctx.ui.notify("Waking is off. The agent will be told on its next turn.", "info");
			}
			if (arg === "history" && goal) return ctx.ui.notify(`${renderFull(goal)}\n\nFull history:\n${renderFullHistory(goal)}`, "info");
			ctx.ui.notify(goal ? renderFull(goal) : "The agent hasn't set a goal in this session.", "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => restore(ctx));
	pi.on("session_tree", async (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", async () => {
		clearErrorTimer();
		dashboard.dispose();
	});
	pi.on("message_end", async (event) => {
		const m = event.message as { role?: string; usage?: { input?: number; output?: number } };
		if (m.role === "assistant" && isActive(goal)) tokens += (m.usage?.input ?? 0) + (m.usage?.output ?? 0);
	});
	pi.on("session_compact", async () => {
		if (isActive(goal)) showFullNext = true;
	});

	pi.on("input", async () => {
		// The user is driving; any pending error retry is moot.
		clearErrorTimer();
		errorAttempts = 0;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (event.messageType !== "user") return;
		clearErrorTimer();
		errorAttempts = 0;
		idleStreak = 0;
		if (!isActive(goal)) return;
		const notes: string[] = [];
		if (goal.wake === "after_reply") {
			record({ kind: "change", goalId: goal.id, at: nowIso(), by: "keep-going", set: { wake: "on" }, reason: "the user replied", summary: ["waking on"] });
			updateStatus(ctx);
			notes.push("[goal] The user replied, so waking is back on for your goal.");
		}
		const full = showFullNext;
		if (full) {
			showFullNext = false;
			notes.push(`[goal] The conversation was compacted, so here is your whole goal again.\n\n${renderFull(goal)}`);
		} else if (notes.length) {
			notes.push(renderBrief(goal));
		}
		if (!notes.length) return;
		return { message: { customType: NOTE_MESSAGE, content: notes.join("\n"), display: true, details: { full } } };
	});

	pi.on("agent_start", async (_event, ctx) => {
		busy = true;
		dashboard.sync(ctx);
		runIsWake = nextRunIsWake;
		nextRunIsWake = false;
		runToolCalls = 0;
	});

	pi.on("tool_execution_end", async () => {
		runToolCalls++;
	});

	pi.on("agent_end", async (event) => {
		lastRunError = undefined;
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const m = event.messages[i] as { role: string; stopReason?: string; errorMessage?: string };
			if (m.role !== "assistant") continue;
			if (m.stopReason === "error") lastRunError = m.errorMessage || "unknown provider error";
			break;
		}
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (!isActive(goal) || goal.wake !== "on" || event.outcome !== "completed") return;
		if (event.context.pendingMessages.length > 0) return; // the user's queued input goes first
		errorAttempts = 0;
		idleStreak = runIsWake && runToolCalls === 0 ? idleStreak + 1 : 0;
		const at = nowIso();
		if (idleStreak >= IDLE_FUSE) {
			const event2: GoalEvent = { kind: "change", goalId: goal.id, at, by: "keep-going", set: { wake: "off" }, reason: `your last ${IDLE_FUSE} wakes used no tools`, summary: ["waking off"] };
			track(event2);
			idleStreak = 0;
			updateStatus(ctx);
			return {
				entries: [
					...event.entries,
					{ type: "custom", customType: EVENT_ENTRY, data: event2 },
					{ type: "custom_message", customType: NOTE_MESSAGE, content: `[goal] Waking turned itself off: your last ${IDLE_FUSE} wakes used no tools. Your goal is still there; goal({wake: "on"}) turns waking back on if you still want it.`, display: true },
				],
			};
		}
		const mark: WakeMark = { goalId: goal.id, wake: goal.wakes + 1, at };
		track(mark);
		if (!isActive(goal)) return;
		const full = showFullNext;
		showFullNext = false;
		nextRunIsWake = true;
		updateStatus(ctx);
		return {
			entries: [
				...event.entries,
				{ type: "custom_message", customType: WAKE_MESSAGE, content: wakeContent(goal, { full }), display: true, details: { ...mark, goal: goal.goal, full } },
			],
			continue: true,
		};
	});

	pi.on("agent_settled", async (event, ctx) => {
		busy = false;
		dashboard.sync(ctx);
		if (event.aborted || !lastRunError || !isActive(goal) || goal.wake !== "on") return;
		// The run failed after Pi's own retries. Try again later, slowly.
		const error = lastRunError;
		const delay = ERROR_BACKOFF_MS[Math.min(errorAttempts, ERROR_BACKOFF_MS.length - 1)];
		errorAttempts++;
		clearErrorTimer();
		const goalId = goal.id;
		const fire = () => {
			errorTimer = undefined;
			retryAt = undefined;
			try {
				if (!isActive(goal) || goal.id !== goalId || goal.wake !== "on") return;
				if (!ctx.isIdle() || ctx.hasPendingMessages()) return; // something else is running; its settle decides
				const at = nowIso();
				const mark: WakeMark = { goalId, wake: goal.wakes + 1, at };
				track(mark);
				if (!isActive(goal)) return;
				nextRunIsWake = true;
				updateStatus(ctx);
				const full = showFullNext;
				showFullNext = false;
				pi.sendMessage(
					{ customType: WAKE_MESSAGE, content: wakeContent(goal, { full, error }), display: true, details: { ...mark, goal: goal.goal, error, full } },
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			} catch {
				// ctx went stale (reload or session replacement); the new runtime restores itself
			}
		};
		errorTimer = setTimeout(fire, delay);
		retryAt = Date.now() + delay;
		dashboard.sync(ctx);
		errorTimer.unref?.();
		try {
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, `↻ goal: last run errored, waking again in ${Math.round(delay / 1000)}s`);
		} catch {
			// stale ctx
		}
	});
}

export type { Actor };
