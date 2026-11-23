/**
 * The above-editor goal widget and its keys. The stable-height latch, dock
 * measurement, focus check and key handling are adapted from pi-goal-x (MIT,
 * github.com/tmonk/pi-goal-x); they keep the widget from making the terminal
 * jump or wiping scrollback as the goal changes.
 *
 * Keys: Ctrl+Shift+T expands or collapses. Compact: Ctrl+Shift+↑/↓/PgUp/PgDn/
 * Home/End scroll the steps when they overflow. Expanded: ↑/↓/PgUp/PgDn/Home/
 * End scroll, Esc collapses.
 */
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import type { Goal } from "../goal-record.ts";
import {
	anchoredScrollOffset, clampLinesToWidth, clampScrollOffset, compactStepRows, deriveDashboardModel, maxScrollOffset,
	renderCompact, renderExpandedBody, renderExpandedFrame, scrollIndicator, type DashboardModel, type LiveState,
} from "./dashboard.ts";

const WIDGET_KEY = "goal";
const WIDGET_HEIGHT_RESERVE = 6;
const KEYS = {
	toggle: "ctrl+shift+t",
	compact: { up: "ctrl+shift+up", down: "ctrl+shift+down", pageUp: "ctrl+shift+pageUp", pageDown: "ctrl+shift+pageDown", home: "ctrl+shift+home", end: "ctrl+shift+end" },
	expanded: { up: "up", down: "down", pageUp: "pageUp", pageDown: "pageDown", home: "home", end: "end" },
	collapse: "escape",
} as const;
type NavKey = keyof typeof KEYS.compact;

function isKittyRepeatOrRelease(data: string): boolean {
	return data.startsWith("\x1b[") && /^[0-9:;]+:[23][u~ABCDHF]$/.test(data.slice(2));
}

interface HeightLatch { cap?: number; regime?: string; rows?: number; reserve?: number }

/**
 * Keep the rendered height constant within one regime: the first render
 * latches min(natural, cap); growth is head-sliced, shrink is blank-padded.
 * A changing dock height makes the terminal jump to the bottom; this stops it.
 */
function applyStableHeight(lines: string[], terminalRows: number | undefined, latch: HeightLatch, regime: string, reserve: number): string[] {
	if (!terminalRows || terminalRows <= 0) return lines;
	const cap = Math.max(1, terminalRows - reserve);
	if (latch.rows !== terminalRows || latch.reserve !== reserve || latch.regime !== regime) {
		latch.cap = undefined;
		latch.rows = terminalRows;
		latch.reserve = reserve;
		latch.regime = regime;
	}
	if (latch.cap === undefined) latch.cap = Math.min(lines.length, cap);
	if (lines.length > latch.cap) return lines.slice(0, latch.cap);
	if (lines.length < latch.cap) return [...lines, ...Array(latch.cap - lines.length).fill("")];
	return lines;
}

class GoalWidgetComponent implements Component {
	private latch: HeightLatch = {};
	private compactOffset: number | undefined;
	private expandedOffset = 0;
	private lastWidth = 100;
	private lastModel: DashboardModel | undefined;
	private lastAnchorKey = "";

	constructor(private tui: TUI, private theme: Theme, private source: () => { goal: Goal; live: LiveState } | undefined, private isExpanded: () => boolean) {}

	/** Pi copies these app handlers onto any replacement editor; a dialog's editor won't have them. */
	isMainEditorFocused(): boolean | undefined {
		const tui = this.tui as TUI & { getFocusedComponent?: () => Component | null };
		if (typeof tui.getFocusedComponent !== "function") return undefined;
		const focused = tui.getFocusedComponent() as (Component & { onSubmit?: unknown; actionHandlers?: unknown }) | null;
		return !!focused && typeof focused.onSubmit === "function" && focused.actionHandlers instanceof Map && focused.actionHandlers.has("app.clear");
	}

	private model(): DashboardModel | undefined {
		const s = this.source();
		if (!s) return undefined;
		const model = deriveDashboardModel(s.goal, s.live);
		// A new goal or a newly finished step re-anchors the compact view.
		const anchorKey = `${model.goalId}|${model.progress?.done ?? 0}|${model.current?.id ?? ""}`;
		if (anchorKey !== this.lastAnchorKey) {
			this.lastAnchorKey = anchorKey;
			this.compactOffset = undefined;
		}
		this.lastModel = model;
		return model;
	}

	private terminalRows(): number | undefined {
		return (this.tui as unknown as { terminal?: { rows?: number } }).terminal?.rows;
	}

	/** Height of the dock chrome around the widget, so widget + chrome never exceed the terminal. */
	private measureDockReserve(width: number): number | undefined {
		type DockChild = { children?: DockChild[]; render?: (w: number) => string[] };
		const top = (this.tui as unknown as { children?: DockChild[] }).children;
		if (!Array.isArray(top) || top.length < 2) return undefined;
		let dockList: DockChild[] | undefined;
		let container: DockChild | undefined;
		for (const c of top) {
			const kids = Array.isArray(c.children) ? c.children : undefined;
			if (kids?.includes(this as unknown as DockChild)) { dockList = top; container = c; break; }
			const nested = kids?.find((cc) => Array.isArray(cc.children) && cc.children.includes(this as unknown as DockChild));
			if (nested) { dockList = kids; container = nested; break; }
		}
		if (!dockList || !container) return undefined;
		let total = 0;
		for (let i = 0; i < dockList.length; i++) {
			const c = dockList[i];
			if ((dockList === top && i === 0) || c === container || typeof c?.render !== "function") continue;
			try {
				const lines = c.render(width);
				if (Array.isArray(lines)) total += lines.length;
			} catch {
				return undefined;
			}
		}
		return total + 1;
	}

	private expandedRows(width: number): number {
		const rows = this.terminalRows();
		const reserve = this.measureDockReserve(width) ?? WIDGET_HEIGHT_RESERVE;
		// Header + footer + two indicator rows.
		return rows ? Math.max(4, rows - reserve - 4) : 30;
	}

	render(width: number): string[] {
		this.lastWidth = Math.max(1, width);
		const model = this.model();
		if (!model) return [];
		const expanded = this.isExpanded();
		let lines: string[];
		if (expanded) {
			const body = renderExpandedBody(model, this.theme, width);
			const rows = this.expandedRows(width);
			const offset = clampScrollOffset(this.expandedOffset, body.length, rows);
			this.expandedOffset = offset;
			const shown = body.slice(offset, offset + rows);
			const scrollable = body.length > rows;
			const f = renderExpandedFrame(model, this.theme, width, scrollable ? "Esc/Ctrl+Shift+T: collapse · ↑↓ PgUp/PgDn: scroll" : "Esc/Ctrl+Shift+T: collapse");
			lines = [
				f.header,
				...(offset > 0 ? [scrollIndicator(this.theme, width, `↑ ${offset} more line${offset === 1 ? "" : "s"}`)] : []),
				...shown,
				...(offset + rows < body.length ? [scrollIndicator(this.theme, width, `… +${body.length - offset - rows} more lines`)] : []),
				f.footer,
			];
		} else {
			lines = renderCompact(model, this.theme, width, { scrollOffset: this.compactOffset, expandKey: "Ctrl+Shift+T", scrollKeys: "Ctrl+Shift+↑↓" });
		}
		lines = clampLinesToWidth(lines, width);
		const regime = [model.goalId, model.status.code, String(expanded), String(model.steps.length > 0)].join("|");
		const reserve = this.measureDockReserve(width) ?? WIDGET_HEIGHT_RESERVE;
		return applyStableHeight(lines, this.terminalRows(), this.latch, regime, reserve);
	}

	/** Compact: scroll the steps only when they overflow, so short lists never swallow keys. */
	handleCompactKey(key: NavKey): boolean {
		const model = this.lastModel ?? this.model();
		if (!model || this.isExpanded()) return false;
		const rows = compactStepRows(this.lastWidth);
		if (model.steps.length <= rows) return false;
		let offset = this.compactOffset ?? anchoredScrollOffset(model.steps, rows);
		offset = this.step(offset, key, model.steps.length, rows);
		this.compactOffset = offset;
		this.tui.requestRender();
		return true;
	}

	/** Expanded: the view is modal, so it owns the navigation keys. */
	handleExpandedKey(key: NavKey): boolean {
		const model = this.lastModel ?? this.model();
		if (!model || !this.isExpanded()) return false;
		const total = renderExpandedBody(model, this.theme, this.lastWidth).length;
		const rows = this.expandedRows(this.lastWidth);
		this.expandedOffset = this.step(this.expandedOffset, key, total, rows);
		this.tui.requestRender();
		return true;
	}

	resetExpanded() {
		this.expandedOffset = 0;
	}

	private step(offset: number, key: NavKey, total: number, rows: number): number {
		const page = Math.max(1, rows - 1);
		const next = key === "up" ? offset - 1 : key === "down" ? offset + 1 : key === "pageUp" ? offset - page : key === "pageDown" ? offset + page : key === "home" ? 0 : maxScrollOffset(total, rows);
		return clampScrollOffset(next, total, rows);
	}

	invalidate(): void {
		this.tui.requestRender();
	}
}

/**
 * Owns the widget's lifetime for one session runtime. `sync` shows, updates
 * or removes it as the goal changes; it is cheap to call often.
 */
export class GoalDashboard {
	private component: GoalWidgetComponent | undefined;
	private shownFor: string | undefined;
	private expanded = false;
	private unsubscribe: (() => void) | undefined;
	private ticker: ReturnType<typeof setInterval> | undefined;

	constructor(private source: () => { goal: Goal; live: LiveState } | undefined) {}

	sync(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		try {
			const s = this.source();
			const id = s ? s.goal.id : undefined;
			if (!id) {
				if (this.shownFor) ctx.ui.setWidget(WIDGET_KEY, undefined);
				this.shownFor = undefined;
				this.component = undefined;
				this.expanded = false;
				this.stopTicker();
				return;
			}
			if (this.shownFor !== id || !this.component) {
				this.shownFor = id;
				ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
					this.component = new GoalWidgetComponent(tui, theme, this.source, () => this.expanded);
					return this.component;
				});
				this.listen(ctx);
			} else {
				this.component.invalidate();
			}
			// Keep the elapsed time live while the agent works.
			if (s?.live.busy || s?.live.retryInSeconds !== undefined) this.startTicker();
			else this.stopTicker();
		} catch {
			// stale ctx after reload; the new runtime draws its own widget
		}
	}

	private startTicker() {
		if (this.ticker) return;
		this.ticker = setInterval(() => this.component?.invalidate(), 1000);
		this.ticker.unref?.();
	}

	private stopTicker() {
		if (this.ticker) clearInterval(this.ticker);
		this.ticker = undefined;
	}

	private listen(ctx: ExtensionContext) {
		this.unsubscribe?.();
		this.unsubscribe = ctx.ui.onTerminalInput((data) => {
			const component = this.component;
			if (!component || !this.shownFor) return undefined;
			if (component.isMainEditorFocused() === false) return undefined;
			const ours = (key: string) => matchesKey(data, key as Parameters<typeof matchesKey>[1]);
			if (isKittyRepeatOrRelease(data)) {
				const active = [KEYS.toggle, ...Object.values(this.expanded ? KEYS.expanded : KEYS.compact), ...(this.expanded ? [KEYS.collapse] : [])];
				return active.some(ours) ? { consume: true } : undefined;
			}
			if (ours(KEYS.toggle)) {
				this.expanded = !this.expanded;
				component.resetExpanded();
				component.invalidate();
				return { consume: true };
			}
			if (this.expanded) {
				if (ours(KEYS.collapse)) {
					this.expanded = false;
					component.invalidate();
					return { consume: true };
				}
				for (const [name, key] of Object.entries(KEYS.expanded)) if (ours(key) && component.handleExpandedKey(name as NavKey)) return { consume: true };
				return undefined;
			}
			for (const [name, key] of Object.entries(KEYS.compact)) if (ours(key) && component.handleCompactKey(name as NavKey)) return { consume: true };
			return undefined;
		});
	}

	dispose() {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.stopTicker();
		this.component = undefined;
		this.shownFor = undefined;
	}
}
