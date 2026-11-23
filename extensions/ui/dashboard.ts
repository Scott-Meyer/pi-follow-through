/**
 * The goal dashboard: a compact box above the editor and an expanded view.
 * The frame, colours, layout modes, task rows and viewport rules are adapted
 * from pi-goal-x's unified dashboard (MIT, github.com/tmonk/pi-goal-x),
 * mapped onto this extension's goal record.
 *
 * Pure presentation: a model in, width-safe lines out.
 */
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Goal, GoalEvent, StepStatus } from "../goal-record.ts";
import { truncateToWidth, wrapTextWithAnsi } from "./text-cache.ts";

type RenderColor = Extract<ThemeColor, "accent" | "warning" | "success" | "error" | "dim" | "muted" | "text" | "mdHeading">;

// ── model ───────────────────────────────────────────────────────────────────

export type DashboardStatusCode = "working" | "on" | "waiting" | "notebook" | "retrying" | "ended";

export interface StepNode {
	id: string;
	title: string;
	status: StepStatus;
	isCurrent: boolean;
}

export interface HistoryItem {
	at: string;
	text: string;
	marker?: "done" | "current" | "skipped";
}

export interface DashboardModel {
	goalId: string;
	title: string;
	why?: string;
	status: { code: DashboardStatusCode; label: string };
	usageBits: string;
	steps: StepNode[];
	progress?: { done: number; total: number; percentage: number };
	current?: StepNode;
	next?: string;
	notes?: string;
	contextCount: number;
	latestContext?: string;
	history: HistoryItem[];
}

export interface LiveState {
	/** The agent is running a turn right now. */
	busy: boolean;
	/** Seconds until an error retry wakes the agent, when one is pending. */
	retryInSeconds?: number;
	/** Tokens spent on the branch since the goal started. */
	tokens: number;
	now?: number;
}

export function formatDuration(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
	if (m > 0) return `${m}m${String(sec).padStart(2, "0")}s`;
	return `${sec}s`;
}

export function formatCompactTokens(value: number): string {
	const safe = Math.max(0, Math.floor(value));
	const trim = (v: string) => v.replace(/\.0$/, "");
	if (safe >= 1_000_000) return `${trim((safe / 1_000_000).toFixed(1))}M`;
	if (safe >= 1_000) return `${trim((safe / 1_000).toFixed(1))}K`;
	return String(safe);
}

function historyText(e: GoalEvent): HistoryItem {
	const who = e.by === "agent" ? "" : `${e.by}: `;
	if (e.kind === "start") return { at: e.at, text: `${who}started${e.reason ? ` — ${e.reason}` : ""}`, marker: "current" };
	if (e.kind === "end") return { at: e.at, text: `${who}ended ${e.outcome} — ${e.reason}`, marker: e.outcome === "done" ? "done" : "skipped" };
	const text = `${who}${e.summary.join("; ")}${e.reason ? ` — ${e.reason}` : ""}`;
	const marker = e.summary.some((s) => s.endsWith("→ done")) ? "done" : e.summary.some((s) => s.endsWith("→ doing")) ? "current" : e.summary.some((s) => s.endsWith("→ dropped")) ? "skipped" : undefined;
	return { at: e.at, text, marker };
}

export function deriveDashboardModel(goal: Goal, live: LiveState): DashboardModel {
	const now = live.now ?? Date.now();
	const doingIndex = goal.steps.findIndex((s) => s.status === "doing");
	const currentIndex = doingIndex >= 0 ? doingIndex : goal.steps.findIndex((s) => s.status === "todo");
	const steps: StepNode[] = goal.steps.map((s, i) => ({ id: String(i + 1), title: s.text, status: s.status, isCurrent: i === currentIndex && !goal.ended }));
	const live_ = goal.steps.filter((s) => s.status !== "dropped");
	const done = live_.filter((s) => s.status === "done").length;
	const progress = goal.steps.length ? { done, total: live_.length, percentage: live_.length ? Math.round((done / live_.length) * 100) : 100 } : undefined;

	let status: DashboardModel["status"];
	if (goal.ended) status = { code: "ended", label: goal.ended.outcome };
	else if (live.retryInSeconds !== undefined) status = { code: "retrying", label: `error, waking again in ${formatDuration(live.retryInSeconds)}` };
	else if (goal.wake === "after_reply") status = { code: "waiting", label: "waiting for you" };
	else if (goal.wake === "off") status = { code: "notebook", label: "notebook (waking off)" };
	else if (live.busy) status = { code: "working", label: "working" };
	else status = { code: "on", label: "on · wakes after your next message" };

	const elapsed = formatDuration((now - Date.parse(goal.startedAt)) / 1000);
	const usageBits = [elapsed, `${goal.wakes} wake${goal.wakes === 1 ? "" : "s"}`, live.tokens > 0 ? formatCompactTokens(live.tokens) : undefined].filter(Boolean).join(" · ");
	const latest = goal.context.at(-1)?.text;

	return {
		goalId: goal.id,
		title: goal.goal,
		why: goal.why,
		status,
		usageBits,
		steps,
		progress,
		current: currentIndex >= 0 && !goal.ended ? steps[currentIndex] : undefined,
		next: goal.next,
		notes: goal.notes,
		contextCount: goal.context.length,
		latestContext: latest,
		history: goal.history.map(historyText).reverse(),
	};
}

// ── viewport rules ──────────────────────────────────────────────────────────

export function maxScrollOffset(totalRows: number, rows: number): number {
	return Math.max(0, totalRows - rows);
}

export function clampScrollOffset(offset: number, totalRows: number, rows: number): number {
	return Math.min(Math.max(0, Math.floor(offset)), maxScrollOffset(totalRows, rows));
}

/** Bottom-anchor the window on the last finished step so recent progress stays in view. */
export function anchoredScrollOffset(nodes: readonly StepNode[], rows: number): number {
	let anchor = -1;
	nodes.forEach((n, i) => {
		if (n.status === "done" || n.isCurrent) anchor = i;
	});
	if (anchor < 0 || rows <= 0) return 0;
	return clampScrollOffset(anchor - (rows - 2), nodes.length, rows);
}

export function compactStepRows(width: number): number {
	if (width >= 100) return 5;
	if (width >= 70) return 4;
	if (width >= 50) return 3;
	return 2;
}

interface Viewport {
	offset: number;
	rows: number;
	hiddenAbove: number;
	hiddenBelow: number;
}

function viewport(totalRows: number, rows: number, offset: number): Viewport {
	const safeRows = Math.max(0, Math.floor(rows));
	const clamped = clampScrollOffset(offset, totalRows, safeRows);
	const visible = Math.min(safeRows, Math.max(0, totalRows - clamped));
	return { offset: clamped, rows: safeRows, hiddenAbove: clamped, hiddenBelow: Math.max(0, totalRows - (clamped + visible)) };
}

// ── frame ───────────────────────────────────────────────────────────────────

const H = "─";
const V = "│";

function frame(theme: Theme, value: string): string {
	return theme.fg("muted", value);
}

function fit(value: string, width: number): string {
	return visibleWidth(value) > width ? truncateToWidth(value, width, "…") : value;
}

function boxHeader(theme: Theme, width: number, left: string, right = ""): string {
	const inner = Math.max(4, width - 2);
	const l = `${frame(theme, H)} ${left}`;
	const r = right ? ` ${right} ${frame(theme, H)}` : "";
	const fixed = visibleWidth(l) + visibleWidth(r);
	if (fixed > inner - 2) {
		const budget = Math.max(4, inner - visibleWidth(r) - 4);
		const l2 = `${frame(theme, H)} ${fit(left, budget)}`;
		const fill = Math.max(1, inner - visibleWidth(l2) - visibleWidth(r));
		return `${frame(theme, "╭")}${l2}${frame(theme, H.repeat(fill))}${r}${frame(theme, "╮")}`;
	}
	const fill = Math.max(1, inner - fixed);
	return `${frame(theme, "╭")}${l}${frame(theme, H.repeat(fill))}${r}${frame(theme, "╮")}`;
}

function boxLine(theme: Theme, width: number, content: string): string {
	const inner = Math.max(2, width - 2);
	const contentFit = fit(content, inner - 1);
	const pad = Math.max(0, inner - 1 - visibleWidth(contentFit));
	return `${frame(theme, V)} ${contentFit}${" ".repeat(pad)}${frame(theme, V)}`;
}

function boxSectionRule(theme: Theme, width: number, label: string, right = ""): string {
	const inner = Math.max(4, width - 2);
	const left = frame(theme, `${H} ${label} `);
	const r = right ? ` ${right} ` : "";
	let l = left;
	if (visibleWidth(left) + visibleWidth(r) > inner) {
		const budget = Math.max(4, inner - visibleWidth(r) - 3);
		l = frame(theme, `${H} ${fit(label, budget)} `);
	}
	const fill = Math.max(0, inner - visibleWidth(l) - visibleWidth(r));
	return `${frame(theme, "├")}${l}${frame(theme, H.repeat(fill))}${r}${frame(theme, "┤")}`;
}

function boxFooter(theme: Theme, width: number, content: string, right = ""): string {
	const inner = Math.max(4, width - 2);
	const r = right ? ` ${right} ${frame(theme, H)}` : "";
	if (!content && !r) return frame(theme, `╰${H.repeat(inner)}╯`);
	const l = content ? frame(theme, `${H} ${fit(content, Math.max(0, inner - 4 - visibleWidth(r)))}`) : "";
	const fill = Math.max(1, inner - visibleWidth(l) - visibleWidth(r));
	return `${frame(theme, "╰")}${l}${frame(theme, H.repeat(fill))}${r}${frame(theme, "╯")}`;
}

const STATUS_COLOR: Record<DashboardStatusCode, RenderColor> = {
	working: "accent",
	on: "accent",
	waiting: "mdHeading",
	notebook: "muted",
	retrying: "warning",
	ended: "success",
};

function statusLine(theme: Theme, model: DashboardModel): string {
	const usage = model.usageBits ? ` [${model.usageBits}]` : "";
	return `${theme.fg(STATUS_COLOR[model.status.code], `goal: ${model.status.label}`)}${theme.fg("muted", usage)}`;
}

function progressBar(theme: Theme, pct: number, barWidth: number): string {
	const safeBar = Math.max(2, barWidth);
	const filled = Math.min(safeBar, Math.max(0, Math.round((pct / 100) * safeBar)));
	return `[${theme.fg("muted", "█".repeat(filled))}${theme.fg("dim", "░".repeat(safeBar - filled))}]`;
}

type LayoutMode = "wide" | "medium" | "narrow" | "minimal";

function layoutMode(width: number): LayoutMode {
	if (width >= 100) return "wide";
	if (width >= 70) return "medium";
	if (width >= 50) return "narrow";
	return "minimal";
}

function headerBarWidth(mode: LayoutMode): number {
	return mode === "wide" ? 8 : mode === "medium" ? 6 : mode === "narrow" ? 5 : 4;
}

function stepMarker(node: StepNode): { symbol: string; color: RenderColor } {
	if (node.isCurrent) return { symbol: "▸", color: "accent" };
	if (node.status === "done") return { symbol: "✓", color: "success" };
	if (node.status === "dropped") return { symbol: "~", color: "muted" };
	return { symbol: "·", color: "mdHeading" };
}

function stepRows(theme: Theme, nodes: StepNode[], view: Viewport, available: number): string[] {
	const rows: string[] = [];
	if (view.hiddenAbove > 0) rows.push(theme.fg("muted", `↑ ${view.hiddenAbove} more step${view.hiddenAbove === 1 ? "" : "s"}`));
	const shown = nodes.slice(view.offset, view.offset + view.rows);
	const idWidth = shown.length === 0 ? 0 : Math.max(...shown.map((n) => n.id.length));
	for (const node of shown) {
		const marker = stepMarker(node);
		const id = node.id.padStart(idWidth);
		const prefix = `${marker.symbol} ${id}  `;
		const title = fit(node.title, Math.max(4, available - visibleWidth(prefix)));
		const idText = node.isCurrent ? theme.fg("accent", id) : theme.fg(marker.color, id);
		const body = node.isCurrent ? theme.fg("accent", title) : node.status === "dropped" ? theme.fg("muted", title) : theme.fg("mdHeading", title);
		rows.push(`${theme.fg(marker.color, marker.symbol)} ${idText}  ${body}`);
	}
	if (view.hiddenBelow > 0) rows.push(theme.fg("muted", `… +${view.hiddenBelow} more step${view.hiddenBelow === 1 ? "" : "s"}`));
	return rows;
}

function wrapped(theme: Theme, width: number, label: string, text: string, color: RenderColor = "text"): string[] {
	const inner = Math.max(4, width - 2);
	const prefix = label ? `${label}  ` : "";
	const indent = " ".repeat(visibleWidth(prefix));
	const out: string[] = [];
	const paragraphs = text.split("\n");
	let first = true;
	for (const para of paragraphs) {
		const segments = para.trim() ? wrapTextWithAnsi(para.trimEnd(), Math.max(8, inner - 1 - visibleWidth(prefix))) : [""];
		for (const seg of segments) {
			out.push(boxLine(theme, width, `${first ? theme.fg("muted", prefix) : indent}${theme.fg(color, seg)}`));
			first = false;
		}
	}
	return out;
}

const BRAND = "goal";

// ── compact ─────────────────────────────────────────────────────────────────

export interface CompactOptions {
	scrollOffset?: number;
	expandKey: string;
	scrollKeys: string;
}

export function renderCompact(model: DashboardModel, theme: Theme, width: number, opts: CompactOptions): string[] {
	const safeWidth = Math.max(10, width);
	const mode = layoutMode(safeWidth);
	const inner = safeWidth - 2;
	const lines: string[] = [];

	lines.push(boxHeader(theme, safeWidth, `${theme.fg("accent", BRAND)} ${frame(theme, `─ ${model.title} `)}`));
	lines.push(boxLine(theme, safeWidth, statusLine(theme, model)));

	const rows = compactStepRows(safeWidth);
	const overflows = model.steps.length > rows;
	if (model.steps.length > 0 && model.progress) {
		const offset = opts.scrollOffset ?? anchoredScrollOffset(model.steps, rows);
		const view = viewport(model.steps.length, rows, offset);
		const label = `Steps · ✓${model.progress.done} done · ${model.progress.total - model.progress.done} open`;
		lines.push(boxSectionRule(theme, safeWidth, label, progressBar(theme, model.progress.percentage, headerBarWidth(mode))));
		for (const row of stepRows(theme, model.steps, view, inner)) lines.push(boxLine(theme, safeWidth, row));
		if (model.current) {
			const budget = inner - visibleWidth(`Current  ${model.current.id} · `);
			lines.push(mode === "minimal"
				? boxLine(theme, safeWidth, `${theme.fg("accent", "▸")} ${theme.fg("accent", fit(model.current.title, inner - 3))}`)
				: boxLine(theme, safeWidth, `${theme.fg("muted", "Current")}  ${theme.fg("accent", model.current.id)} · ${theme.fg("accent", fit(model.current.title, budget))}`));
		} else if (model.progress.done === model.progress.total) {
			lines.push(boxLine(theme, safeWidth, `${theme.fg("muted", "Current")}  ${theme.fg("accent", "All steps done")}`));
		}
	}

	if (model.next && mode !== "minimal") lines.push(boxLine(theme, safeWidth, `${theme.fg("muted", "Next")}     ${fit(model.next.replace(/\s+/g, " "), inner - 10)}`));
	if (mode !== "minimal" && (model.notes || model.contextCount)) {
		const bits = [
			model.notes ? `${model.notes.split("\n").filter((l) => l.trim()).length} lines of notes` : undefined,
			model.contextCount ? `${model.contextCount} context record${model.contextCount === 1 ? "" : "s"}` : undefined,
		].filter(Boolean).join(" · ");
		lines.push(boxLine(theme, safeWidth, theme.fg("dim", `Notebook ${bits}`)));
	}

	const hint = overflows
		? mode === "wide" || mode === "medium" ? `${opts.expandKey}: expand · ${opts.scrollKeys}: scroll` : `${opts.scrollKeys}: scroll`
		: mode === "wide" || mode === "medium" ? `${opts.expandKey}: expand goal` : `${opts.expandKey}: expand`;
	lines.push(boxFooter(theme, safeWidth, hint));
	return lines;
}

// ── expanded ────────────────────────────────────────────────────────────────

/** The expanded body, unframed at top and bottom; the widget scrolls it. */
export function renderExpandedBody(model: DashboardModel, theme: Theme, width: number): string[] {
	const safeWidth = Math.max(10, width);
	const mode = layoutMode(safeWidth);
	const inner = safeWidth - 2;
	const lines: string[] = [];

	lines.push(boxLine(theme, safeWidth, statusLine(theme, model)));
	lines.push(...wrapped(theme, safeWidth, "Goal", model.title, "text"));
	if (model.why) lines.push(...wrapped(theme, safeWidth, "Why ", model.why, "muted"));

	if (model.steps.length > 0 && model.progress) {
		const bar = progressBar(theme, model.progress.percentage, mode === "wide" ? 34 : mode === "medium" ? 26 : 16);
		lines.push(boxSectionRule(theme, safeWidth, "Steps", `${bar} ${theme.fg("muted", `${model.progress.done}/${model.progress.total} · ${model.progress.percentage}%`)}`));
		for (const row of stepRows(theme, model.steps, viewport(model.steps.length, model.steps.length, 0), inner)) lines.push(boxLine(theme, safeWidth, row));
	}

	if (model.next) {
		lines.push(boxSectionRule(theme, safeWidth, "Next"));
		lines.push(...wrapped(theme, safeWidth, "", model.next));
	}
	if (model.notes) {
		lines.push(boxSectionRule(theme, safeWidth, "Notes"));
		lines.push(...wrapped(theme, safeWidth, "", model.notes));
	}
	if (model.contextCount) {
		lines.push(boxSectionRule(theme, safeWidth, `Context · ${model.contextCount} record${model.contextCount === 1 ? "" : "s"}`));
		lines.push(...wrapped(theme, safeWidth, "Latest", model.latestContext ?? "", "dim").slice(0, 6));
		lines.push(boxLine(theme, safeWidth, theme.fg("dim", "/goal shows every record in full")));
	}
	if (model.history.length) {
		lines.push(boxSectionRule(theme, safeWidth, "History · newest first"));
		for (const item of model.history.slice(0, 12)) {
			const marker = item.marker === "done" ? { s: "✓", c: "success" as RenderColor } : item.marker === "current" ? { s: "▸", c: "accent" as RenderColor } : item.marker === "skipped" ? { s: "~", c: "mdHeading" as RenderColor } : { s: "·", c: "muted" as RenderColor };
			const time = new Date(item.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
			lines.push(boxLine(theme, safeWidth, `${theme.fg(marker.c, marker.s)} ${theme.fg("dim", time)} ${fit(item.text, inner - 10)}`));
		}
		if (model.history.length > 12) lines.push(boxLine(theme, safeWidth, theme.fg("dim", `… ${model.history.length - 12} earlier changes; /goal history shows all`)));
	}
	return lines;
}

export function renderExpandedFrame(model: DashboardModel, theme: Theme, width: number, footer: string): { header: string; footer: string } {
	const safeWidth = Math.max(10, width);
	return {
		header: boxHeader(theme, safeWidth, `${theme.fg("accent", BRAND)} ${frame(theme, `─ ${model.title} `)}`),
		footer: boxFooter(theme, safeWidth, footer),
	};
}

export function scrollIndicator(theme: Theme, width: number, text: string): string {
	return boxLine(theme, Math.max(10, width), theme.fg("dim", text));
}

export function clampLinesToWidth(lines: string[], width: number): string[] {
	return lines.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line));
}
