import type { EngineInterface, On, PluginOptions, RenderElement } from 'claude-code';
import { canDraw, codeIntel } from './lib';
import type { CodeIntelEnvelope, CodeIntelError } from './lib';
import { BANNER_WIDTH, PROMPT, badge, buttonRow, forTheme, header, kind, paint, palette, scheme, status } from './theme';
import type { Scheme } from './theme';

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

/** One line under the tab row saying what the tab shows. */
const TAB_HINT: Readonly<Record<Tab, string>> = {
	status: 'Whether Constellation is reachable and your access key is accepted.',
	diagnose: 'What the Constellation index holds for this project.',
	deps: 'What a file imports, or what imports it.',
	unused: 'Exports nothing imports. Verify each one before deleting it.',
};

/** The column a labeled row's value starts in. */
const LABEL_WIDTH = 13;

/** Rows a tab draws before it ends with a "+N more" line, and lines the text fallback keeps. */
const MAX_ROWS = 15;
const MAX_TEXT_LINES = 6;

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
	const message = error.message ?? 'The request failed';
	const guidance = error.guidance ?? [];
	const candidates = error.candidates ?? [];
	// With project roots to offer (the working directory sits above several
	// projects), the pane asks for one: no error badge, and none of the
	// guidance written for an agent (re-invoke code_intel with a cwd).
	const items: Item[] =
		candidates.length > 0
			? [
					{ text: 'Choose a project', heading: true },
					{ text: 'This folder holds several Constellation projects.', dim: true },
					...candidates.map((c): Item => ({ text: projectName(c) ?? c, project: c })),
				]
			: [{ badge: { kind: 'status', value: 'error' }, text: `${error.code}: ${message}` }, ...guidance.map((g): Item => ({ text: g, dim: true }))];
	return { lines: [`${error.code}: ${message}`, ...guidance], items, error };
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

/** The `$.store` key that remembers the project picked in `from`, across sessions. */
function pickKey(from: string): string {
	return `project:${from}`;
}

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
	$.ui.invalidate('ui.render');
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
		if (chosen?.from !== cwd) {
			try {
				const saved = await $.store.get(pickKey(cwd));
				if (typeof saved === 'string') chosen = { from: cwd, root: saved };
			} catch {
				// Nothing saved, or the store is unavailable: the picker asks again.
			}
		}
		const dir = target(cwd);
		if (!canDraw(await $.session.surfaces())) {
			if (tab === 'deps' && path === undefined) return { text: 'Usage: /constellation deps <file>' };
			const envelope = await codeIntel(
				{ connect: (s) => $.mcp.connect(s), call: (s, t, a) => $.mcp.call(s, t, a) },
				codeFor(tab, 'dependencies', path ?? ''),
				{ cwd: dir },
			);
			const summary = summarize(tab, envelope, { path, project: projectName(dir) });
			const meta = metadata(envelope);
			const body = [...summary.lines.slice(0, MAX_TEXT_LINES), ...(meta === undefined ? [] : [meta])];
			return { text: [`${PROMPT} ${tab}`, ...body.map((l) => `- ${l.trim()}`)].join('\n') };
		}
		reset();
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
		if (envelope === undefined && !pending.has(selected) && !needsPath) void runQuery($, selected);
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
		const summary = envelope === undefined ? undefined : summarize(selected, envelope, { direction: depsDirection, path: depsPath, project: projectName(sessionCwd) });

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
		if (summary !== undefined) {
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
			: `1-4 switch tabs · r refresh${canSwitch ? ' · p switch project' : ''} · esc close`;

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
