import type { EngineInterface, On, RenderElement } from 'claude-code';
import { canDraw, codeIntel } from './lib';
import type { CodeIntelEnvelope, CodeIntelError } from './lib';
import { MARK, badge, buttonRow, forTheme, kind, palette, status } from './theme';

/**
 * The command's name. Mod commands allow letters, digits, `_` and `-`, so the
 * bare name sits beside the Markdown `/constellation:*` commands, and a name
 * a built-in owns is refused.
 */
export const COMMAND = 'constellation';

/** The id of the pane the command opens; the `requestId` its tree is drawn under. */
const PANE = 'constellation';

const TABS = ['status', 'diagnose', 'deps', 'unused'] as const;
export type Tab = (typeof TABS)[number];
type Direction = 'dependencies' | 'dependents';

const TAB_LABEL: Readonly<Record<Tab, string>> = {
	status: 'Status',
	diagnose: 'Diagnose',
	deps: 'Deps',
	unused: 'Unused',
};

/** Rows a tab draws before it ends with a "+N more" line, and lines the text fallback keeps. */
const MAX_ROWS = 15;
const MAX_TEXT_LINES = 6;

/** One thing a tab shows: a line of text, optionally led by a status or kind badge. */
export type Item = {
	badge?: { kind: 'status' | 'kind'; value: string };
	text: string;
	/** A file the person can pick: drawn as a pressable row. */
	path?: string;
	/** Secondary text: drawn with `dimColor`. */
	dim?: boolean;
	/** A group title, such as a file in the unused list. */
	heading?: boolean;
};

export type Summary = {
	/** The same facts as plain lines, for the text fallback. */
	lines: string[];
	items: Item[];
	error?: CodeIntelError;
};

export type SummaryOptions = {
	direction?: Direction;
	path?: string;
	project?: string;
};

/**
 * The tab and file path a command's arguments select: the first word names
 * the tab (default status) and, for deps, the rest is the file path.
 */
export function parseArgs(args: string): { tab: Tab; path?: string } {
	const trimmed = args.trim();
	const split = trimmed.search(/\s/);
	const word = (split === -1 ? trimmed : trimmed.slice(0, split)).toLowerCase();
	const tab = TABS.find((t) => t === word);
	if (tab === undefined) return { tab: 'status' };
	const rest = split === -1 ? '' : trimmed.slice(split).trim();
	return tab === 'deps' && rest !== '' ? { tab, path: rest } : { tab };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value !== '' ? value : undefined;
}

function count(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function lineOf(item: Item): string {
	if (item.badge?.kind === 'status') return `${item.text}: ${status(item.badge.value).word}`;
	if (item.badge?.kind === 'kind') return `  ${item.text} (${kind(item.badge.value).word})`;
	return item.text;
}

function fromItems(items: Item[]): Summary {
	return { lines: items.map(lineOf), items };
}

function failure(error: CodeIntelError): Summary {
	const message = error.message ?? 'The request failed';
	const guidance = error.guidance ?? [];
	return {
		lines: [`${error.code}: ${message}`, ...guidance],
		items: [
			{ badge: { kind: 'status', value: 'error' }, text: `${error.code}: ${message}` },
			...guidance.map((g): Item => ({ text: g, dim: true })),
		],
		error,
	};
}

function capped(items: Item[]): Item[] {
	if (items.length <= MAX_ROWS) return items;
	return [...items.slice(0, MAX_ROWS), { text: `+${items.length - MAX_ROWS} more`, dim: true }];
}

function connection(result: unknown): Item[] {
	const pong = isRecord(result) && result['pong'] === true;
	return [
		{ badge: { kind: 'status', value: pong ? 'healthy' : 'unknown' }, text: 'connection' },
		{ badge: { kind: 'status', value: pong ? 'healthy' : 'unknown' }, text: 'auth' },
	];
}

function statusItems(result: unknown, project: string | undefined): Item[] {
	return [...connection(result), ...(project === undefined ? [] : [{ text: `project ${project}` }])];
}

function diagnoseItems(result: unknown): Item[] {
	const ping = isRecord(result) ? result['ping'] : undefined;
	const caps = isRecord(result) && isRecord(result['caps']) ? result['caps'] : {};
	const indexed = caps['isIndexed'];
	const items = connection(ping);
	items.push({
		badge: { kind: 'status', value: indexed === true ? 'indexed' : indexed === false ? 'stale' : 'unknown' },
		text: indexed === false ? 'index (not indexed)' : 'index',
	});
	const languages = caps['languages'] ?? caps['supportedLanguages'];
	if (Array.isArray(languages) && languages.length > 0) {
		items.push({ text: `languages ${languages.filter((l) => typeof l === 'string').join(', ')}` });
	}
	const symbols = count(caps['symbolCount']);
	if (symbols !== undefined) items.push({ text: `${symbols} symbols` });
	const files = count(caps['fileCount']);
	if (files !== undefined) items.push({ text: `${files} files` });
	const branch = text(caps['indexedBranch']);
	if (branch !== undefined) items.push({ text: `branch ${branch}` });
	return items;
}

function depsItems(result: unknown, direction: Direction, path: string | undefined): Item[] {
	if (!isRecord(result)) return [{ text: 'No data returned', dim: true }];
	const entries = records(direction === 'dependencies' ? result['directDependencies'] : result['directDependents']);
	const rows: Item[] = [];
	for (const entry of entries) {
		const file = text(entry['filePath']);
		if (file !== undefined) rows.push({ text: file, path: file });
		else {
			const module = text(entry['moduleName']);
			if (module !== undefined) rows.push({ text: module, dim: true });
		}
	}
	const label = direction === 'dependencies' ? 'depends on' : 'is used by';
	const header: Item = { text: `${path ?? text(result['file']) ?? 'file'} ${label} ${rows.length}`, heading: true };
	return rows.length === 0
		? [header, { text: direction === 'dependencies' ? 'No dependencies found' : 'No dependents found', dim: true }]
		: [header, ...capped(rows)];
}

function unusedItems(result: unknown): Item[] {
	if (!isRecord(result)) return [{ text: 'No data returned', dim: true }];
	const symbols = records(result['orphanedSymbols']);
	if (symbols.length === 0) return [{ text: 'No unused symbols found', dim: true }];
	const byFile = new Map<string, Record<string, unknown>[]>();
	for (const symbol of symbols) {
		const file = text(symbol['filePath']) ?? 'unknown file';
		byFile.set(file, [...(byFile.get(file) ?? []), symbol]);
	}
	const summary = isRecord(result['summary']) ? result['summary'] : {};
	const total = count(summary['totalOrphanedSymbols']) ?? symbols.length;
	const items: Item[] = [{ text: `${total} unused symbols`, heading: true }];
	for (const [file, group] of byFile) {
		items.push({ text: file, dim: true });
		for (const symbol of group) {
			items.push({ badge: { kind: 'kind', value: text(symbol['kind']) ?? 'unknown' }, text: text(symbol['name']) ?? 'unnamed' });
		}
	}
	return capped(items);
}

/**
 * The facts of one tab from its code_intel envelope, shared by the pane and
 * the text fallback: `items` carry the badges and rows the pane draws and
 * `lines` the same facts as plain text. The envelope's `result` is untyped, so
 * each field is narrowed against the executor schemas before it is read; on
 * error the code, message and guidance are returned.
 */
export function summarize(tab: Tab, envelope: CodeIntelEnvelope, options: SummaryOptions = {}): Summary {
	if (!envelope.success) return failure(envelope.error ?? { code: 'UNKNOWN', message: 'The request failed' });
	const { result } = envelope;
	switch (tab) {
		case 'status':
			return fromItems(statusItems(result, options.project));
		case 'diagnose':
			return fromItems(diagnoseItems(result));
		case 'deps':
			return fromItems(depsItems(result, options.direction ?? 'dependencies', options.path));
		case 'unused':
			return fromItems(unusedItems(result));
	}
}

/** How long ago `iso` was, in the largest whole unit, from plain Date math. */
function relative(iso: string): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return iso;
	const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
	if (seconds < 60) return 'just now';
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

function metadata(envelope: CodeIntelEnvelope | undefined): string | undefined {
	const parts: string[] = [];
	if (envelope?.asOfCommit) parts.push(`as of ${envelope.asOfCommit.slice(0, 7)}`);
	if (envelope?.lastIndexedAt) parts.push(`indexed ${relative(envelope.lastIndexedAt)}`);
	return parts.length === 0 ? undefined : parts.join(' · ');
}

function codeFor(tab: Tab, direction: Direction, path: string): string {
	switch (tab) {
		case 'status':
			return 'return await api.ping()';
		case 'diagnose':
			return 'const [ping, caps] = await Promise.all([api.ping(), api.getCapabilities()]); return { ping, caps }';
		case 'deps':
			return `return await api.${direction === 'dependencies' ? 'getDependencies' : 'getDependents'}({ filePath: ${JSON.stringify(path)} })`;
		case 'unused':
			return 'return await api.findOrphanedCode({})';
	}
}

// The pane's state: module variables, lost on a hot reload, so every read has a default.
let selected: Tab = 'status';
let light = false;
let depsPath = '';
let depsDirection: Direction = 'dependencies';
let sessionCwd: string | undefined;
const cache = new Map<Tab, CodeIntelEnvelope>();
const pending = new Set<Tab>();
const generations = new Map<Tab, number>();

function drop(tab: Tab): void {
	cache.delete(tab);
	pending.delete(tab);
	generations.set(tab, (generations.get(tab) ?? 0) + 1);
}

function reset(): void {
	for (const tab of TABS) drop(tab);
	selected = 'status';
	depsPath = '';
	depsDirection = 'dependencies';
	sessionCwd = undefined;
}

/**
 * Runs the tab's query and caches the envelope. A result that lands after its
 * tab was dropped (refresh, a new path, the pane closing) is discarded. The
 * redraw is asked for once the envelope is cached.
 */
async function runQuery($: EngineInterface, tab: Tab): Promise<void> {
	const generation = generations.get(tab) ?? 0;
	pending.add(tab);
	let envelope: CodeIntelEnvelope;
	try {
		const cwd = sessionCwd ?? (await $.session.cwd());
		envelope = await codeIntel(
			{ connect: (s) => $.mcp.connect(s), call: (s, t, a) => $.mcp.call(s, t, a) },
			codeFor(tab, depsDirection, depsPath),
			{ cwd },
		);
	} catch (error) {
		envelope = { success: false, error: { code: 'MCP_CALL_FAILED', message: error instanceof Error ? error.message : String(error) } };
	}
	if ((generations.get(tab) ?? 0) !== generation) return;
	pending.delete(tab);
	cache.set(tab, envelope);
	$.ui.invalidate('ui.render');
}

function projectName(cwd: string | undefined): string | undefined {
	return cwd?.replace(/\\/g, '/').split('/').filter(Boolean).pop();
}

export function registerCommand(on: On): void {
	on('session.start', async ($, e, next) => {
		const r = await next(e);
		try {
			await $.command.register({
				name: COMMAND,
				description: 'Constellation status, diagnose, deps and unused code',
				argumentHint: '[status|diagnose|deps <file>|unused]',
				immediate: true,
			});
		} catch {
			// Registration refused: the Markdown commands still work.
		}
		return r;
	});

	on('command.run', { command: COMMAND }, async ($, e) => {
		const { tab, path } = parseArgs(e.args);
		const cwd = await $.session.cwd();
		if (!canDraw(await $.session.surfaces())) {
			if (tab === 'deps' && path === undefined) return { text: 'Usage: /constellation deps <file>' };
			const envelope = await codeIntel(
				{ connect: (s) => $.mcp.connect(s), call: (s, t, a) => $.mcp.call(s, t, a) },
				codeFor(tab, 'dependencies', path ?? ''),
				{ cwd },
			);
			const summary = summarize(tab, envelope, { path, project: projectName(cwd) });
			const meta = metadata(envelope);
			const body = [...summary.lines.slice(0, MAX_TEXT_LINES), ...(meta === undefined ? [] : [meta])];
			return { text: [`${MARK} Constellation ${tab}`, ...body.map((l) => `- ${l.trim()}`)].join('\n') };
		}
		reset();
		selected = tab;
		depsPath = path ?? '';
		sessionCwd = cwd;
		try {
			const theme = (await $.config.list()).find((r) => r.key === 'theme');
			light = typeof theme?.value === 'string' && theme.value.startsWith('light');
		} catch {
			light = false;
		}
		await $.ui.open({ id: PANE, title: 'Constellation', focus: true, closeOnEscape: true });
		$.ui.invalidate('ui.render');
		return {};
	});

	on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
		if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e);
		const el = $.ui.resolve(e);
		const envelope = cache.get(selected);
		const needsPath = selected === 'deps' && depsPath === '';
		if (envelope === undefined && !pending.has(selected) && !needsPath) void runQuery($, selected);
		const isPending = pending.has(selected);

		const noop = (): void => {};
		const summary = envelope === undefined ? undefined : summarize(selected, envelope, { direction: depsDirection, path: depsPath, project: projectName(sessionCwd) });

		const body: RenderElement[] = [];
		if (selected === 'deps') {
			body.push(
				el.Input({ key: 'deps-path', label: 'File', value: depsPath, placeholder: 'path/to/file.ts', submitLabel: 'show', onSubmit: noop }),
				el.Button({
					key: 'deps-toggle',
					label: depsDirection === 'dependencies' ? 'Showing dependencies (switch to dependents)' : 'Showing dependents (switch to dependencies)',
					plain: true,
					onPress: noop,
				}),
			);
		}
		if (summary !== undefined) {
			for (const item of summary.items) {
				if (item.path !== undefined) {
					body.push(el.Button({ key: `dep:${item.path}`, label: item.path, plain: true, onPress: noop }));
				} else if (item.badge?.kind === 'status') {
					body.push(badge(el, item.text, forTheme(status(item.badge.value), light)));
				} else if (item.badge?.kind === 'kind') {
					body.push(badge(el, item.text, forTheme(kind(item.badge.value), light)));
				} else if (item.heading) {
					body.push(el.Text({ bold: true, children: item.text }));
				} else {
					body.push(el.Text(item.dim ? { dimColor: true, children: item.text } : { children: item.text }));
				}
			}
		} else if (isPending) {
			body.push(badge(el, 'querying Constellation', forTheme(status('pending'), light)));
		} else if (needsPath) {
			body.push(el.Text({ dimColor: true, children: 'Enter a file path to see its dependencies.' }));
		}

		const meta = metadata(envelope);
		const tabs = TABS.map((tab, index) =>
			el.Button({
				key: `tab-${tab}`,
				label: tab === selected ? `▸ ${TAB_LABEL[tab]}` : TAB_LABEL[tab],
				hotkey: String(index + 1),
				plain: true,
				onPress: noop,
			}),
		);

		return el.Box({
			flexDirection: 'column',
			padding: 1,
			gap: 1,
			children: [
				el.Box({
					flexDirection: 'row',
					columnGap: 1,
					children: [el.Text({ color: palette.nebula, children: MARK }), el.Text({ bold: true, children: 'Constellation' })],
				}),
				...(meta === undefined ? [] : [el.Text({ dimColor: true, children: meta })]),
				el.Box({ flexDirection: 'row', columnGap: 2, children: tabs }),
				el.Box({ flexDirection: 'column', children: body }),
				buttonRow(el, { key: 'close', label: 'Close' }, { key: 'refresh', label: 'Refresh', hotkey: 'r' }),
			],
		});
	});

	on('ui.press', { requestId: PANE }, async ($, e) => {
		const element = e.element;
		const tab = TABS.find((t) => `tab-${t}` === element);
		if (element === 'close') {
			await $.ui.close({ id: PANE });
			return { element };
		}
		if (tab !== undefined) selected = tab;
		else if (element === 'refresh') drop(selected);
		else if (element === 'deps-toggle') {
			depsDirection = depsDirection === 'dependencies' ? 'dependents' : 'dependencies';
			drop('deps');
		} else if (element.startsWith('dep:')) {
			depsPath = element.slice('dep:'.length);
			drop('deps');
		}
		$.ui.invalidate('ui.render');
		return { element };
	});

	on('ui.input', { requestId: PANE, element: 'deps-path', kind: 'submit' }, async ($, e) => {
		depsPath = e.value.trim();
		drop('deps');
		$.ui.invalidate('ui.render');
		return { element: e.element, value: e.value };
	});

	on('ui.close', { id: PANE }, async (_$, e, next) => {
		const r = await next(e);
		reset();
		return r;
	});
}
