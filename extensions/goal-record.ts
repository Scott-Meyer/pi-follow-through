/**
 * The goal record: an append-only list of events folded into the current goal.
 * Pure data, no Pi imports. Every change is its own event, so history is the
 * event list itself and nothing ever has to be rewritten.
 */

export type StepStatus = "todo" | "doing" | "done" | "dropped";
export type Wake = "on" | "after_reply" | "off";
/** "keep-going" is the extension's name in records written before the rename. */
export type Actor = "agent" | "user" | "extension" | "keep-going";

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
	/** ISO time before which finishing a turn doesn't wake the agent. Null clears. */
	sleepUntil?: string | null;
}

export type GoalEvent =
	| { kind: "start"; goalId: string; sessionId: string; at: string; by: Actor; set: GoalFields; context?: string; reason?: string }
	| {
		kind: "change"; goalId: string; at: string; by: Actor; set: GoalFields; context?: string; reason?: string; summary: string[];
		/** Appends and targeted edits to the notes, replayed in order after `set`, so small edits stay small on disk. */
		notesOps?: NotesOp[];
		/** Older records: notes changed by targeted edits but stored whole in `set.notes`. */
		notesEdited?: boolean;
	}
	| { kind: "end"; goalId: string; at: string; by: Actor; outcome: "done" | "dropped"; reason: string };

export type NotesOp = { append: string } | { old_text: string; new_text: string };

/** Replay notes ops; each was validated against the notes when it was written. */
export function applyNotesOps(notes: string | undefined, ops: NotesOp[]): string | undefined {
	let text = notes ?? "";
	for (const op of ops) {
		if ("append" in op) text = text ? `${text.replace(/\s+$/, "")}\n${op.append}` : op.append;
		else {
			const at = text.indexOf(op.old_text);
			if (at >= 0) text = text.slice(0, at) + op.new_text + text.slice(at + op.old_text.length);
		}
	}
	return text.trim() ? text : undefined;
}

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
	sleepUntil?: string;
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
	if (set.sleepUntil !== undefined) goal.sleepUntil = set.sleepUntil ?? undefined;
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
				// A wake at or after the sleep time ends the sleep.
				if (current.sleepUntil && item.at >= current.sleepUntil) current.sleepUntil = undefined;
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
			if (item.notesOps?.length) current.notes = applyNotesOps(current.notes, item.notesOps);
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
	status?: string;
	/** New wording for the step. */
	text?: string;
	/** Why this step changed; shown next to it in the history. */
	why?: string;
}

/** Apply updates by 1-based number or by text; returns problems instead of throwing. */
export function updateSteps(steps: Step[], updates: StepUpdate[]): { steps: Step[]; problems: string[]; why: Map<string, string>; renamed: Map<string, string> } {
	const why = new Map<string, string>();
	/** New text → old text, for steps reworded by an update. */
	const renamed = new Map<string, string>();
	const next = steps.map((s) => ({ ...s }));
	const problems: string[] = [];
	for (const u of updates) {
		const status = u.status === undefined ? undefined : parseStatus(u.status);
		if (u.status !== undefined && !status) {
			problems.push(`"${u.status}" isn't a step status (use todo, doing, done or dropped)`);
			continue;
		}
		if (!status && !u.text?.trim()) {
			problems.push(`update for step ${JSON.stringify(u.step)} has neither a status nor new text`);
			continue;
		}
		let index = -1;
		if (typeof u.step === "number" || /^\d+$/.test(String(u.step).trim())) {
			index = Number(u.step) - 1;
		} else {
			const want = String(u.step).trim().toLowerCase();
			index = next.findIndex((s) => s.text.toLowerCase() === want);
			if (index < 0) {
				const matches = next.map((s, i) => [s, i] as const).filter(([s]) => s.text.toLowerCase().includes(want));
				if (matches.length > 1) {
					problems.push(`${JSON.stringify(u.step)} matches steps ${matches.map(([, i]) => i + 1).join(", ")}; use a number`);
					continue;
				}
				index = matches[0]?.[1] ?? -1;
			}
		}
		if (index < 0 || index >= next.length) {
			problems.push(`no step matches ${JSON.stringify(u.step)} (there are ${next.length})`);
			continue;
		}
		if (status) next[index].status = status;
		if (u.text?.trim() && u.text.trim() !== next[index].text) {
			const original = renamed.get(next[index].text) ?? next[index].text;
			renamed.delete(next[index].text);
			next[index].text = u.text.trim();
			renamed.set(next[index].text, original);
		}
		if (u.why?.trim()) why.set(next[index].text, u.why.trim());
	}
	return { steps: next, problems, why, renamed };
}

export interface TextEdit {
	old_text: string;
	new_text: string;
	why?: string;
}

/**
 * Targeted edits, like a file edit tool: each old_text must appear exactly
 * once in the text as it stands after the previous edits. To insert, include
 * a nearby anchor in old_text and repeat it in new_text.
 */
export function editText(text: string, edits: TextEdit[], label: string): { text: string; problems: string[]; lines: string[] } {
	let current = text;
	const problems: string[] = [];
	const lines: string[] = [];
	edits.forEach((e, i) => {
		const n = `${label} edit ${i + 1}`;
		if (!e.old_text) {
			problems.push(`${n}: old_text is empty (use add_notes to append)`);
			return;
		}
		const first = current.indexOf(e.old_text);
		if (first < 0) {
			problems.push(`${n}: old_text not found${current.includes(e.old_text.trim()) ? " exactly (check whitespace)" : ""}`);
			return;
		}
		if (current.indexOf(e.old_text, first + 1) >= 0) {
			problems.push(`${n}: old_text appears more than once; include more surrounding text`);
			return;
		}
		current = current.slice(0, first) + e.new_text + current.slice(first + e.old_text.length);
		const what = e.new_text === "" ? `removed "${clip(e.old_text, 80)}"` : `"${clip(e.old_text, 60)}" → "${clip(e.new_text, 80)}"`;
		lines.push(`${label}: ${what}${e.why?.trim() ? ` — ${e.why.trim()}` : ""}`);
	});
	return { text: current, problems, lines };
}

/** Human-readable description of what a change did, so slips are easy to spot. */
export function describeChange(
	before: Goal | undefined,
	set: GoalFields,
	context?: string,
	extra: { notesLines?: string[]; stepWhy?: Map<string, string>; renamed?: Map<string, string> } = {},
): string[] {
	const out: string[] = [];
	const stepWhy = (text: string) => (extra.stepWhy?.get(text) ? ` — ${extra.stepWhy.get(text)}` : "");
	if (set.goal !== undefined && set.goal !== before?.goal) out.push(before ? `goal changed (was: "${clip(before.goal, 160)}")` : "goal set");
	if (set.why !== undefined && (set.why ?? undefined) !== before?.why) out.push(set.why ? (before?.why ? "why changed" : "why set") : "why cleared");
	if (set.steps !== undefined) {
		const old = before?.steps ?? [];
		const next = set.steps;
		const lineUp = old.length === next.length;
		if (lineUp && old.every((o, i) => o.text === next[i].text)) {
			// Same steps in the same places: report status changes by position, so repeated texts are fine.
			next.forEach((n, i) => {
				if (old[i].status !== n.status) out.push(`step ${i + 1} "${clip(n.text, 60)}": ${old[i].status} → ${n.status}${stepWhy(n.text)}`);
			});
		} else if (lineUp && next.every((n, i) => n.text === old[i].text || !old.some((o) => o.text === n.text))) {
			// Same shape; every changed text is new rather than moved from elsewhere: reworded.
			next.forEach((n, i) => {
				const o = old[i];
				if (o.text !== n.text) out.push(`step ${i + 1} reworded (was: "${clip(o.text, 60)}")${o.status !== n.status ? `, ${o.status} → ${n.status}` : ""}${stepWhy(n.text)}`);
				else if (o.status !== n.status) out.push(`step ${i + 1} "${clip(n.text, 60)}": ${o.status} → ${n.status}${stepWhy(n.text)}`);
			});
		} else {
			const remaining = [...old];
			const added: Step[] = [];
			const moved: Array<[Step, Step]> = [];
			for (const n of next) {
				const was = extra.renamed?.get(n.text);
				const renamedAt = was !== undefined ? remaining.findIndex((o) => o.text === was) : -1;
				if (renamedAt >= 0) {
					const [o] = remaining.splice(renamedAt, 1);
					out.push(`step reworded: "${clip(n.text, 60)}" (was: "${clip(o.text, 60)}")${o.status !== n.status ? `, ${o.status} → ${n.status}` : ""}${stepWhy(n.text)}`);
					continue;
				}
				const at = remaining.findIndex((o) => o.text === n.text);
				if (at < 0) added.push(n);
				else {
					const [o] = remaining.splice(at, 1);
					if (o.status !== n.status) moved.push([o, n]);
				}
			}
			for (const n of added) out.push(`step added: "${clip(n.text, 60)}"${stepWhy(n.text)}`);
			for (const o of remaining) out.push(`step removed: "${clip(o.text, 60)}"`);
			for (const [o, n] of moved) out.push(`step "${clip(n.text, 60)}": ${o.status} → ${n.status}${stepWhy(n.text)}`);
			if (!added.length && !remaining.length && old.some((o, i) => o.text !== next[i]?.text)) out.push("steps reordered");
		}
	}
	if (extra.notesLines?.length) {
		out.push(...extra.notesLines);
	} else if (set.notes !== undefined && (set.notes ?? undefined) !== before?.notes) {
		const was = before?.notes?.length ?? 0;
		const now = set.notes?.length ?? 0;
		out.push(!set.notes ? `notes cleared (were ${was} chars)` : was ? `notes rewritten (${was} → ${now} chars)` : `notes written (${now} chars)`);
	}
	if (set.next !== undefined && (set.next ?? undefined) !== before?.next) out.push("next note updated");
	if (set.sleepUntil !== undefined && (set.sleepUntil ?? undefined) !== before?.sleepUntil) out.push(set.sleepUntil ? `sleeping until ${clockTime(set.sleepUntil)}` : "sleep cleared");
	if (set.wake !== undefined && set.wake !== before?.wake) out.push(`waking ${set.wake === "on" ? "on" : set.wake === "off" ? "off" : "held until the user replies"}`);
	if (context) out.push(`context record added (${context.length} chars)`);
	return out;
}

export function actorLabel(by: Actor): string {
	return by === "agent" ? "you" : by === "user" ? "user" : "extension";
}

export function clockTime(iso: string): string {
	const d = new Date(iso);
	const sameDay = new Date().toDateString() === d.toDateString();
	const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	return sameDay ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

/** "10m", "90s", "2h30m", "1d", a bare number of minutes, or an ISO time. */
export function parseWakeTime(input: string, now = Date.now()): { at: string } | { problem: string } {
	const text = input.trim().toLowerCase();
	if (!text) return { problem: "wake_in is empty" };
	if (/^\d+(\.\d+)?$/.test(text)) return { at: new Date(now + Number(text) * 60_000).toISOString() };
	const parts = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|d|h|m|s)/g)];
	if (parts.length && parts.map((p) => p[0]).join("").replace(/\s+/g, "") === text.replace(/\s+/g, "").replace(/^in/, "")) {
		const unit = (u: string) => (u.startsWith("d") ? 86_400_000 : u.startsWith("h") ? 3_600_000 : u.startsWith("s") ? 1000 : 60_000);
		const ms = parts.reduce((sum, p) => sum + Number(p[1]) * unit(p[2]), 0);
		return { at: new Date(now + ms).toISOString() };
	}
	const parsed = Date.parse(input.trim());
	if (!Number.isNaN(parsed)) {
		if (parsed <= now) return { problem: `${input.trim()} is in the past` };
		return { at: new Date(parsed).toISOString() };
	}
	return { problem: `couldn't read "${input.trim()}" as a time (try 10m, 2h30m, or an ISO time)` };
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

function wakeLabel(wake: Wake, sleepUntil?: string): string {
	if (wake === "on" && sleepUntil) return `sleeping until ${clockTime(sleepUntil)}, then woken each time you finish`;
	return wake === "on" ? "on (woken each time you finish)" : wake === "after_reply" ? "held until the user replies" : "off (notebook only)";
}

/** One history line per event. */
export function renderHistory(goal: Goal, limit?: number): string {
	const events = limit ? goal.history.slice(-limit) : goal.history;
	const lines = events.map((e) => {
		const who = actorLabel(e.by);
		if (e.kind === "start") return `- ${e.at} ${who}: started${e.reason ? ` — ${e.reason}` : ""}`;
		if (e.kind === "end") return `- ${e.at} ${who}: ended ${e.outcome} — ${e.reason}`;
		const head = `- ${e.at} ${who}:${e.reason ? ` ${e.reason}` : ""}`;
		if (e.summary.length === 1 && !e.reason) return `- ${e.at} ${who}: ${e.summary[0]}`;
		return [head, ...e.summary.map((line) => `    - ${line}`)].join("\n");
	});
	const skipped = limit && goal.history.length > limit ? `(${goal.history.length - limit} earlier changes; goal({history: true}) shows all)\n` : "";
	return skipped + lines.join("\n");
}

/**
 * Every change with the values it replaced, for when the details of the
 * history matter. Context records aren't repeated; they're in the goal itself.
 */
export function renderFullHistory(goal: Goal): string {
	const out: string[] = [];
	let before: Goal | undefined;
	const seen: GoalEvent[] = [];
	for (const e of goal.history) {
		const who = actorLabel(e.by);
		if (e.kind === "end") {
			out.push(`## ${e.at} ${who}: ended ${e.outcome}\n${e.reason}`);
		} else if (e.kind === "start") {
			out.push([`## ${e.at} ${who}: started`, e.reason ? `Why: ${e.reason}` : undefined, `Goal: ${e.set.goal}`, e.context ? `(with a context record of ${e.context.length} chars)` : undefined].filter(Boolean).join("\n"));
		} else {
			const parts = [`## ${e.at} ${who}${e.reason ? `: ${e.reason}` : ""}`, ...e.summary.map((line) => `- ${line}`)];
			if (e.set.goal !== undefined && before?.goal !== e.set.goal) parts.push(`Goal was: ${before?.goal}`);
			if (e.set.why !== undefined && before?.why) parts.push(`Why it matters was: ${before.why}`);
			if (e.set.notes !== undefined && before?.notes && !e.notesEdited) parts.push(`Notes were:\n${before.notes}`);
			if (e.set.next !== undefined && before?.next) parts.push(`Next was: ${before.next}`);
			out.push(parts.filter(Boolean).join("\n"));
		}
		seen.push(e);
		before = foldGoal(seen);
	}
	return out.join("\n\n");
}

/** Everything: what the agent sees after compaction or when it asks. */
/** Context records newest-first within a character budget; older ones get their first line. */
function renderContext(records: ContextRecord[], maxChars?: number): string {
	if (!maxChars) return records.map((c) => `--- ${c.at}\n${c.text}`).join("\n");
	const out: string[] = [];
	let used = 0;
	let shortened = 0;
	for (let i = records.length - 1; i >= 0; i--) {
		const c = records[i];
		if (used + c.text.length <= maxChars || out.length === 0) {
			const text = c.text.length > maxChars ? `${c.text.slice(0, maxChars)}\n…[cut here; goal() shows the full record]` : c.text;
			out.unshift(`--- ${c.at}\n${text}`);
			used += text.length;
		} else {
			out.unshift(`--- ${c.at} (shortened)\n${clip(c.text.split("\n")[0] ?? "", 160)}`);
			shortened++;
		}
	}
	return `${out.join("\n")}${shortened ? `\n(${shortened} older record${shortened === 1 ? "" : "s"} shortened to fit; goal() with no arguments shows them all.)` : ""}`;
}

export function renderFull(goal: Goal, now = Date.now(), opts: { maxContextChars?: number } = {}): string {
	const parts = [
		`Goal: ${goal.goal}`,
		goal.why ? `Why: ${goal.why}` : undefined,
		`Waking: ${wakeLabel(goal.wake, goal.sleepUntil)}. Started ${since(goal.startedAt, now)} ago; woken ${goal.wakes} time${goal.wakes === 1 ? "" : "s"}.`,
		goal.ended ? `Ended ${goal.ended.outcome} (${goal.ended.by === "agent" ? "by you" : `by ${goal.ended.by}`}): ${goal.ended.reason}` : undefined,
		goal.steps.length ? `Steps (${stepProgress(goal.steps)}):\n${renderSteps(goal.steps)}` : undefined,
		goal.next ? `Next (your note): ${goal.next}` : undefined,
		goal.notes ? `Notes:\n${goal.notes}` : undefined,
		goal.context.length ? `Context (how this came about):\n${renderContext(goal.context, opts.maxContextChars)}` : undefined,
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
		goal.sleepUntil && goal.wake === "on" ? `Sleeping until ${clockTime(goal.sleepUntil)}; finishing a turn won't wake you before then.` : undefined,
		extras.length ? `You also have ${extras.join(" and ")}; goal() with no arguments shows everything.` : undefined,
	].filter(Boolean).join("\n");
}
