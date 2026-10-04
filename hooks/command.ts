import type { ElementTable, EngineInterface, On, PluginOptions, RenderElement } from 'claude-code';
import { canDraw, codeIntel } from './lib';
import type { CodeIntelEnvelope, CodeIntelError } from './lib';
import { explain, explainLines } from './explain';
import { askText, callTree, detailLines, drillCode, hits, impactView, rankExact, searchCode, usageLines, where } from './explore';
import type { Hit } from './explore';
import { byFile, location, orphanCode, orphanPage, removalPrompt } from './unused';
import type { OrphanRow } from './unused';
import type { Explanation } from './explain';
import { BANNER_WIDTH, PROMPT, badge, buttonRow, forTheme, header, kind, paint, palette, risk, scheme, status } from './theme';
import type { Scheme } from './theme';

/**
 * The command's name. Mod commands allow letters, digits, `_` and `-`, so the
 * bare name sits beside the Markdown `/constellation:*` commands, and a name
 * a built-in owns is refused.
 */
export const COMMAND = 'constellation';

/** The id of the pane the command opens; the `requestId` its tree is drawn under. */
const PANE = 'constellation';

const TABS = ['status', 'diagnose', 'deps', 'unused', 'explore'] as const;
export type Tab = (typeof TABS)[number];
type Direction = 'dependencies' | 'dependents';

const TAB_LABEL: Readonly<Record<Tab, string>> = {
	status: 'Status',
	diagnose: 'Diagnose',
	deps: 'Deps',
	unused: 'Unused',
	explore: 'Explore',
};

/** One line under the tab row saying what the tab shows. */
const TAB_HINT: Readonly<Record<Tab, string>> = {
	status: 'Whether Constellation is reachable and your access key is accepted.',
	diagnose: 'What the Constellation index holds for this project.',
	deps: 'What a file imports, or what imports it.',
	unused: 'Exports nothing imports. Verify each one before deleting it.',
	explore: 'Search the graph and drill into a symbol without a Claude turn.',
};

/** The column a labeled row's value starts in. */
const LABEL_WIDTH = 13;

/** Rows a tab draws before it ends with a "+N more" line, and lines the text fallback keeps. */
const MAX_ROWS = 15;
const MAX_TEXT_LINES = 6;
/** Hits the explorer lists in the pane, and the fewer the text fallback keeps. */
const EXPLORE_ROWS = 20;
const EXPLORE_TEXT_HITS = 5;

/** One thing a tab shows: a line of text, optionally led by a status or kind badge, or a labeled value. */
export type Item = {
	/** The name of a fact (`Connection`, `Symbols`): drawn dim in a fixed column, with the value after it. */
	label?: string;
	badge?: { kind: 'status' | 'kind'; value: string };
	text: string;
	/** A file the person can pick: drawn as a pressable row. */
	path?: string;
	/** A project root the person can pick when the working directory is not one: a pressable row. */
	project?: string;
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
	/** The error laid out for a person, which the pane and the text reply draw in place of `items`. */
	explanation?: Explanation;
};

export type SummaryOptions = {
	direction?: Direction;
	path?: string;
	project?: string;
	/** The symbol the explorer searched for, which ranks its exact matches first. */
	query?: string;
};

/**
 * The tab, file path and kind a command's arguments select: the first word
 * names the tab (default status), for deps the rest is the file path, and for
 * unused the next word (or `--kind <k>`) is the kind to list, and for explore the
 * rest is the symbol to search for.
 */
export function parseArgs(args: string): { tab: Tab; path?: string; kind?: string; query?: string } {
	const trimmed = args.trim();
	const split = trimmed.search(/\s/);
	const word = (split === -1 ? trimmed : trimmed.slice(0, split)).toLowerCase();
	const tab = TABS.find((t) => t === word);
	if (tab === undefined) return { tab: 'status' };
	const rest = split === -1 ? '' : trimmed.slice(split).trim();
	if (tab === 'unused') {
		// `unused function` and `unused --kind function` both name a kind.
		const kind = rest.replace(/^--kind(?:\s+|=)/, '').split(/\s+/)[0]?.toLowerCase();
		return kind === undefined || kind === '' ? { tab } : { tab, kind };
	}
	if (tab === 'explore') return rest === '' ? { tab } : { tab, query: rest };
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

/** Thousands separators for a count, as `3,079`. */
function grouped(n: number): string {
	return n.toLocaleString('en-US');
}

function lineOf(item: Item): string {
	if (item.label !== undefined) {
		const word = item.badge === undefined ? undefined : (item.badge.kind === 'status' ? status(item.badge.value) : kind(item.badge.value)).word;
		const value = word !== undefined && item.text !== '' ? `${word} (${item.text})` : (word ?? item.text);
		return `${item.label}: ${value}`;
	}
	if (item.badge?.kind === 'status') return `${item.text}: ${status(item.badge.value).word}`;
	if (item.badge?.kind === 'kind') return `  ${item.text} (${kind(item.badge.value).word})`;
	return item.text;
}

function fromItems(items: Item[]): Summary {
	return { lines: items.map(lineOf), items };
}

function failure(error: CodeIntelError): Summary {
	const explanation = explain(error);
	const candidates = error.candidates ?? [];
	// With project roots to offer (the working directory sits above several
	// projects), the pane asks for one instead of drawing the error.
	const items: Item[] =
		candidates.length > 0
			? [
					{ text: 'Choose a project', heading: true },
					{ text: 'This folder holds several Constellation projects.', dim: true },
					...candidates.map((c): Item => ({ text: projectName(c) ?? c, project: c })),
				]
			: [];
	return { lines: explainLines(explanation), items, error, explanation };
}

function capped(items: Item[]): Item[] {
	if (items.length <= MAX_ROWS) return items;
	return [...items.slice(0, MAX_ROWS), { text: `+${items.length - MAX_ROWS} more`, dim: true }];
}

function connection(result: unknown): Item[] {
	const pong = isRecord(result) && result['pong'] === true;
	return [
		{ label: 'Connection', badge: { kind: 'status', value: pong ? 'healthy' : 'unknown' }, text: '' },
		{ label: 'Auth', badge: { kind: 'status', value: pong ? 'healthy' : 'unknown' }, text: '' },
	];
}

function statusItems(result: unknown, project: string | undefined): Item[] {
	return [...connection(result), ...(project === undefined ? [] : [{ label: 'Project', text: project }])];
}

function diagnoseItems(result: unknown): Item[] {
	const ping = isRecord(result) ? result['ping'] : undefined;
	const caps = isRecord(result) && isRecord(result['caps']) ? result['caps'] : {};
	const indexed = caps['isIndexed'];
	const items = connection(ping);
	items.push({
		label: 'Index',
		badge: { kind: 'status', value: indexed === true ? 'indexed' : indexed === false ? 'stale' : 'unknown' },
		text: indexed === false ? 'not indexed' : '',
	});
	const languages = caps['languages'] ?? caps['supportedLanguages'];
	if (Array.isArray(languages) && languages.length > 0) {
		items.push({ label: 'Languages', text: languages.filter((l) => typeof l === 'string').join(', ') });
	}
	const symbols = count(caps['symbolCount']);
	if (symbols !== undefined) items.push({ label: 'Symbols', text: grouped(symbols) });
	const files = count(caps['fileCount']);
	if (files !== undefined) items.push({ label: 'Files', text: grouped(files) });
	const branch = text(caps['indexedBranch']);
	if (branch !== undefined) items.push({ label: 'Branch', text: branch });
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
	const items: Item[] = [{ text: `${grouped(total)} unused symbols`, heading: true }];
	for (const [file, group] of byFile) {
		items.push({ text: file, dim: true });
		for (const symbol of group) {
			items.push({ badge: { kind: 'kind', value: text(symbol['kind']) ?? 'unknown' }, text: text(symbol['name']) ?? 'unnamed' });
		}
	}
	return capped(items);
}

/** The top matches of a symbol search as plain lines, exact name first. */
function exploreItems(result: unknown, query: string | undefined): Item[] {
	const found = rankExact(query ?? '', hits(result)).slice(0, EXPLORE_TEXT_HITS);
	if (found.length === 0) return [{ text: 'No symbols match', dim: true }];
	return found.map((h): Item => ({ text: `${kind(h.kind).word} ${h.name} ${where(h)}` }));
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
		case 'explore':
			return fromItems(exploreItems(result, options.query));
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

/**
 * One line about a project for the picker, from its `getCapabilities` envelope:
 * when it was indexed, its languages and its file count.
 */
export function projectDetail(envelope: CodeIntelEnvelope | undefined): string {
	if (envelope === undefined) return '…';
	if (!envelope.success) return envelope.error?.code === 'PROJECT_NOT_INDEXED' ? 'not indexed' : (envelope.error?.code ?? 'unavailable');
	const caps = isRecord(envelope.result) ? envelope.result : {};
	if (caps['isIndexed'] === false) return 'not indexed';
	const parts: string[] = [];
	const indexedAt = text(caps['lastIndexedAt']) ?? envelope.lastIndexedAt;
	if (indexedAt !== undefined) parts.push(`indexed ${relative(indexedAt)}`);
	const languages = caps['supportedLanguages'];
	if (Array.isArray(languages)) {
		const names = languages.filter((l): l is string => typeof l === 'string');
		if (names.length > 0) parts.push(names.join(', '));
	}
	const files = count(caps['fileCount']);
	if (files !== undefined) parts.push(`${files} files`);
	return parts.length === 0 ? 'indexed' : parts.join(' · ');
}

/** The `findOrphanedCode` filter for the kind the command named, if any. */
function unusedFilter(): { filterByKind?: string[] } {
	return unusedKind === undefined ? {} : { filterByKind: [unusedKind] };
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
			return orphanCode(unusedFilter());
		case 'explore':
			return searchCode(exploreQuery);
	}
}

// The pane's state: module variables, lost on a hot reload, so every read has a default.
let selected: Tab = 'status';
let tint: Scheme = 'brand';
let depsPath = '';
let depsDirection: Direction = 'dependencies';
let sessionCwd: string | undefined;
let launchCwd: string | undefined;
/**
 * The project picked when the session's working directory is not a project
 * (a workspace root above several). Kept across pane opens, unlike the rest,
 * and used only while the session is still in `from`.
 */
let chosen: { from: string; root: string } | undefined;
const cache = new Map<Tab, CodeIntelEnvelope>();
const pending = new Set<Tab>();
const generations = new Map<Tab, number>();
/** The picker's per-project `getCapabilities` envelopes, by project root. */
const details = new Map<string, CodeIntelEnvelope>();
const detailsPending = new Set<string>();
/** The kind `/constellation unused <kind>` asked for. Cleared by `reset()` only. */
let unusedKind: string | undefined;
// The unused picker's state, cleared with the tab by `drop('unused')`.
const picked = new Set<string>();
let morePages: OrphanRow[] = [];
let nextOffset: number | undefined;
let loadingMore = false;
let handoffNote: string | undefined;
/** The symbol the explorer searches for. Cleared by `reset()` only, since the search field sets it and then drops the tab. */
let exploreQuery = '';
// The explorer's state, cleared with the tab by `drop('explore')`.
let focusHit: Hit | undefined;
type Section = 'details' | 'usages' | 'impact' | 'calls';
let section: Section = 'details';
const drill = new Map<string, CodeIntelEnvelope>();
const drillPending = new Set<string>();
let exploreNote: string | undefined;

/** The `$.store` key that remembers the project picked in `from`, across sessions. */
function pickKey(from: string): string {
	return `project:${from}`;
}

function drop(tab: Tab): void {
	cache.delete(tab);
	pending.delete(tab);
	generations.set(tab, (generations.get(tab) ?? 0) + 1);
	if (tab === 'unused') {
		picked.clear();
		morePages = [];
		nextOffset = undefined;
		loadingMore = false;
		handoffNote = undefined;
	}
	if (tab === 'explore') {
		focusHit = undefined;
		section = 'details';
		drill.clear();
		drillPending.clear();
		exploreNote = undefined;
	}
}

function reset(): void {
	for (const tab of TABS) drop(tab);
	unusedKind = undefined;
	exploreQuery = '';
	selected = 'status';
	depsPath = '';
	depsDirection = 'dependencies';
	sessionCwd = undefined;
	launchCwd = undefined;
	details.clear();
	detailsPending.clear();
}

/** The directory queries run in: the picked project while the session stays where it was picked. */
function target(cwd: string): string {
	return chosen?.from === cwd ? chosen.root : cwd;
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
		const cwd = sessionCwd ?? target(await $.session.cwd());
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
	if (tab === 'unused' && envelope.success) nextOffset = orphanPage(envelope.result).nextOffset;
	$.ui.invalidate('ui.render');
}

/** Reads one symbol's details, usages, impact and call graph; a result that lands after the explorer was dropped is discarded. */
async function runDrill($: EngineInterface, id: string): Promise<void> {
	drillPending.add(id);
	let envelope: CodeIntelEnvelope;
	try {
		const cwd = sessionCwd ?? target(await $.session.cwd());
		envelope = await codeIntel({ connect: (s) => $.mcp.connect(s), call: (s, t, a) => $.mcp.call(s, t, a) }, drillCode(id), { cwd });
	} catch (error) {
		envelope = { success: false, error: { code: 'MCP_CALL_FAILED', message: error instanceof Error ? error.message : String(error) } };
	}
	if (!drillPending.delete(id)) return;
	drill.set(id, envelope);
	$.ui.invalidate('ui.render');
}

/** Reads the next page of unused exports; a page that lands after the tab was dropped is discarded. */
async function loadMore($: EngineInterface): Promise<void> {
	if (loadingMore || nextOffset === undefined) return;
	const generation = generations.get('unused') ?? 0;
	const code = orphanCode({ ...unusedFilter(), limit: 50, offset: nextOffset });
	loadingMore = true;
	$.ui.invalidate('ui.render');
	let envelope: CodeIntelEnvelope;
	try {
		const cwd = sessionCwd ?? target(await $.session.cwd());
		envelope = await codeIntel({ connect: (s) => $.mcp.connect(s), call: (s, t, a) => $.mcp.call(s, t, a) }, code, { cwd });
	} catch (error) {
		envelope = { success: false, error: { code: 'MCP_CALL_FAILED', message: error instanceof Error ? error.message : String(error) } };
	}
	if ((generations.get('unused') ?? 0) !== generation) return;
	loadingMore = false;
	if (envelope.success) {
		const page = orphanPage(envelope.result);
		morePages = [...morePages, ...page.rows];
		nextOffset = page.nextOffset;
	} else {
		handoffNote = 'Could not load more. Try again.';
	}
	$.ui.invalidate('ui.render');
}

/**
 * An error in the pane: the error badge and the headline in bold, then,
 * indented under it, the detail and notes dim, the numbered steps with each
 * command bold, and the docs link and the code last.
 */
function errorView(el: ElementTable, ex: Explanation, tint: Scheme): RenderElement {
	const row = (label: string, value: RenderElement) =>
		el.Box({ flexDirection: 'row', children: [el.Text({ dimColor: true, children: label.padEnd(7) }), value] });
	const under: RenderElement[] = [];
	if (ex.detail !== undefined || ex.notes.length > 0) {
		under.push(
			el.Box({
				flexDirection: 'column',
				children: [ex.detail, ...ex.notes].filter((t): t is string => t !== undefined).map((t) => el.Text({ dimColor: true, children: t })),
			}),
		);
	}
	if (ex.steps.length > 0) {
		under.push(
			el.Box({
				flexDirection: 'column',
				children: [
					el.Text({ bold: true, children: 'Next steps' }),
					...ex.steps.map((step, i) =>
						el.Box({ flexDirection: 'row', columnGap: 1, children: [el.Text({ dimColor: true, children: `${i + 1}.` }), el.Text({ bold: true, children: step })] }),
					),
				],
			}),
		);
	}
	under.push(
		el.Box({
			flexDirection: 'column',
			children: [
				...(ex.docs === undefined ? [] : [row('Docs', el.Link({ href: ex.docs, label: ex.docs }))]),
				row('Code', el.Text({ dimColor: true, children: ex.code })),
			],
		}),
	);
	return el.Box({
		flexDirection: 'column',
		gap: 1,
		children: [
			el.Box({ flexDirection: 'row', columnGap: 1, children: [badge(el, '', forTheme(status('error'), tint)), el.Text({ bold: true, children: ex.title })] }),
			el.Box({ flexDirection: 'column', gap: 1, paddingLeft: 2, children: under }),
		],
	});
}

/** Reads one project's capabilities for the picker; a result that lands after the pane closed is dropped. */
async function runDetail($: EngineInterface, root: string): Promise<void> {
	detailsPending.add(root);
	const envelope = await codeIntel(
		{ connect: (s) => $.mcp.connect(s), call: (s, t, a) => $.mcp.call(s, t, a) },
		'return await api.getCapabilities()',
		{ cwd: root },
	);
	if (!detailsPending.delete(root)) return;
	details.set(root, envelope);
	$.ui.invalidate('ui.render');
}

function projectName(cwd: string | undefined): string | undefined {
	return cwd?.replace(/\\/g, '/').split('/').filter(Boolean).pop();
}

export function registerCommand(on: On, options: PluginOptions): void {
	on('session.start', async ($, e, next) => {
		const r = await next(e);
		try {
			await $.command.register({
				name: COMMAND,
				description: 'Constellation status, diagnose, deps, unused code and symbol explorer',
				argumentHint: '[status|diagnose|deps <file>|unused [kind]|explore [query]]',
				immediate: true,
			});
		} catch {
			// Registration refused: the Markdown commands still work.
		}
		return r;
	});

	on('command.run', { command: COMMAND }, async ($, e) => {
		const { tab, path, kind, query } = parseArgs(e.args);
		const cwd = await $.session.cwd();
		if (chosen?.from !== cwd) {
			try {
				const saved = await $.store.get(pickKey(cwd));
				if (typeof saved === 'string') chosen = { from: cwd, root: saved };
			} catch {
				// Nothing saved, or the store is unavailable: the picker asks again.
			}
		}
		const dir = target(cwd);
		unusedKind = kind;
		exploreQuery = query ?? '';
		if (!canDraw(await $.session.surfaces())) {
			if (tab === 'deps' && path === undefined) return { text: 'Usage: /constellation deps <file>' };
			if (tab === 'explore' && query === undefined) return { text: 'Usage: /constellation explore <symbol>' };
			const envelope = await codeIntel(
				{ connect: (s) => $.mcp.connect(s), call: (s, t, a) => $.mcp.call(s, t, a) },
				codeFor(tab, 'dependencies', path ?? ''),
				{ cwd: dir },
			);
			const summary = summarize(tab, envelope, { path, project: projectName(dir), query });
			const meta = metadata(envelope);
			if (summary.explanation !== undefined) return { text: [`${PROMPT} ${tab}`, ...summary.lines].join('\n') };
			const body = [...summary.lines.slice(0, MAX_TEXT_LINES), ...(meta === undefined ? [] : [meta])];
			return { text: [`${PROMPT} ${tab}`, ...body.map((l) => `- ${l.trim()}`)].join('\n') };
		}
		reset();
		unusedKind = kind;
		exploreQuery = query ?? '';
		selected = tab;
		depsPath = path ?? '';
		sessionCwd = dir;
		launchCwd = cwd;
		try {
			tint = scheme(options.colors, (await $.config.list()).find((r) => r.key === 'theme')?.value);
		} catch {
			tint = scheme(options.colors, undefined);
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
		const needsQuery = selected === 'explore' && exploreQuery === '';
		if (envelope === undefined && !pending.has(selected) && !needsPath && !needsQuery) void runQuery($, selected);
		const isPending = pending.has(selected);

		const redraw = (): void => $.ui.invalidate('ui.render');
		const showDeps = (path: string): void => {
			depsPath = path;
			drop('deps');
			redraw();
		};
		const accent = paint(palette.nebula, tint);
		const pick = async (project: string): Promise<void> => {
			const from = launchCwd ?? (await $.session.cwd());
			chosen = { from, root: project };
			sessionCwd = project;
			for (const tab of TABS) drop(tab);
			redraw();
			try {
				await $.store.set(pickKey(from), project);
			} catch {
				// Not remembered across sessions; this session keeps the pick.
			}
		};
		const switchProject = async (): Promise<void> => {
			const from = launchCwd ?? (await $.session.cwd());
			chosen = undefined;
			sessionCwd = from;
			for (const tab of TABS) drop(tab);
			redraw();
			try {
				await $.store.delete(pickKey(from));
			} catch {
				// A pick left in the store is offered again and can be switched again.
			}
		};
		const summary = envelope === undefined ? undefined : summarize(selected, envelope, { direction: depsDirection, path: depsPath, project: projectName(sessionCwd), query: exploreQuery });

		const body: RenderElement[] = [];
		if (selected === 'deps') {
			body.push(
				el.Input({
					key: 'deps-path',
					label: 'File',
					value: depsPath,
					placeholder: 'path/to/file.ts',
					submitLabel: 'show',
					onSubmit: (value) => showDeps(value.trim()),
				}),
				el.Button({
					key: 'deps-toggle',
					label: depsDirection === 'dependencies' ? 'Showing dependencies (switch to dependents)' : 'Showing dependents (switch to dependencies)',
					plain: true,
					onPress: () => {
						depsDirection = depsDirection === 'dependencies' ? 'dependents' : 'dependencies';
						drop('deps');
						redraw();
					},
				}),
			);
		}
		const hit = focusHit;
		if (selected === 'explore' && hit === undefined) {
			body.push(
				el.Input({
					key: 'explore-query',
					label: 'Symbol',
					value: exploreQuery,
					placeholder: 'name',
					submitLabel: 'search',
					autoFocus: true,
					onSubmit: (value) => {
						exploreQuery = value.trim();
						drop('explore');
						redraw();
					},
				}),
			);
		}
		const firstPage = selected === 'unused' && envelope?.success === true ? orphanPage(envelope.result) : undefined;
		const loaded = firstPage === undefined ? [] : [...firstPage.rows, ...morePages];
		const pickedRows = loaded.filter((r) => picked.has(r.symbolId));
		const toggle = (ids: readonly string[], select: boolean): void => {
			for (const id of ids) {
				if (select) picked.add(id);
				else picked.delete(id);
			}
			redraw();
		};
		if (firstPage !== undefined) {
			if (loaded.length === 0) {
				const color = paint(palette.cosmic, tint);
				body.push(el.Text({ ...(color === undefined ? {} : { color }), children: '✦ No unused exports found' }));
			} else {
				const nebula = paint(palette.nebula, tint);
				body.push(
					el.Box({
						flexDirection: 'column',
						children: [
							el.Box({
								flexDirection: 'row',
								columnGap: 2,
								children: [
									el.Text({ ...(nebula === undefined ? {} : { color: nebula }), children: `${picked.size} selected` }),
									el.Text({ dimColor: true, children: `of ${grouped(firstPage.total ?? loaded.length)} unused exports` }),
									el.Button({ key: 'select-all', label: 'Select all', hotkey: 'a', plain: true, onPress: () => toggle(loaded.map((r) => r.symbolId), true) }),
								],
							}),
							// The list's keys sit here, not in the footer: a long list scrolls the footer out of view.
							el.Text({ dimColor: true, children: `tab/shift+tab move · enter toggle${picked.size > 0 ? ' · h hand off' : ''}` }),
							...(handoffNote === undefined ? [] : [el.Text({ dimColor: true, children: handoffNote })]),
						],
					}),
				);
				for (const [file, rows] of byFile(loaded)) {
					const ids = rows.map((r) => r.symbolId);
					const all = ids.every((id) => picked.has(id));
					body.push(
						el.Button({ key: `orphan-file:${file}`, label: `${all ? '[x]' : '[ ]'} ${file}`, plain: true, onPress: () => toggle(ids, !all) }),
						...rows.map((row) =>
							el.Box({
								key: `row:${row.symbolId}`,
								flexDirection: 'row',
								columnGap: 1,
								paddingLeft: 2,
								children: [
									el.Button({
										key: `orphan:${row.symbolId}`,
										label: picked.has(row.symbolId) ? '[x]' : '[ ]',
										plain: true,
										onPress: () => toggle([row.symbolId], !picked.has(row.symbolId)),
									}),
									el.Text({ children: row.name }),
									badge(el, '', forTheme(kind(row.kind), tint)),
									el.Text({ dimColor: true, children: location(row) }),
								],
							}),
						),
					);
				}
				if (nextOffset !== undefined && !loadingMore) {
					body.push(el.Button({ key: 'load-more', label: 'Load more', plain: true, onPress: () => loadMore($) }));
				}
				if (loadingMore) body.push(badge(el, 'loading more', forTheme(status('pending'), tint)));
			}
		} else if (selected === 'explore' && summary !== undefined && summary.explanation === undefined) {
			const labeled = (label: string, value: string): RenderElement =>
				el.Box({ flexDirection: 'row', children: [el.Text({ dimColor: true, children: label.padEnd(LABEL_WIDTH) }), el.Text({ children: value })] });
			const stamp = (from: CodeIntelEnvelope | undefined): RenderElement[] => {
				const parts: string[] = [];
				if (from?.time !== undefined) parts.push(`${from.time} ms`);
				if (from?.asOfCommit) parts.push(`as of ${from.asOfCommit.slice(0, 7)}`);
				return parts.length === 0 ? [] : [el.Text({ dimColor: true, children: parts.join(' · ') })];
			};
			if (hit === undefined) {
				const found = rankExact(exploreQuery, hits(envelope?.result)).slice(0, EXPLORE_ROWS);
				if (found.length === 0) body.push(el.Text({ dimColor: true, children: 'No symbols match' }));
				for (const h of found) {
					body.push(
						el.Box({
							key: `row:${h.id}`,
							flexDirection: 'row',
							columnGap: 1,
							children: [
								el.Button({
									key: `hit:${h.id}`,
									label: h.name,
									plain: true,
									onPress: () => {
										focusHit = h;
										section = 'details';
										if (!drill.has(h.id) && !drillPending.has(h.id)) void runDrill($, h.id);
										redraw();
									},
								}),
								badge(el, '', forTheme(kind(h.kind), tint)),
								el.Text({ dimColor: true, children: where(h) }),
							],
						}),
					);
				}
				body.push(...stamp(envelope));
			} else {
				const drilled = drill.get(hit.id);
				const result = isRecord(drilled?.result) ? drilled.result : {};
				const aliasNote = el.Text({ dimColor: true, children: 'Callers importing through path aliases or export * barrels may be missing.' });
				const sections: [Section, string][] = [
					['details', 'Details'],
					['usages', 'Usages'],
					['impact', 'Impact'],
					['calls', 'Call graph'],
				];
				body.push(
					el.Box({
						flexDirection: 'column',
						gap: 1,
						children: [
							el.Box({
								flexDirection: 'column',
								children: [
									el.Text({ dimColor: true, children: `results for ${exploreQuery}` }),
									el.Box({
										flexDirection: 'row',
										columnGap: 1,
										children: [
											badge(el, '', forTheme(kind(hit.kind), tint)),
											el.Text({ bold: true, children: hit.name }),
											el.Text({ dimColor: true, children: where(hit) }),
											el.Button({
												key: 'copy-location',
												label: 'copy location',
												plain: true,
												dimColor: true,
												onPress: async (press) => {
													const { isCopied } = await $.ui.copy({ text: where(hit), surface: press.surface });
													exploreNote = isCopied ? 'Copied' : 'Could not copy';
													redraw();
												},
											}),
										],
									}),
									...(exploreNote === undefined ? [] : [el.Text({ dimColor: true, children: exploreNote })]),
								],
							}),
							el.Box({
								flexDirection: 'row',
								columnGap: 2,
								children: sections.map(([name, label]) =>
									el.Button({
										key: `section-${name}`,
										label: name === section ? `▸ ${label}` : label,
										plain: true,
										onPress: () => {
											section = name;
											redraw();
										},
									}),
								),
							}),
							drilled === undefined
								? badge(el, 'querying Constellation', forTheme(status('pending'), tint))
								: !drilled.success
									? errorView(el, summarize('explore', drilled).explanation ?? explain({ code: 'UNKNOWN', message: 'The request failed' }), tint)
									: el.Box({
											flexDirection: 'column',
											children: (() => {
												if (section === 'details') {
													const lines = detailLines(result['details']);
													return lines.length === 0 ? [el.Text({ dimColor: true, children: 'No details returned' })] : lines.map((l) => el.Text({ children: l }));
												}
												if (section === 'usages') {
													const lines = usageLines(result['usages']);
													return [
														...(lines.length === 0 ? [el.Text({ dimColor: true, children: 'No usages found' })] : lines.map((l) => el.Text({ children: l }))),
														aliasNote,
													];
												}
												if (section === 'impact') {
													const view = impactView(result['impact']);
													return [
														...(view.riskLevel === undefined ? [] : [badge(el, '', forTheme(risk(view.riskLevel), tint))]),
														...(view.files === undefined ? [] : [labeled('Files', String(view.files))]),
														...(view.direct === undefined ? [] : [labeled('Direct', String(view.direct))]),
														...(view.transitive === undefined ? [] : [labeled('Transitive', String(view.transitive))]),
														...(view.tests === undefined && view.production === undefined
															? []
															: [labeled('Tests', `${view.tests ?? 0} test · ${view.production ?? 0} production`)]),
														...view.top.map((d) => badge(el, d.name, forTheme(kind(d.kind), tint))),
														aliasNote,
													];
												}
												const tree = callTree(result['calls']);
												return tree.length === 0
													? [el.Text({ dimColor: true, children: 'No callers or callees found' })]
													: tree.map((l) => el.Text({ ...(l.depth === 0 ? { bold: true } : {}), children: `${'  '.repeat(l.depth)}${l.text}` }));
											})(),
										}),
						],
					}),
					...stamp(drilled),
				);
			}
		} else if (summary?.explanation !== undefined && !summary.items.some((i) => i.project !== undefined)) {
			body.push(errorView(el, summary.explanation, tint));
		} else if (summary !== undefined) {
			let row = 0;
			for (const item of summary.items) {
				const path = item.path;
				const project = item.project;
				if (project !== undefined) {
					// The tabs are hidden while picking, so the digits are free for the rows.
					const n = row++;
					if (!details.has(project) && !detailsPending.has(project)) void runDetail($, project);
					body.push(
						el.Box({
							key: `row:${project}`,
							flexDirection: 'row',
							columnGap: 2,
							children: [
								el.Button({
									key: `project:${project}`,
									label: item.text,
									plain: true,
									...(n < 9 ? { hotkey: String(n + 1) } : {}),
									...(n === 0 ? { autoFocus: true as const } : {}),
									hover: accent === undefined ? { bold: true } : { bold: true, color: accent },
									onPress: () => pick(project),
								}),
								el.Text({ dimColor: true, children: projectDetail(details.get(project)) }),
							],
						}),
					);
				} else if (path !== undefined) {
					body.push(el.Button({ key: `dep:${path}`, label: path, plain: true, onPress: () => showDeps(path) }));
				} else if (item.label !== undefined) {
					const tone =
						item.badge === undefined ? undefined : forTheme(item.badge.kind === 'status' ? status(item.badge.value) : kind(item.badge.value), tint);
					body.push(
						el.Box({
							flexDirection: 'row',
							children: [
								el.Text({ dimColor: true, children: item.label.padEnd(LABEL_WIDTH) }),
								tone === undefined ? el.Text({ children: item.text }) : badge(el, item.text, tone),
							],
						}),
					);
				} else if (item.badge?.kind === 'status') {
					body.push(badge(el, item.text, forTheme(status(item.badge.value), tint)));
				} else if (item.badge?.kind === 'kind') {
					body.push(badge(el, item.text, forTheme(kind(item.badge.value), tint)));
				} else if (item.heading) {
					body.push(el.Text({ bold: true, children: item.text }));
				} else {
					body.push(el.Text(item.dim ? { dimColor: true, children: item.text } : { children: item.text }));
				}
			}
		} else if (isPending) {
			body.push(badge(el, 'querying Constellation', forTheme(status('pending'), tint)));
		} else if (needsPath) {
			body.push(el.Text({ dimColor: true, children: 'Enter a file path to see its dependencies.' }));
		} else if (needsQuery) {
			body.push(el.Text({ dimColor: true, children: 'Enter a symbol name to search the graph.' }));
		}

		const meta = metadata(envelope);
		// Until a project is picked every tab would ask the same question, so the
		// picker hides the tabs and Refresh.
		const picking = summary?.items.some((i) => i.project !== undefined) ?? false;
		const canSwitch = !picking && launchCwd !== undefined && sessionCwd !== undefined && sessionCwd !== launchCwd;
		const project = picking ? undefined : projectName(sessionCwd);
		const close = {
			key: 'close',
			label: 'Close',
			role: 'dismiss' as const,
			onPress: async () => {
				// The ui.close hook below sees Esc and unload, not this plugin's own
				// close from a callback, so the button clears the state itself.
				await $.ui.close({ id: PANE });
				reset();
			},
		};
		const tabs = TABS.map((tab, index) =>
			el.Button({
				key: `tab-${tab}`,
				label: tab === selected ? `▸ ${TAB_LABEL[tab]}` : TAB_LABEL[tab],
				hotkey: String(index + 1),
				plain: true,
				onPress: () => {
					selected = tab;
					redraw();
				},
			}),
		);

		// The pane's width less its padding; Claude Code redraws when it changes.
		const columns = typeof e.props.bodyColumns === 'number' ? e.props.bodyColumns - 2 : 0;
		const head = header(el, columns, e.surface === 'terminal', tint);
		const rule = el.Text({ dimColor: true, children: '─'.repeat(Math.max(10, Math.min(BANNER_WIDTH, columns))) });
		const keys = picking
			? '1-9 open a project · enter opens the selected one · esc close'
			: selected === 'explore'
					? `${hit === undefined ? 'esc leaves the search field' : 'b back'} · 1-5 switch tabs · r refresh${canSwitch ? ' · p switch project' : ''} · esc close`
					: `1-5 switch tabs · r refresh${canSwitch ? ' · p switch project' : ''} · esc close`;

		return el.Box({
			flexDirection: 'column',
			padding: 1,
			gap: 1,
			children: [
				head,
				...(project === undefined && meta === undefined && !canSwitch
					? []
					: [
							el.Box({
								flexDirection: 'row',
								columnGap: 1,
								children: [
									...(project === undefined ? [] : [el.Text({ bold: true, children: project })]),
									...(project !== undefined && meta !== undefined ? [el.Text({ dimColor: true, children: '·' })] : []),
									...(meta === undefined ? [] : [el.Text({ dimColor: true, children: meta })]),
									...((project !== undefined || meta !== undefined) && canSwitch ? [el.Text({ dimColor: true, children: '·' })] : []),
									...(canSwitch
										? [el.Button({ key: 'switch-project', label: 'switch project', hotkey: 'p', plain: true, onPress: switchProject })]
										: []),
								],
							}),
						]),
				...(picking
					? []
					: [
							el.Box({
								flexDirection: 'column',
								children: [el.Box({ flexDirection: 'row', columnGap: 2, children: tabs }), rule, el.Text({ dimColor: true, children: TAB_HINT[selected] })],
							}),
						]),
				el.Box({ flexDirection: 'column', children: body }),
				el.Box({
					flexDirection: 'column',
					children: [
						...(pickedRows.length === 0
							? []
							: [
									buttonRow(
										el,
										{
											key: 'clear',
											label: 'Clear',
											onPress: () => {
												picked.clear();
												handoffNote = undefined;
												redraw();
											},
										},
										{
											key: 'handoff',
											label: `Hand ${pickedRows.length} removal${pickedRows.length === 1 ? '' : 's'} to Claude`,
											hotkey: 'h',
											onPress: async () => {
												const text = removalPrompt(pickedRows, envelope?.asOfCommit);
												const { isFilled } = await $.prompt.fill({ text });
												if (isFilled) {
													await $.ui.close({ id: PANE });
													reset();
												} else {
													handoffNote = 'Could not fill the prompt box (a dialog may be open). Close it and try again.';
													redraw();
												}
											},
										},
									),
								]),
						...(selected === 'explore' && hit !== undefined
							? [
									buttonRow(
										el,
										{
											key: 'back',
											label: 'Back',
											hotkey: 'b',
											onPress: () => {
												focusHit = undefined;
												section = 'details';
												exploreNote = undefined;
												redraw();
											},
										},
										{
											key: 'ask-claude',
											label: 'Ask Claude',
											onPress: async () => {
												const { isFilled } = await $.prompt.fill({ text: askText(hit) });
												if (isFilled) {
													await $.ui.close({ id: PANE });
													reset();
												} else {
													exploreNote = 'Could not fill the prompt box (a dialog may be open). Close it and try again.';
													redraw();
												}
											},
										},
									),
								]
							: []),
						picking
							? el.Box({ flexDirection: 'row', justifyContent: 'flex-end', children: [el.Button(close)] })
							: buttonRow(el, close, {
									key: 'refresh',
									label: 'Refresh',
									hotkey: 'r',
									onPress: () => {
										drop(selected);
										redraw();
									},
								}),
						el.Text({ dimColor: true, children: keys }),
					],
				}),
			],
		});
	});

	on('ui.close', { id: PANE }, async (_$, e, next) => {
		const r = await next(e);
		reset();
		return r;
	});
}
