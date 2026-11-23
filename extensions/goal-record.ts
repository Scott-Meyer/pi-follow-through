/**
 * The goal record: an append-only list of events folded into the current goal.
 * Pure data, no Pi imports. Every change is its own event, so history is the
 * event list itself and nothing ever has to be rewritten.
 */

export type StepStatus = "todo" | "doing" | "done" | "dropped";
export type Wake = "on" | "after_reply" | "off";
export type Actor = "agent" | "user" | "keep-going";

export interface Step {
	text: string;
	status: StepStatus;
}

export interface ContextRecord {
	at: string;
	text: string;
}

/** Fields an event may set. Missing means unchanged; null clears. */
export interface GoalFields {
	goal?: string;
	why?: string | null;
	steps?: Step[];
	notes?: string | null;
	next?: string | null;
	wake?: Wake;
}

export type GoalEvent =
	| { kind: "start"; goalId: string; sessionId: string; at: string; by: Actor; set: GoalFields; context?: string; reason?: string }
	| { kind: "change"; goalId: string; at: string; by: Actor; set: GoalFields; context?: string; reason?: string; summary: string[] }
	| { kind: "end"; goalId: string; at: string; by: Actor; outcome: "done" | "dropped"; reason: string };

export interface WakeMark {
	goalId: string;
	wake: number;
	at: string;
}

export interface Goal {
	id: string;
	sessionId: string;
	goal: string;
	why?: string;
	steps: Step[];
	notes?: string;
	next?: string;
	wake: Wake;
	context: ContextRecord[];
	startedAt: string;
	updatedAt: string;
	/** Wake count when `next` last changed; lets wakes notice a stale note. */
	nextSetAtWake: number;
	wakes: number;
	lastWakeAt?: string;
	ended?: { outcome: "done" | "dropped"; reason: string; at: string; by: Actor };
	history: GoalEvent[];
}

function apply(goal: Goal, set: GoalFields) {
	if (set.goal !== undefined) goal.goal = set.goal;
	if (set.why !== undefined) goal.why = set.why ?? undefined;
	if (set.steps !== undefined) goal.steps = set.steps;
	if (set.notes !== undefined) goal.notes = set.notes ?? undefined;
	if (set.next !== undefined) {
		goal.next = set.next ?? undefined;
		goal.nextSetAtWake = goal.wakes;
	}
	if (set.wake !== undefined) goal.wake = set.wake;
}

/**
 * Fold a branch's events (oldest first) into the latest goal. Wake marks for
 * that goal set its wake count. `accept` lets the caller ignore goals it
 * shouldn't own, such as a parent's goal inside a forked subagent.
 */
export function foldGoal(items: Array<GoalEvent | WakeMark>, accept: (start: Extract<GoalEvent, { kind: "start" }>) => boolean = () => true): Goal | undefined {
	let current: Goal | undefined;
	for (const item of items) {
		if (!("kind" in item)) {
			if (current && item.goalId === current.id) {
				current.wakes = item.wake;
				current.lastWakeAt = item.at;
			}
			continue;
		}
		if (item.kind === "start") {
			if (!accept(item)) continue;
			current = {
				id: item.goalId, sessionId: item.sessionId, goal: "", steps: [], wake: "on", context: [],
				startedAt: item.at, updatedAt: item.at, nextSetAtWake: 0, wakes: 0, history: [item],
			};
			apply(current, item.set);
			if (item.context) current.context.push({ at: item.at, text: item.context });
			continue;
		}
		if (!current || item.goalId !== current.id) continue;
		current.history.push(item);
		current.updatedAt = item.at;
		if (item.kind === "change") {
			apply(current, item.set);
			if (item.context) current.context.push({ at: item.at, text: item.context });
		} else {
			current.ended = { outcome: item.outcome, reason: item.reason, at: item.at, by: item.by };
		}
	}
	return current;
}

export function isActive(goal: Goal | undefined): goal is Goal {
	return !!goal && !goal.ended;
}

/** Loose step input as models tend to write it. */
export type StepInput = string | { text?: string; step?: string; status?: string; done?: boolean };

const STATUS_WORDS: Record<string, StepStatus> = {
	todo: "todo", pending: "todo", open: "todo", "not started": "todo",
	doing: "doing", "in progress": "doing", in_progress: "doing", current: "doing", active: "doing",
	done: "done", complete: "done", completed: "done", finished: "done",
	dropped: "dropped", skipped: "dropped", cancelled: "dropped", canceled: "dropped", removed: "dropped",
};

export function parseStatus(word: string | undefined): StepStatus | undefined {
	return word ? STATUS_WORDS[word.trim().toLowerCase()] : undefined;
}

export function parseSteps(input: StepInput[]): Step[] {
	const steps: Step[] = [];
	for (const raw of input) {
		if (typeof raw === "string") {
			const box = raw.match(/^\s*(?:[-*]\s*)?\[( |x|X|~|-)\]\s*(.*)$/);
			if (box) {
				const mark = box[1];
				steps.push({ text: box[2].trim(), status: mark === " " ? "todo" : mark === "~" ? "doing" : mark === "-" ? "dropped" : "done" });
			} else if (raw.trim()) {
				steps.push({ text: raw.trim(), status: "todo" });
			}
			continue;
		}
		const text = (raw.text ?? raw.step ?? "").trim();
		if (!text) continue;
		steps.push({ text, status: parseStatus(raw.status) ?? (raw.done ? "done" : "todo") });
	}
	return steps;
}

export interface StepUpdate {
	step: number | string;
	status: string;
}

/** Apply status updates by 1-based number or by text; returns problems instead of throwing. */
export function updateSteps(steps: Step[], updates: StepUpdate[]): { steps: Step[]; problems: string[] } {
	const next = steps.map((s) => ({ ...s }));
	const problems: string[] = [];
	for (const u of updates) {
		const status = parseStatus(u.status);
		if (!status) {
			problems.push(`"${u.status}" isn't a step status (use todo, doing, done or dropped)`);
			continue;
		}
		let index = -1;
		if (typeof u.step === "number" || /^\d+$/.test(String(u.step).trim())) {
			index = Number(u.step) - 1;
		} else {
			const want = String(u.step).trim().toLowerCase();
			index = next.findIndex((s) => s.text.toLowerCase() === want);
			if (index < 0) index = next.findIndex((s) => s.text.toLowerCase().includes(want));
		}
		if (index < 0 || index >= next.length) {
			problems.push(`no step matches ${JSON.stringify(u.step)}`);
			continue;
		}
		next[index].status = status;
	}
	return { steps: next, problems };
}

/** Human-readable description of what a change did, so slips are easy to spot. */
export function describeChange(before: Goal | undefined, set: GoalFields, context?: string): string[] {
	const out: string[] = [];
	if (set.goal !== undefined && set.goal !== before?.goal) out.push(before ? `goal changed (was: "${clip(before.goal, 160)}")` : "goal set");
	if (set.why !== undefined && (set.why ?? undefined) !== before?.why) out.push(set.why ? (before?.why ? "why changed" : "why set") : "why cleared");
	if (set.steps !== undefined) {
		const old = before?.steps ?? [];
		const oldTexts = new Map(old.map((s) => [s.text, s]));
		const newTexts = new Set(set.steps.map((s) => s.text));
		const added = set.steps.filter((s) => !oldTexts.has(s.text));
		const removed = old.filter((s) => !newTexts.has(s.text));
		const moved = set.steps.filter((s) => oldTexts.has(s.text) && oldTexts.get(s.text)?.status !== s.status);
		if (added.length) out.push(`steps added: ${added.map((s) => `"${clip(s.text, 60)}"`).join(", ")}`);
		if (removed.length) out.push(`steps removed: ${removed.map((s) => `"${clip(s.text, 60)}"`).join(", ")}`);
		for (const s of moved) out.push(`step "${clip(s.text, 60)}": ${oldTexts.get(s.text)?.status} → ${s.status}`);
	}
	if (set.notes !== undefined && (set.notes ?? undefined) !== before?.notes) {
		const was = before?.notes?.length ?? 0;
		const now = set.notes?.length ?? 0;
		out.push(!set.notes ? `notes cleared (were ${was} chars)` : was ? `notes rewritten (${was} → ${now} chars)` : `notes written (${now} chars)`);
	}
	if (set.next !== undefined && (set.next ?? undefined) !== before?.next) out.push("next note updated");
	if (set.wake !== undefined && set.wake !== before?.wake) out.push(`waking ${set.wake === "on" ? "on" : set.wake === "off" ? "off" : "held until the user replies"}`);
	if (context) out.push(`context record added (${context.length} chars)`);
	return out;
}

export function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function since(iso: string, now = Date.now()): string {
	const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
	return `${Math.floor(hours / 24)}d`;
}

const STEP_MARK: Record<StepStatus, string> = { todo: "[ ]", doing: "[~]", done: "[x]", dropped: "[-]" };

export function renderSteps(steps: Step[]): string {
	return steps.map((s, i) => `${i + 1}. ${STEP_MARK[s.status]} ${s.text}`).join("\n");
}

export function stepProgress(steps: Step[]): string | undefined {
	if (steps.length === 0) return undefined;
	const live = steps.filter((s) => s.status !== "dropped");
	const done = live.filter((s) => s.status === "done").length;
	const doing = steps.filter((s) => s.status === "doing").map((s) => s.text);
	const upNext = steps.find((s) => s.status === "todo")?.text;
	return `${done}/${live.length} done${doing.length ? `; now: ${doing.map((t) => clip(t, 100)).join(" / ")}` : upNext ? `; next up: ${clip(upNext, 100)}` : ""}`;
}

function wakeLabel(wake: Wake): string {
	return wake === "on" ? "on (woken each time you finish)" : wake === "after_reply" ? "held until the user replies" : "off (notebook only)";
}

/** One history line per event. */
export function renderHistory(goal: Goal, limit?: number): string {
	const events = limit ? goal.history.slice(-limit) : goal.history;
	const lines = events.map((e) => {
		const who = e.by === "agent" ? "you" : e.by;
		if (e.kind === "start") return `- ${e.at} ${who}: started${e.reason ? ` — ${e.reason}` : ""}`;
		if (e.kind === "end") return `- ${e.at} ${who}: ended ${e.outcome} — ${e.reason}`;
		return `- ${e.at} ${who}: ${e.summary.join("; ") || "no change"}${e.reason ? ` — why: ${e.reason}` : ""}`;
	});
	const skipped = limit && goal.history.length > limit ? `(${goal.history.length - limit} earlier changes; goal({history: true}) shows all)\n` : "";
	return skipped + lines.join("\n");
}

/** Every earlier value of the fields that changed, for when the details matter. */
export function renderFullHistory(goal: Goal): string {
	return goal.history.map((e) => {
		const who = e.by === "agent" ? "you" : e.by;
		if (e.kind === "end") return `## ${e.at} ${who}: ended ${e.outcome}\n${e.reason}`;
		const head = e.kind === "start" ? `## ${e.at} ${who}: started` : `## ${e.at} ${who}: ${e.summary.join("; ")}`;
		const parts = [head, e.reason ? `Why: ${e.reason}` : undefined];
		if (e.set.goal !== undefined) parts.push(`Goal: ${e.set.goal}`);
		if (e.set.why !== undefined) parts.push(`Why it matters: ${e.set.why ?? "(cleared)"}`);
		if (e.set.steps !== undefined) parts.push(`Steps:\n${renderSteps(e.set.steps)}`);
		if (e.set.notes !== undefined) parts.push(`Notes:\n${e.set.notes ?? "(cleared)"}`);
		if (e.set.next !== undefined) parts.push(`Next: ${e.set.next ?? "(cleared)"}`);
		if (e.context) parts.push(`Context added:\n${e.context}`);
		return parts.filter(Boolean).join("\n");
	}).join("\n\n");
}

/** Everything: what the agent sees after compaction or when it asks. */
export function renderFull(goal: Goal, now = Date.now()): string {
	const parts = [
		`Goal: ${goal.goal}`,
		goal.why ? `Why: ${goal.why}` : undefined,
		`Waking: ${wakeLabel(goal.wake)}. Started ${since(goal.startedAt, now)} ago; woken ${goal.wakes} time${goal.wakes === 1 ? "" : "s"}.`,
		goal.ended ? `Ended ${goal.ended.outcome} (${goal.ended.by === "agent" ? "by you" : `by ${goal.ended.by}`}): ${goal.ended.reason}` : undefined,
		goal.steps.length ? `Steps (${stepProgress(goal.steps)}):\n${renderSteps(goal.steps)}` : undefined,
		goal.next ? `Next (your note): ${goal.next}` : undefined,
		goal.notes ? `Notes:\n${goal.notes}` : undefined,
		goal.context.length ? `Context (how this came about):\n${goal.context.map((c) => `--- ${c.at}\n${c.text}`).join("\n")}` : undefined,
		`History:\n${renderHistory(goal, 20)}`,
	];
	return parts.filter(Boolean).join("\n\n");
}

/** The short version carried on each wake. */
export function renderBrief(goal: Goal): string {
	const extras: string[] = [];
	if (goal.notes) extras.push(`notes (${goal.notes.length} chars)`);
	if (goal.context.length) extras.push(`${goal.context.length} context record${goal.context.length === 1 ? "" : "s"}`);
	return [
		`Goal: ${goal.goal}`,
		goal.why ? `Why: ${clip(goal.why, 400)}` : undefined,
		goal.steps.length ? `Steps: ${stepProgress(goal.steps)}` : undefined,
		goal.next ? `Next (your note): ${goal.next}` : undefined,
		extras.length ? `You also have ${extras.join(" and ")}; goal() with no arguments shows everything.` : undefined,
	].filter(Boolean).join("\n");
}
