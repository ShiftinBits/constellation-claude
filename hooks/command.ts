import { atom, read, update } from 'claude-code';
import type { ButtonProps, ElementTable, EngineInterface, On, RenderElement } from 'claude-code';
import type { ConstellationDirection, ConstellationPane, ConstellationQueryTab, ConstellationSection, ConstellationTab } from '../types';
import { ADOPTION_SHAPE, NO_COUNTS, SHARE_LABEL, SHARE_NOTE, UNREAD_NOTE, figures, loadStats, settled, statRows, statsCells, statsLines } from './adoption';
import { canDraw, codeIntel, isConfigured, isRecord, projectName, projectRoot, withinDeadline } from './lib';
import type { CodeIntelEnvelope, CodeIntelError } from './lib';
import { explain, explainLines } from './explain';
import { askText, callTree, detailLines, detailRows, drillCode, hasCallGraph, hits, impactView, rankExact, searchCode, usageLines, usageRows, usageTotal, where } from './explore';
import { byFile, orphanCode, orphanPage, removalPrompt } from './unused';
import type { Explanation } from './explain';
import { FRESHNESS_SHAPE, observeEnvelope, recheck, showsFreshness, startTicks, track } from './freshness';
import type { Publish } from './freshness';
import { BAND_SHAPE, checkConnection, NO_BAND, pingProject, readStoredKeyAtStart, rememberRepo } from './onboarding';
import type { FoundKey, OnboardingPorts } from './onboarding';
import { BANNER_WIDTH, badge, branded, buttonRow, forTheme, header, kind, paint, palette, risk, scheme, status } from './theme';
import type { Scheme } from './theme';

/**
 * The command's name. Mod commands allow letters, digits, `_` and `-`, so the
 * bare name sits beside the `/constellation:*` skills, and a name
 * a built-in owns is refused.
 */
export const COMMAND = 'constellation';

/** The id of the pane the command opens; the `requestId` its tree is drawn under. */
const PANE = 'constellation';

export type Tab = ConstellationTab;
const TABS: readonly Tab[] = ['status', 'diagnose', 'deps', 'unused', 'explore', 'stats'];
/** A tab that shows a code_intel query's answer. Stats shows counts kept on this machine and never queries. */
type QueryTab = ConstellationQueryTab;
type Direction = ConstellationDirection;
type Section = ConstellationSection;
/** What the pane draws: its tab, each tab's answer and what the person selected. */
type Pane = ConstellationPane;

const TAB_LABEL: Readonly<Record<Tab, string>> = {
	status: 'Status',
	diagnose: 'Diagnose',
	deps: 'Deps',
	unused: 'Unused',
	explore: 'Explore',
	stats: 'Stats',
};

/** One line under the tab row saying what the tab shows. */
const TAB_HINT: Readonly<Record<Tab, string>> = {
	status: 'Whether Constellation is reachable and your access key is accepted.',
	diagnose: 'What the Constellation index holds for this project.',
	deps: 'What a file imports, or what imports it.',
	unused: 'Exports nothing imports. Verify each one before deleting it.',
	explore: 'Search the graph and drill into a symbol without a Claude turn.',
	stats: 'How often Claude called code_intel, beside its text searches. Counted on this machine only.',
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
	if (item.badge?.kind === 'kind') return `  ${item.text} · ${kind(item.badge.value).word}`;
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

/** The first MAX_TEXT_LINES lines, then how many were left out, counting the rows a `+N more` line already stood for. */
function textLines(lines: string[]): string[] {
	if (lines.length <= MAX_TEXT_LINES) return lines;
	const more = /^\+(\d+) more$/.exec(lines[lines.length - 1] ?? '');
	const hidden = lines.length - MAX_TEXT_LINES + (more === null ? 0 : Number(more[1]) - 1);
	return [...lines.slice(0, MAX_TEXT_LINES), `+${hidden} more`];
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
		badge: { kind: 'status', value: indexed === true ? 'indexed' : indexed === false ? 'not indexed' : 'unknown' },
		text: '',
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
	if (symbols.length === 0) return [{ text: 'No unused exports found', dim: true }];
	const byFile = new Map<string, Record<string, unknown>[]>();
	for (const symbol of symbols) {
		const file = text(symbol['filePath']) ?? 'unknown file';
		byFile.set(file, [...(byFile.get(file) ?? []), symbol]);
	}
	const summary = isRecord(result['summary']) ? result['summary'] : {};
	const total = count(summary['totalOrphanedSymbols']) ?? symbols.length;
	const items: Item[] = [{ text: `${grouped(total)} unused exports`, heading: true }];
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
	return found.map((h): Item => ({ text: `${h.name} · ${kind(h.kind).word} · ${where(h)}` }));
}

/**
 * The facts of one tab from its code_intel envelope, shared by the pane and
 * the text fallback: `items` carry the badges and rows the pane draws and
 * `lines` the same facts as plain text. The envelope's `result` is untyped, so
 * each field is narrowed against the executor schemas before it is read; on
 * error the code, message and guidance are returned.
 */
export function summarize(tab: QueryTab, envelope: CodeIntelEnvelope, options: SummaryOptions = {}): Summary {
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
	if (envelope === undefined) return 'checking';
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

/** The Unused tab's kind choices: the kinds an export usually has, of the categories `findOrphanedCode` filters by. */
const UNUSED_KINDS: readonly string[] = ['function', 'class', 'interface', 'type', 'type_alias', 'variable', 'constant', 'enum', 'struct', 'trait', 'module', 'namespace'];
/** The Unused kind choice that sends no filter. */
const ALL_KINDS = 'all';

/** The `findOrphanedCode` filter for `kind`, the kind the Unused tab lists, if any. */
function unusedFilter(kind: string | undefined): { filterByKind?: string[] } {
	return kind === undefined ? {} : { filterByKind: [kind] };
}

/** What a tab's query reads from the pane: the Deps file and direction, the Unused kind and the Explore search. */
type QueryInput = Pick<Pane, 'depsPath' | 'direction' | 'unusedKind' | 'query'>;

function codeFor(tab: QueryTab, input: QueryInput): string {
	switch (tab) {
		case 'status':
			return 'return await api.ping()';
		case 'diagnose':
			return 'const [ping, caps] = await Promise.all([api.ping(), api.getCapabilities()]); return { ping, caps }';
		case 'deps':
			return `return await api.${input.direction === 'dependencies' ? 'getDependencies' : 'getDependents'}({ filePath: ${JSON.stringify(input.depsPath)} })`;
		case 'unused':
			return orphanCode(unusedFilter(input.unusedKind));
		case 'explore':
			return searchCode(input.query);
	}
}

/** The shape tag of the `pane` state key; `session.ts` builds its atom with it. */
export const PANE_SHAPE = 'pane-1';

/** The pane as it opens on the status tab, with nothing read or selected. */
export const NO_PANE: Pane = {
	tab: 'status',
	tint: 'brand',
	results: {},
	details: {},
	depsPath: '',
	direction: 'dependencies',
	picked: [],
	morePages: [],
	query: '',
	section: 'details',
	drill: {},
};

/**
 * What the pane draws, kept in `$.state`: a write redraws it, a reload keeps
 * it, and the drawing reads nothing else that changes. Handlers write it with
 * `update`; a drawing never does.
 */
const PANE_STATE = atom({ plugin: 'constellation', key: 'pane' } as const, NO_PANE, { shape: PANE_SHAPE });
const ADOPTION = atom({ plugin: 'constellation', key: 'adoption' } as const, NO_COUNTS, { shape: ADOPTION_SHAPE });
const BAND = atom({ plugin: 'constellation', key: 'band' } as const, NO_BAND, { shape: BAND_SHAPE });
const FRESHNESS = atom({ plugin: 'constellation', key: 'freshness' } as const, null, { shape: FRESHNESS_SHAPE });

// This load's own, which a reload starts over: the work in flight, which the reload ends, and the project pick.
/**
 * The project picked when the session's working directory is not a project
 * (a workspace root above several). Kept across pane opens, unlike the rest,
 * and used only while the session is still in `from`.
 */
let chosen: { from: string; root: string } | undefined;
const pending = new Set<QueryTab>();
const generations = new Map<QueryTab, number>();
const detailsPending = new Set<string>();
const drillPending = new Set<string>();
let loadingMore = false;
/** How long a read of the stored counts waits for counts still being saved. */
const SETTLE_MS = 1000;
/** The Stats tab's counts, the session's and the stored ones read together so the rows agree. */
type Snapshot = NonNullable<Pane['stats']>;
/** Whether the Stats tab's read of the stored counts is running, and a count that tells a read a later one replaced. */
let historyReading = false;
let historyRead = 0;

/** The `$.store` key that remembers the project picked in `from`, across sessions. */
function pickKey(from: string): string {
	return `project:${from}`;
}

/** Ends what is in flight for `tab`: an answer still on its way is dropped. */
function forget(tab: Tab): void {
	if (tab === 'stats') {
		historyReading = false;
		historyRead += 1;
		return;
	}
	pending.delete(tab);
	generations.set(tab, (generations.get(tab) ?? 0) + 1);
	if (tab === 'unused') loadingMore = false;
	if (tab === 'explore') drillPending.clear();
}

/** Ends everything in flight, as the pane closing or a new conversation does. */
export function forgetPane(): void {
	for (const tab of TABS) forget(tab);
	detailsPending.clear();
}

/** The pane without `tab`'s answer and what was selected in it. */
function dropped(pane: Pane, tab: Tab): Pane {
	if (tab === 'stats') return { ...pane, stats: undefined };
	const next: Pane = { ...pane, results: { ...pane.results, [tab]: undefined } };
	if (tab === 'unused') return { ...next, picked: [], morePages: [], nextOffset: undefined, handoffNote: undefined };
	if (tab === 'explore') return { ...next, focus: undefined, section: 'details', drill: {}, exploreNote: undefined };
	return next;
}

/** The directory queries run in: the picked project while the session stays where it was picked. */
function target(cwd: string): string {
	return chosen?.from === cwd ? chosen.root : cwd;
}

/**
 * Starts what `pane`'s tab shows and does not hold yet: its query, or on
 * Stats the stored counts. Called by the handler that wrote `pane`, with that
 * write as `written`, before the write lands, so the redraw it brings already
 * shows the tab pending; the answer is written only after it. A drawing never
 * starts work: what it started could not write state.
 */
function launch($: EngineInterface, pane: Pane, written: Promise<unknown>): void {
	const tab = pane.tab;
	if (tab === 'stats') {
		if (pane.stats === undefined && !historyReading) void readHistory($, written);
		return;
	}
	if (pane.results[tab] !== undefined || pending.has(tab)) return;
	if ((tab === 'deps' && pane.depsPath === '') || (tab === 'explore' && pane.query === '')) return;
	void runQuery($, tab, pane, written);
}

/**
 * Runs the tab's query and writes the envelope into the pane. A result that
 * lands after its tab was dropped (refresh, a new path, the pane closing) is
 * discarded. An error that lists project roots starts each one's picker read.
 * Never rejects: an answer the state refuses leaves the tab without one, and
 * a redraw takes its pending badge down, so Refresh asks again.
 */
async function runQuery($: EngineInterface, tab: QueryTab, pane: Pane, written: Promise<unknown>): Promise<void> {
	const generation = generations.get(tab) ?? 0;
	const current = (): boolean => (generations.get(tab) ?? 0) === generation;
	pending.add(tab);
	try {
		let envelope: CodeIntelEnvelope;
		try {
			const cwd = pane.cwd ?? target(await $.session.cwd());
			envelope = await codeIntel({ connect: (s) => $.mcp.connect(s), call: (s, t, a) => $.mcp.call(s, t, a) }, codeFor(tab, pane), { cwd });
		} catch (error) {
			envelope = { success: false, error: { code: 'MCP_CALL_FAILED', message: error instanceof Error ? error.message : String(error) } };
		}
		await written;
		if (!current()) return;
		pending.delete(tab);
		const nextOffset = tab === 'unused' && envelope.success ? { nextOffset: orphanPage(envelope.result).nextOffset } : {};
		const next = await update($, PANE_STATE, (s) => (current() ? { ...s, results: { ...s.results, [tab]: envelope }, ...nextOffset } : s));
		for (const root of envelope.error?.candidates ?? []) {
			if (next.details[root] === undefined && !detailsPending.has(root)) void runDetail($, root);
		}
	} catch {
		if (!current()) return;
		pending.delete(tab);
		// `pending` is this load's, not state: only a redraw shows the tab no longer waits.
		$.ui.invalidate('ui.render');
	}
}

/**
 * The session's counts with the stored ones, deleting the entries past their 30
 * days. Counts are saved in the background, so it first waits, for at most
 * `SETTLE_MS`, for the saves still running: today's row is then never behind
 * the session's. With no store only the session's counts come back.
 */
async function readStats($: EngineInterface): Promise<Snapshot> {
	try {
		await withinDeadline((ms, o) => $.clock.sleep(ms, o), settled(), SETTLE_MS, new AbortController().signal);
	} catch {
		// No timer: the stored counts are read as they are.
	}
	// Unreadable, the session's counts show as none rather than holding the tab.
	const session = await read($, ADOPTION).catch(() => NO_COUNTS);
	try {
		return { session, stored: await loadStats(await $.clock.now(), await $.store.keys(), (k) => $.store.get(k), (k) => $.store.delete(k)) };
	} catch {
		return { session };
	}
}

/**
 * Reads the Stats tab's counts into the pane; a read that lands after the tab
 * was dropped is discarded. Never rejects: counts the state refuses leave the
 * tab showing the session's, and the next visit reads again.
 */
async function readHistory($: EngineInterface, written: Promise<unknown>): Promise<void> {
	const mine = (historyRead += 1);
	historyReading = true;
	const snapshot = await readStats($);
	await written;
	if (historyRead !== mine) return;
	historyReading = false;
	await update($, PANE_STATE, (s) => (historyRead === mine ? { ...s, stats: snapshot } : s)).catch(() => {
		// `historyReading` is this load's, not state: only a redraw takes its badge down.
		$.ui.invalidate('ui.render');
	});
}

/**
 * Reads one symbol's details, usages, impact and call graph; a result that
 * lands after the explorer was dropped is discarded. Never rejects: a result
 * the state refuses is dropped, and pressing the symbol again reads it again.
 */
async function runDrill($: EngineInterface, id: string, symbolKind: string, cwd: string | undefined, written: Promise<unknown>): Promise<void> {
	drillPending.add(id);
	let envelope: CodeIntelEnvelope;
	try {
		const dir = cwd ?? target(await $.session.cwd());
		envelope = await codeIntel({ connect: (s) => $.mcp.connect(s), call: (s, t, a) => $.mcp.call(s, t, a) }, drillCode(id, symbolKind), { cwd: dir });
	} catch (error) {
		envelope = { success: false, error: { code: 'MCP_CALL_FAILED', message: error instanceof Error ? error.message : String(error) } };
	}
	await written;
	if (!drillPending.delete(id)) return;
	await update($, PANE_STATE, (s) => ({ ...s, drill: { ...s.drill, [id]: envelope } })).catch(() => undefined);
}

/**
 * Reads the next page of unused exports; a page that lands after the tab was
 * dropped is discarded. `loadingMore` is this load's, not state (a reload ends
 * the read it stands for), so showing it takes a redraw of its own.
 */
async function loadMore($: EngineInterface, pane: Pane): Promise<void> {
	if (loadingMore || pane.nextOffset === undefined) return;
	const generation = generations.get('unused') ?? 0;
	const code = orphanCode({ ...unusedFilter(pane.unusedKind), limit: 50, offset: pane.nextOffset });
	loadingMore = true;
	$.ui.invalidate('ui.render');
	let envelope: CodeIntelEnvelope;
	try {
		const cwd = pane.cwd ?? target(await $.session.cwd());
		envelope = await codeIntel({ connect: (s) => $.mcp.connect(s), call: (s, t, a) => $.mcp.call(s, t, a) }, code, { cwd });
	} catch (error) {
		envelope = { success: false, error: { code: 'MCP_CALL_FAILED', message: error instanceof Error ? error.message : String(error) } };
	}
	const current = (): boolean => (generations.get('unused') ?? 0) === generation;
	if (!current()) return;
	loadingMore = false;
	const page = envelope.success ? orphanPage(envelope.result) : undefined;
	await update($, PANE_STATE, (s) => {
		if (!current()) return s;
		if (page === undefined) return { ...s, handoffNote: 'Could not load more. Try again.' };
		return { ...s, morePages: [...s.morePages, ...page.rows], nextOffset: page.nextOffset };
	}).catch(() => {
		// A page the state refuses is dropped; the redraw brings Load more back.
		$.ui.invalidate('ui.render');
	});
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
					el.Text({ weight: 'semibold', children: 'Next steps' }),
					...ex.steps.map((step, i) =>
						el.Box({ flexDirection: 'row', columnGap: 1, children: [el.Text({ dimColor: true, children: `${i + 1}.` }), el.Text({ weight: 'semibold', children: step })] }),
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
			el.Box({ flexDirection: 'row', columnGap: 1, children: [badge(el, '', forTheme(status('error'), tint)), el.Text({ weight: 'semibold', children: ex.title })] }),
			el.Box({ flexDirection: 'column', gap: 1, paddingLeft: 2, children: under }),
		],
	});
}

/**
 * Reads one project's capabilities for the picker; a result that lands after
 * the pane closed is dropped. Never rejects: a result the state refuses is
 * dropped, and the tab's Refresh reads it again.
 */
async function runDetail($: EngineInterface, root: string): Promise<void> {
	detailsPending.add(root);
	const envelope = await codeIntel(
		{ connect: (s) => $.mcp.connect(s), call: (s, t, a) => $.mcp.call(s, t, a) },
		'return await api.getCapabilities()',
		{ cwd: root },
	);
	if (!detailsPending.delete(root)) return;
	await update($, PANE_STATE, (s) => ({ ...s, details: { ...s.details, [root]: envelope } })).catch(() => undefined);
}

/**
 * Starts again what an open pane still waits for, after a reload ended the
 * work in flight: its tab's query or Stats read, each project the picker lists
 * without its details, and the symbol the explorer drilled into without its answer.
 */
function resume($: EngineInterface, pane: Pane): void {
	const written = Promise.resolve();
	launch($, pane, written);
	for (const envelope of Object.values(pane.results)) {
		for (const root of envelope?.error?.candidates ?? []) {
			if (pane.details[root] === undefined && !detailsPending.has(root)) void runDetail($, root);
		}
	}
	const focus = pane.focus;
	if (focus !== undefined && pane.drill[focus.id] === undefined && !drillPending.has(focus.id)) void runDrill($, focus.id, focus.kind, pane.cwd, written);
	// What is in flight is this load's, not state: only a redraw shows it pending.
	$.ui.invalidate('ui.render');
}

/**
 * The `/constellation` command and its pane. A load starts the work in flight
 * over; what the pane shows is in `$.state`, so a reload keeps it, and the
 * load's `session.start` starts again what an open pane still waits for.
 */
export function registerCommand(on: On): void {
	forgetPane();
	chosen = undefined;

	on('session.start', async ($, e, next) => {
		const ports: OnboardingPorts = {
			run: (argv, init) => $.process.run(argv, init),
			exists: (p) => $.fs.exists(p),
			read: (p) => $.fs.read(p),
			envSet: (key) => $.env.set('CONSTELLATION_ACCESS_KEY', key),
			after: (ms, fn) => {
				$.clock.after(ms, fn);
			},
			mcp: { connect: (s) => $.mcp.connect(s), call: (s, t, a) => $.mcp.call(s, t, a) },
			reload: () => $.command.run({ command: 'reload-plugins' }),
			toast: (text) => $.ui.toast(text),
			band: () => read($, BAND),
			setBand: (change) => update($, BAND, change),
			log: async (text) => {
				if (!canDraw(await $.session.surfaces())) $.ui.log(text);
			},
		};
		const publish: Publish = (view) => update($, FRESHNESS, () => view);
		// A key the CLI stored is set before the session goes on, so the MCP server can start with it.
		// A `-p` or SDK run skips the read-back: no one is at the prompt, and a login shell can take seconds.
		let found: FoundKey | undefined;
		try {
			if (e.isInteractive && !isConfigured(await $.env.get('CONSTELLATION_ACCESS_KEY'))) {
				found = await readStoredKeyAtStart(e.cwd, ports);
				if (found !== undefined) await ports.envSet(found.key);
			} else {
				await rememberRepo(e.cwd, ports.exists);
			}
		} catch {
			// The onboarding never fails the session or skips the registration.
			found = undefined;
		}
		const r = await next(e);
		// A load starts the freshness indicator over (`registerFreshness` drops what it knew), so the line in
		// `$.state`, the last load's or the last project's, goes; the ping below draws this project's again.
		try {
			if ((await read($, FRESHNESS)) !== null) await publish(null);
		} catch {
			// The line stays until the next comparison changes it.
		}
		// The project to ping and watch: the stored key's, else the session's when its key is set.
		let root: string | null = null;
		try {
			if (found !== undefined) root = found.projectRoot;
			else if (isConfigured(await $.env.get('CONSTELLATION_ACCESS_KEY'))) root = await projectRoot(e.cwd, ports.exists);
		} catch {
			root = null;
		}
		// With showFreshness off, a stored key's connection check still runs; nothing else does.
		if (root !== null && (found !== undefined || showsFreshness())) {
			const at = root;
			const again = () => recheck(ports.run, publish, ports.log);
			track(at);
			try {
				// Never await code_intel in session.start: the ping runs on a timer. Only a stored key's ping acts on
				// AUTH_ERROR and the index button; either answer tells the freshness indicator what is indexed.
				$.clock.after(0, () => {
					const observe = (envelope: CodeIntelEnvelope) => void observeEnvelope(envelope, at, ports.run, publish, ports.log).catch(() => undefined);
					const pinged =
						found !== undefined
							? checkConnection(at, ports, observe)
							: pingProject(at, ports).then((envelope) => {
									if (envelope !== undefined) observe(envelope);
								});
					void pinged.then(again).catch(() => undefined);
				});
			} catch {
				// No timer: the agent's own calls still bring up the band and the indicator.
			}
			try {
				// Every five minutes git alone compares the checkout again; code_intel is never called on the timer.
				if (showsFreshness()) startTicks(() => $.clock.every(5 * 60_000, () => void again().catch(() => undefined)));
			} catch {
				// No timer: git commands the agent runs and code_intel answers still update the indicator.
			}
		}
		try {
			// A reload keeps the pane up (`$.ui.panes` is the engine's record) but ended its work in flight.
			if ((await $.ui.panes()).some((pane) => pane.id === PANE)) resume($, await read($, PANE_STATE));
		} catch {
			// The pane shows what it holds; Refresh asks again.
		}
		try {
			await $.command.register({
				name: COMMAND,
				description: 'Constellation status, diagnose, deps, unused code, symbol explorer and code_intel usage stats',
				argumentHint: '[status|diagnose|deps <file>|unused [kind]|explore [query]|stats]',
				immediate: true,
			});
		} catch {
			// Registration refused: the `/constellation:*` skills still work.
		}
		return r;
	});

	on('command.run', { command: COMMAND }, async ($, e) => {
		const { tab, path, kind, query } = parseArgs(e.args);
		const draws = canDraw(await $.session.surfaces());
		if (tab === 'stats' && !draws) {
			const { session, stored } = await readStats($);
			return { text: [branded(TAB_LABEL[tab]), ...statsLines(session, stored).map((l) => `- ${l}`)].join('\n') };
		}
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
		if (!draws && tab !== 'stats') {
			if (tab === 'deps' && path === undefined) return { text: branded('Usage: /constellation deps <file>') };
			if (tab === 'explore' && query === undefined) return { text: branded('Usage: /constellation explore <query>') };
			const envelope = await codeIntel(
				{ connect: (s) => $.mcp.connect(s), call: (s, t, a) => $.mcp.call(s, t, a) },
				codeFor(tab, { direction: 'dependencies', depsPath: path ?? '', unusedKind: kind, query: query ?? '' }),
				{ cwd: dir },
			);
			const summary = summarize(tab, envelope, { path, project: projectName(dir), query });
			const meta = metadata(envelope);
			if (summary.explanation !== undefined) return { text: [branded(TAB_LABEL[tab]), ...summary.lines].join('\n') };
			const body = [...textLines(summary.lines), ...(meta === undefined ? [] : [meta])];
			return { text: [branded(TAB_LABEL[tab]), ...body.map((l) => `- ${l.trim()}`)].join('\n') };
		}
		let tint: Scheme;
		try {
			tint = scheme((await $.config.list()).find((r) => r.key === 'theme')?.value);
		} catch {
			tint = scheme(undefined);
		}
		const opened: Pane = { ...NO_PANE, tab, tint, depsPath: path ?? '', cwd: dir, launchCwd: cwd, unusedKind: kind, query: query ?? '' };
		forgetPane();
		const written = update($, PANE_STATE, () => opened).catch(() => undefined);
		launch($, opened, written);
		// The pane opens on what was written; an open pane redraws with the write.
		await written;
		await $.ui.open({ id: PANE, title: 'Constellation', focus: true, closeOnEscape: true });
		return {};
	});

	on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
		if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e);
		const el = $.ui.resolve(e);
		// Reading the pane and the counts while drawing subscribes this drawing: a later write draws it again.
		const [p, counts] = await Promise.all([read($, PANE_STATE), read($, ADOPTION)]);
		const { tab: selected, tint, depsPath, direction: depsDirection, cwd: sessionCwd, launchCwd, unusedKind, query: exploreQuery, section, handoffNote, exploreNote, nextOffset } = p;
		const picked = new Set(p.picked);
		const envelope = selected === 'stats' ? undefined : p.results[selected];
		const needsPath = selected === 'deps' && depsPath === '';
		const needsQuery = selected === 'explore' && exploreQuery === '';
		const isPending = selected !== 'stats' && pending.has(selected);

		/**
		 * Writes `change` into the pane's state, which draws it again. With `launches`, first starts what the
		 * changed pane needs (as this drawing saw it), so the redraw already shows it pending.
		 */
		const act = (change: (pane: Pane) => Pane, launches = false): Promise<unknown> => {
			const written = update($, PANE_STATE, change).catch(() => undefined);
			if (launches) launch($, change(p), written);
			return written;
		};
		// In a row that may be wider than the pane, the name and kind keep their width and a long location
		// shortens in the middle, instead of every item shrinking and wrapping onto a second line.
		const fixed = (children: RenderElement[]): RenderElement => el.Box({ flexDirection: 'row', columnGap: 1, flexShrink: 0, children });
		const place = (text: string): RenderElement => el.Box({ flexShrink: 1, children: [el.Text({ dimColor: true, wrap: 'truncate-middle', children: text })] });
		// Desktop has no monospace grid, so rows padded into columns do not line up there: it gets markdown tables.
		const grid = e.surface !== 'desktop';
		// The selected one of a row of tab-like buttons: `▸` in the terminal, Desktop's own primary button there.
		// A checkbox: `[x]` in the terminal; on Desktop ballot boxes, the check forced to text (U+FE0E), not an emoji.
		const check = (isChecked: boolean): string => (grid ? (isChecked ? '[x]' : '[ ]') : isChecked ? '\u2611\uFE0E' : '\u2610');
		const choice = (isSelected: boolean, label: string): Pick<ButtonProps, 'label' | 'plain' | 'variant'> =>
			grid ? { label: isSelected ? `▸ ${label}` : label, plain: true } : isSelected ? { label, variant: 'primary' } : { label, plain: true };
		// A table of Boxes, each column a share of the width, so cells keep their colors and still line up without a
		// monospace grid. Never markdown: the cells hold graph text, which a markdown parser would read as links.
		const boxTable = (widths: readonly string[], rows: readonly { key?: string; cells: readonly RenderElement[] }[], head?: readonly string[]): RenderElement => {
			const line = (cells: readonly RenderElement[], key?: string): RenderElement =>
				el.Box({ ...(key === undefined ? {} : { key }), flexDirection: 'row', children: cells.map((cell, i) => el.Box({ width: widths[i] ?? 'auto', children: [cell] })) });
			return el.Box({
				flexDirection: 'column',
				children: [...(head === undefined ? [] : [line(head.map((h) => el.Text({ weight: 'semibold', children: h })))]), ...rows.map((r) => line(r.cells, r.key))],
			});
		};
		// Label and value rows, the label dim: the Desktop form of rows padded into a label column.
		const factTable = (rows: readonly (readonly [string, string])[]): RenderElement =>
			boxTable(['25%', '75%'], rows.map(([label, value]) => ({ cells: [el.Text({ dimColor: true, children: label }), el.Text({ children: value })] })));
		const showDeps = (path: string): Promise<unknown> => {
			forget('deps');
			return act((s) => dropped({ ...s, depsPath: path }, 'deps'), true);
		};
		const accent = paint(palette.nebula, tint);
		const pick = async (project: string): Promise<void> => {
			const from = launchCwd ?? (await $.session.cwd());
			chosen = { from, root: project };
			for (const tab of TABS) forget(tab);
			await act((s) => TABS.reduce(dropped, { ...s, cwd: project }), true);
			try {
				await $.store.set(pickKey(from), project);
			} catch {
				// Not remembered across sessions; this session keeps the pick.
			}
		};
		const switchProject = async (): Promise<void> => {
			const from = launchCwd ?? (await $.session.cwd());
			chosen = undefined;
			for (const tab of TABS) forget(tab);
			await act((s) => TABS.reduce(dropped, { ...s, cwd: from }), true);
			try {
				await $.store.delete(pickKey(from));
			} catch {
				// A pick left in the store is offered again and can be switched again.
			}
		};
		const summary = selected === 'stats' || envelope === undefined ? undefined : summarize(selected, envelope, { direction: depsDirection, path: depsPath, project: projectName(sessionCwd), query: exploreQuery });

		const picking = summary?.items.some((i) => i.project !== undefined) ?? false;

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
				el.Select({
					key: 'deps-direction',
					label: 'Show',
					options: [
						{ value: 'dependencies', label: 'Dependencies (what this file imports)' },
						{ value: 'dependents', label: 'Dependents (what imports this file)' },
					],
					value: depsDirection,
					onSelect: async (value) => {
						if (value !== 'dependencies' && value !== 'dependents') return;
						if (value === depsDirection) return;
						forget('deps');
						await act((s) => dropped({ ...s, direction: value }, 'deps'), true);
					},
				}),
			);
		}
		if (selected === 'unused' && !picking) {
			body.push(
				el.Select({
					key: 'unused-kind',
					label: 'Kind',
					options: [
						{ value: ALL_KINDS, label: 'All kinds' },
						...[...UNUSED_KINDS, ...(unusedKind === undefined || UNUSED_KINDS.includes(unusedKind) ? [] : [unusedKind])].map((k) => ({ value: k, label: k })),
					],
					value: unusedKind ?? ALL_KINDS,
					onSelect: async (value) => {
						const chosenKind = value === ALL_KINDS ? undefined : value;
						if (chosenKind === unusedKind) return;
						forget('unused');
						await act((s) => dropped({ ...s, unusedKind: chosenKind }, 'unused'), true);
					},
				}),
			);
		}
		const hit = p.focus;
		if (selected === 'explore' && hit === undefined) {
			body.push(
				el.Input({
					key: 'explore-query',
					label: 'Symbol',
					value: exploreQuery,
					placeholder: 'name',
					submitLabel: 'search',
					autoFocus: true,
					onSubmit: async (value) => {
						forget('explore');
						await act((s) => dropped({ ...s, query: value.trim() }, 'explore'), true);
					},
				}),
			);
		}
		const firstPage = selected === 'unused' && envelope?.success === true ? orphanPage(envelope.result) : undefined;
		const loaded = firstPage === undefined ? [] : [...firstPage.rows, ...p.morePages];
		const pickedRows = loaded.filter((r) => picked.has(r.symbolId));
		const toggle = (ids: readonly string[], select: boolean): Promise<unknown> =>
			act((s) => ({ ...s, picked: select ? [...new Set([...s.picked, ...ids])] : s.picked.filter((id) => !ids.includes(id)) }));
		if (firstPage !== undefined) {
			if (loaded.length === 0) {
				body.push(el.Text({ dimColor: true, children: 'No unused exports found' }));
			} else {
				body.push(
					el.Box({
						flexDirection: 'column',
						children: [
							el.Box({
								flexDirection: 'row',
								columnGap: 2,
								children: [
									el.Text({ weight: 'semibold', children: `${picked.size} selected` }),
									el.Text({ dimColor: true, children: `of ${grouped(firstPage.total ?? loaded.length)} unused exports` }),
									el.Button({ key: 'select-all', label: 'Select all', hotkey: 'a', plain: true, onPress: () => toggle(loaded.map((r) => r.symbolId), true) }),
								],
							}),
							// The list's keys sit here, not in the footer: a long list scrolls the footer out of view.
							// Desktop shows each hotkey on its button and is used with a pointer, so the key hints are the terminal's.
							...(grid ? [el.Text({ dimColor: true, children: `tab/shift+tab move · enter toggle${picked.size > 0 ? ' · h hand off' : ''}` })] : []),
							...(handoffNote === undefined ? [] : [el.Text({ dimColor: true, children: handoffNote })]),
						],
					}),
				);
				for (const [file, rows] of byFile(loaded)) {
					const ids = rows.map((r) => r.symbolId);
					const all = ids.every((id) => picked.has(id));
					body.push(
						el.Button({ key: `orphan-file:${file}`, label: `${check(all)} ${file}`, plain: true, onPress: () => toggle(ids, !all) }),
						...rows.map((row) =>
							// The file is the header above, so a row names only its line. Desktop: the name is part of the
							// checkbox, so it is a larger target, and the columns are shares of the width.
							!grid
								? el.Box({
										key: `row:${row.symbolId}`,
										flexDirection: 'row',
										paddingLeft: 2,
										children: [
											el.Box({
												width: '50%',
												children: [
													el.Button({
														key: `orphan:${row.symbolId}`,
														label: `${check(picked.has(row.symbolId))} ${row.name}`,
														plain: true,
														onPress: () => toggle([row.symbolId], !picked.has(row.symbolId)),
													}),
												],
											}),
											el.Box({ width: '25%', children: [badge(el, '', forTheme(kind(row.kind), tint))] }),
											el.Box({ width: '25%', children: row.lineEnd === undefined ? [] : [el.Text({ dimColor: true, children: `line ${row.lineEnd}` })] }),
										],
									})
								: el.Box({
								key: `row:${row.symbolId}`,
								flexDirection: 'row',
								columnGap: 1,
								paddingLeft: 2,
								children: [
									fixed([
										el.Button({
											key: `orphan:${row.symbolId}`,
											label: check(picked.has(row.symbolId)),
											plain: true,
											onPress: () => toggle([row.symbolId], !picked.has(row.symbolId)),
										}),
										el.Text({ children: row.name }),
										badge(el, '', forTheme(kind(row.kind), tint)),
									]),
									...(row.lineEnd === undefined ? [] : [el.Text({ dimColor: true, children: `line ${row.lineEnd}` })]),
								],
							}),
						),
					);
				}
				if (nextOffset !== undefined && !loadingMore) {
					body.push(el.Button({ key: 'load-more', label: 'Load more', plain: true, onPress: () => loadMore($, p) }));
				}
				if (loadingMore) body.push(badge(el, 'loading more', forTheme(status('pending'), tint)));
			}
		} else if (selected === 'stats') {
			// Every row from one snapshot; while it is being read, the session's counts as they stand.
			const snapshot = p.stats;
			if (!grid) {
				body.push(
					boxTable(
						['24%', '19%', '19%', '19%', '19%'],
						statsCells(snapshot?.session ?? counts, snapshot?.stored).map(({ label, figures: f }) => ({
							key: `stats:${label}`,
							cells: [
								el.Text({ dimColor: true, children: label }),
								el.Text({ children: f.calls }),
								el.Text({ children: f.symbol }),
								el.Text({ dimColor: true, children: f.literal }),
								el.Text({ weight: 'semibold', children: f.share }),
							],
						})),
						['', 'code_intel calls', 'Symbol-like', 'Literal', SHARE_LABEL],
					),
				);
			} else {
				for (const row of statRows(snapshot?.session ?? counts, snapshot?.stored)) {
					const f = figures(row.counts);
					body.push(
						el.Box({
							key: `stats:${row.label}`,
							flexDirection: 'row',
							children: [
								el.Text({ dimColor: true, children: row.label.padEnd(LABEL_WIDTH) }),
								el.Box({
									flexDirection: 'column',
									children: [
										el.Box({
											flexDirection: 'row',
											columnGap: 2,
											flexWrap: 'wrap',
											children: [
												el.Text({ children: f.calls }),
												el.Text({ children: f.symbol }),
												el.Text({ dimColor: true, children: f.literal }),
												el.Box({
													flexDirection: 'row',
													columnGap: 1,
													children: [el.Text({ weight: 'semibold', children: f.share }), el.Text({ dimColor: true, children: SHARE_LABEL })],
												}),
											],
										}),
										...(row.split === undefined ? [] : [el.Text({ dimColor: true, children: row.split })]),
									],
								}),
							],
						}),
					);
				}
			}
			if (snapshot === undefined) {
				if (historyReading) body.push(badge(el, 'reading the stored counts', forTheme(status('pending'), tint)));
			}
			else if (snapshot.stored === undefined) body.push(el.Text({ dimColor: true, children: UNREAD_NOTE }));
			body.push(el.Text({ dimColor: true, children: SHARE_NOTE }));
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
								fixed([
									el.Button({
										key: `hit:${h.id}`,
										label: h.name,
										plain: true,
										onPress: async () => {
											const written = act((s) => ({ ...s, focus: h, section: 'details' }));
											if (p.drill[h.id] === undefined && !drillPending.has(h.id)) void runDrill($, h.id, h.kind, sessionCwd, written);
											await written;
										},
									}),
									badge(el, '', forTheme(kind(h.kind), tint)),
								]),
								place(where(h)),
							],
						}),
					);
				}
				body.push(...stamp(envelope));
			} else {
				const drilled = p.drill[hit.id];
				const result = isRecord(drilled?.result) ? drilled.result : {};
				const aliasNote = el.Text({ dimColor: true, children: 'Callers importing through path aliases or export * barrels may be missing.' });
				const sections: [Section, string][] = [
					['details', 'Details'],
					['usages', 'Usages'],
					['impact', 'Impact'],
					// Only a kind with a call graph offers it; core refuses the read for any other.
					...(hasCallGraph(hit.kind) ? [['calls', 'Call graph'] as [Section, string]] : []),
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
											fixed([badge(el, '', forTheme(kind(hit.kind), tint)), el.Text({ weight: 'semibold', children: hit.name })]),
											place(where(hit)),
											fixed([
												el.Button({
													key: 'copy-location',
													label: 'Copy location',
													plain: true,
													dimColor: true,
													onPress: async (press) => {
														const { isCopied } = await $.ui.copy({ text: where(hit), surface: press.surface });
														await act((s) => ({ ...s, exploreNote: isCopied ? 'Copied' : 'Could not copy' }));
													},
												}),
											]),
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
										...choice(name === section, label),
										onPress: () => act((s) => ({ ...s, section: name })),
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
													if (lines.length === 0) return [el.Text({ dimColor: true, children: 'No details returned' })];
													return grid ? lines.map((l) => el.Text({ children: l })) : [factTable(detailRows(result['details']))];
												}
												if (section === 'usages') {
													const lines = usageLines(result['usages']);
													if (lines.length === 0) return [el.Text({ dimColor: true, children: 'No usages found' }), aliasNote];
													if (grid) return [...lines.map((l) => el.Text({ children: l })), aliasNote];
													const total = usageTotal(result['usages']);
													const rows = usageRows(result['usages']);
													return [
														...(total === undefined ? [] : [el.Text({ children: total })]),
														...(rows.length === 0 ? [] : [boxTable(['75%', '25%'], rows.map((r) => ({ cells: r.map((t) => el.Text({ children: t })) })), ['Location', 'Usage'])]),
														aliasNote,
													];
												}
												if (section === 'impact') {
													const view = impactView(result['impact']);
													const facts: [string, string][] = [
														...(view.files === undefined ? [] : [['Files', String(view.files)] as [string, string]]),
														...(view.direct === undefined ? [] : [['Direct', String(view.direct)] as [string, string]]),
														...(view.transitive === undefined ? [] : [['Transitive', String(view.transitive)] as [string, string]]),
														...(view.tests === undefined && view.production === undefined
															? []
															: [['Files', `${view.tests ?? 0} test · ${view.production ?? 0} production`] as [string, string]]),
													];
													return [
														...(view.riskLevel === undefined ? [] : [badge(el, '', forTheme(risk(view.riskLevel), tint))]),
														...(grid ? facts.map(([label, value]) => labeled(label, value)) : facts.length === 0 ? [] : [factTable(facts)]),
														...(grid
															? view.top.map((d) => badge(el, d.name, forTheme(kind(d.kind), tint)))
															: view.top.length === 0
																? []
																: [boxTable(['60%', '40%'], view.top.map((d) => ({ cells: [el.Text({ children: d.name }), badge(el, '', forTheme(kind(d.kind), tint))] })), ['Dependent', 'Kind'])]),
														aliasNote,
													];
												}
												const tree = callTree(result['calls']);
												return tree.length === 0
													? [el.Text({ dimColor: true, children: 'No callers or callees found' })]
													: tree.map((l) => el.Text({ ...(l.depth === 0 ? { weight: 'semibold' } : {}), children: `${'  '.repeat(l.depth)}${l.text}` }));
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
			// On Desktop, each run of labeled facts is one table.
			const facts: RenderElement[][] = [];
			const flush = (): void => {
				if (facts.length > 0) body.push(boxTable(['25%', '75%'], facts.splice(0).map((cells) => ({ cells }))));
			};
			for (const item of summary.items) {
				const path = item.path;
				const project = item.project;
				if (!grid && item.label !== undefined && project === undefined && path === undefined) {
					const tone =
						item.badge === undefined ? undefined : forTheme(item.badge.kind === 'status' ? status(item.badge.value) : kind(item.badge.value), tint);
					facts.push([el.Text({ dimColor: true, children: item.label }), tone === undefined ? el.Text({ children: item.text }) : badge(el, item.text, tone)]);
					continue;
				}
				flush();
				if (project !== undefined) {
					// The tabs are hidden while picking, so the digits are free for the rows.
					const n = row++;
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
								el.Text({ dimColor: true, children: projectDetail(p.details[project]) }),
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
					body.push(el.Text({ weight: 'semibold', children: item.text }));
				} else {
					body.push(el.Text(item.dim ? { dimColor: true, children: item.text } : { children: item.text }));
				}
			}
			flush();
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
		const canSwitch = !picking && launchCwd !== undefined && sessionCwd !== undefined && sessionCwd !== launchCwd;
		const project = picking ? undefined : projectName(sessionCwd);
		const close = {
			key: 'close',
			label: 'Close',
			role: 'dismiss' as const,
			onPress: async () => {
				// The ui.close hook below sees the person's close (Esc), not this plugin's
				// own close from a callback, so the button clears the state itself.
				await $.ui.close({ id: PANE });
				forgetPane();
				await act(() => NO_PANE);
			},
		};
		const tabs = TABS.map((tab, index) =>
			el.Button({
				key: `tab-${tab}`,
				...choice(tab === selected, TAB_LABEL[tab]),
				hotkey: String(index + 1),
				onPress: () => act((s) => ({ ...s, tab }), true),
			}),
		);

		// The pane's width less its padding; Claude Code redraws when it changes.
		const columns = typeof e.props.bodyColumns === 'number' ? e.props.bodyColumns - 2 : 0;
		const head = header(el, columns, e.surface === 'terminal', tint);
		// Desktop draws text in a proportional font, where a row of `─` overruns the pane and wraps.
		const rule =
			e.surface === 'desktop'
				? el.Markdown({ text: '---' })
				: el.Text({ dimColor: true, children: '─'.repeat(Math.max(10, Math.min(BANNER_WIDTH, columns))) });
		const keys = picking
			? '1-9 open a project · enter opens the selected one · esc close'
			: selected === 'explore'
					? `${hit === undefined ? 'esc leaves the search field' : 'b back'} · 1-6 switch tabs · r refresh${canSwitch ? ' · p switch project' : ''} · esc close`
					: `1-6 switch tabs · r refresh${canSwitch ? ' · p switch project' : ''} · esc close`;

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
									...(project === undefined ? [] : [el.Text({ weight: 'semibold', children: project })]),
									...(project !== undefined && meta !== undefined ? [el.Text({ dimColor: true, children: '·' })] : []),
									...(meta === undefined ? [] : [el.Text({ dimColor: true, children: meta })]),
									...((project !== undefined || meta !== undefined) && canSwitch ? [el.Text({ dimColor: true, children: '·' })] : []),
									...(canSwitch
										? [el.Button({ key: 'switch-project', label: 'Switch project', hotkey: 'p', plain: true, onPress: switchProject })]
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
											onPress: () => act((s) => ({ ...s, picked: [], handoffNote: undefined })),
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
													forgetPane();
													await act(() => NO_PANE);
												} else {
													await act((s) => ({ ...s, handoffNote: 'Could not fill the prompt box (a dialog may be open). Close it and try again.' }));
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
											onPress: () => act((s) => ({ ...s, focus: undefined, section: 'details', exploreNote: undefined })),
										},
										{
											key: 'ask-claude',
											label: 'Ask Claude',
											onPress: async () => {
												const { isFilled } = await $.prompt.fill({ text: askText(hit) });
												if (isFilled) {
													await $.ui.close({ id: PANE });
													forgetPane();
													await act(() => NO_PANE);
												} else {
													await act((s) => ({ ...s, exploreNote: 'Could not fill the prompt box (a dialog may be open). Close it and try again.' }));
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
										forget(selected);
										return act((s) => dropped(s, s.tab), true);
									},
								}),
						...(grid ? [el.Text({ dimColor: true, children: keys })] : []),
					],
				}),
			],
		});
	});

	// A close other than an unload. An unload never runs this: the engine drops the pane before hooks hear of it and
	// skips its opener's, and a reload keeps an open pane up, with its state.
	on('ui.close', { id: PANE }, async ($, e, next) => {
		const r = await next(e);
		forgetPane();
		await update($, PANE_STATE, () => NO_PANE).catch(() => undefined);
		return r;
	});
}
