import type { McpToolResult, On, PaneOpenArgs, RenderSurface } from 'claude-code';
import { describe, expect, test } from 'claude-code/testing';
import type { Engine } from 'claude-code/testing';
import { COMMAND, parseArgs, summarize } from './command';
import type { Tab } from './command';
import { palette } from './theme';

const SERVER = 'plugin:constellation:constellation';
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const INDEXED_AT = '2026-01-01T00:00:00.000Z';
const SURFACES = ['terminal', 'desktop'] as const;
const TAB_HINT_STATUS = 'Whether Constellation is reachable and your access key is accepted.';

const PING = { pong: true };
const CAPS = {
	isIndexed: true,
	languages: ['typescript'],
	symbolCount: 120,
	fileCount: 14,
	indexedBranch: 'main',
};
const DEPS = {
	file: 'src/app.ts',
	directDependencies: [
		{ type: 'file', filePath: 'src/lib.ts', isDefault: false, isNamespace: false },
		{ type: 'module', filePath: null, moduleName: 'zod', isDefault: false, isNamespace: false },
	],
};
const DEPENDENTS = { file: 'src/app.ts', directDependents: [{ filePath: 'src/main.ts' }] };
const UNUSED = {
	orphanedSymbols: [
		{ symbolId: 'a', name: 'helper', kind: 'function', filePath: 'src/util.ts', isExported: true, reason: 'x', confidence: 1 },
		{ symbolId: 'b', name: 'Legacy', kind: 'class', filePath: 'src/util.ts', isExported: true, reason: 'x', confidence: 1 },
	],
	orphanedFiles: [],
	summary: { totalOrphanedSymbols: 2, totalOrphanedFiles: 0, potentialDeletions: 2 },
};

/** A code_intel response whose envelope carries `result` and the graph's as-of metadata. */
function success(result: unknown): McpToolResult {
	const body = { success: true, result, asOfCommit: COMMIT, lastIndexedAt: INDEXED_AT };
	return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false };
}

function failure(code: string, message: string, guidance: string[] = []): McpToolResult {
	const body = { success: false, error: { code, message, guidance } };
	return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false };
}

/** What code_intel answers for the code a tab sends. */
function answer(code: string): McpToolResult {
	if (code.includes('getCapabilities')) return success({ ping: PING, caps: CAPS });
	if (code.includes('getDependencies')) return success(DEPS);
	if (code.includes('getDependents')) return success(DEPENDENTS);
	if (code.includes('findOrphanedCode')) return success(UNUSED);
	return success(PING);
}

type World = {
	surfaces?: readonly RenderSurface[];
	theme?: string;
	answer?: (code: string, cwd: string) => McpToolResult | Promise<McpToolResult>;
	/** Makes the hook that answers this event throw. */
	throws?: 'session.cwd' | 'config.list';
	/** What `$.store` already holds, as from an earlier session. */
	saved?: [string, unknown][];
};

/** Answers everything beneath the plugin and returns the queries sent and the pane events seen. */
function world(on: On, { surfaces = ['terminal'], theme = 'dark', answer: respond = answer, throws, saved = [] }: World = {}) {
	const codes: string[] = [];
	const cwds: string[] = [];
	const events: string[] = [];
	const opens: PaneOpenArgs[] = [];
	let turns = 0;
	const armed = { cwd: false };
	const store = new Map<string, unknown>(saved);
	on('session.cwd', () => {
		if (throws === 'session.cwd' && armed.cwd) throw new Error('no cwd');
		return { value: '/work/app' };
	});
	on('session.surfaces', () => ({ value: surfaces }));
	on('config.list', () => {
		if (throws === 'config.list') throw new Error('no config');
		return {
			value: [{ key: 'theme', label: 'Theme', kind: 'choice', value: theme, provider: { plugin: 'engine', tier: 'core' }, isLocked: false }],
		};
	});
	on('mcp.connect', () => ({ value: { isConnected: true, server: SERVER } }));
	on('mcp.call', async (_, e) => {
		codes.push(String(e.args.code));
		cwds.push(String(e.args.cwd));
		return { value: await respond(String(e.args.code), String(e.args.cwd)) };
	});
	on('ui.open', (_, e) => {
		opens.push(e);
		events.push(`open:${e.id}`);
		return { value: { isPlaced: true } };
	});
	on('ui.close', (_, e) => {
		events.push(`close:${e.id}`);
		return { value: undefined };
	});
	on('turn.start', (_, e) => {
		turns += 1;
		return { turnId: e.turnId };
	});
	on('store.get', (_, e) => ({ value: store.get(e.key) }));
	on('store.set', (_, e) => {
		store.set(e.key, e.value);
		return { value: undefined };
	});
	on('store.delete', (_, e) => {
		store.delete(e.key);
		return { value: undefined };
	});
	return { codes, cwds, events, opens, store, turns: () => turns, armed };
}

async function run($: Engine, args = '') {
	return $.command.run({
		command: COMMAND,
		args,
		origin: { kind: 'composer' },
		presentation: { isFullscreen: true, columns: 120 },
	});
}

/** Mounts the pane the command opened, as a surface drawing it. */
async function mountPane($: Engine, surface: (typeof SURFACES)[number], bodyColumns = 100) {
	return $.ui.mount({
		plugin: 'constellation',
		surface,
		component: 'Pane',
		requestId: 'constellation',
		props: { title: 'Constellation', isFocused: true, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
	});
}

/** The Text whose only child is exactly `text` (`find` matches the enclosing line too). */
async function exact(ui: Awaited<ReturnType<typeof mountPane>>, text: string) {
	return (await ui.findAll({ type: 'Text' })).find((t) => t.children.length === 1 && t.children[0] === text);
}

/** Whether any Text in the drawing reads `pattern`. */
async function reads(ui: Awaited<ReturnType<typeof mountPane>>, pattern: RegExp) {
	return (await ui.find({ type: 'Text', text: pattern })) !== undefined;
}

/** Lets the query a drawing started settle and the redraw it asked for run. */
async function settle(): Promise<void> {
	for (let i = 0; i < 50; i++) await Promise.resolve();
}

describe('parseArgs', () => {
	test('defaults to the status tab', () => {
		expect(parseArgs('')).toEqual({ tab: 'status' });
		expect(parseArgs('   ')).toEqual({ tab: 'status' });
		expect(parseArgs('nonsense')).toEqual({ tab: 'status' });
	});

	test('the first word selects the tab', () => {
		expect(parseArgs('diagnose')).toEqual({ tab: 'diagnose' });
		expect(parseArgs('UNUSED')).toEqual({ tab: 'unused' });
		expect(parseArgs('status extra words')).toEqual({ tab: 'status' });
	});

	test('deps takes an optional file path', () => {
		expect(parseArgs('deps')).toEqual({ tab: 'deps' });
		expect(parseArgs('deps src/app.ts')).toEqual({ tab: 'deps', path: 'src/app.ts' });
		expect(parseArgs('deps   src/my file.ts ')).toEqual({ tab: 'deps', path: 'src/my file.ts' });
	});
});

describe('summarize', () => {
	const ok = (result: unknown) => ({ success: true, result });

	test('status reports connection and auth', () => {
		const s = summarize('status', ok(PING), { project: 'app' });
		expect(s.lines).toEqual(['Connection: ok', 'Auth: ok', 'Project: app']);
		expect(s.error).toBeUndefined();
	});

	test('a cwd that is not a project offers its candidate roots instead of the agent guidance', () => {
		const error = { code: 'CWD_NOT_INDEXED', message: 'no project', guidance: ['re-invoke code_intel'], candidates: ['/w/core', '/w/web'] };
		const s = summarize('status', { success: false, error });
		expect(s.items.filter((i) => i.project !== undefined).map((i) => [i.text, i.project])).toEqual([
			['core', '/w/core'],
			['web', '/w/web'],
		]);
		expect(s.items.find((i) => i.text === 're-invoke code_intel')).toBeUndefined();
		expect(s.items.find((i) => i.badge !== undefined)).toBeUndefined();
		expect(s.lines).toContain('re-invoke code_intel');
	});

	test('status without a pong is unknown', () => {
		expect(summarize('status', ok({})).lines).toEqual(['Connection: unknown', 'Auth: unknown']);
	});

	test('diagnose adds the capabilities', () => {
		const lines = summarize('diagnose', ok({ ping: PING, caps: CAPS })).lines;
		expect(lines).toContain('Index: ok');
		expect(lines).toContain('Languages: typescript');
		expect(lines).toContain('Symbols: 120');
		expect(lines).toContain('Files: 14');
		expect(lines).toContain('Branch: main');
	});

	test('diagnose reads an unindexed project as stale', () => {
		const lines = summarize('diagnose', ok({ ping: PING, caps: { isIndexed: false } })).lines;
		expect(lines).toContain('Index: stale (not indexed)');
	});

	test('deps lists file rows and dims modules', () => {
		const s = summarize('deps', ok(DEPS), { direction: 'dependencies', path: 'src/app.ts' });
		expect(s.lines[0]).toBe('src/app.ts depends on 2');
		expect(s.items.find((i) => i.path === 'src/lib.ts')).toBeDefined();
		expect(s.items.find((i) => i.text === 'zod')).toMatchObject({ dim: true });
	});

	test('deps reads dependents in the other direction', () => {
		const s = summarize('deps', ok(DEPENDENTS), { direction: 'dependents', path: 'src/app.ts' });
		expect(s.lines).toEqual(['src/app.ts is used by 1', 'src/main.ts']);
	});

	test('deps with nothing says so', () => {
		const s = summarize('deps', ok({ file: 'a.ts', directDependencies: [] }), { path: 'a.ts' });
		expect(s.lines).toEqual(['a.ts depends on 0', 'No dependencies found']);
	});

	test('unused groups symbols by file with their kind', () => {
		const s = summarize('unused', ok(UNUSED));
		expect(s.lines).toEqual(['2 unused symbols', 'src/util.ts', '  helper (function)', '  Legacy (class)']);
		expect(s.items.filter((i) => i.badge?.kind === 'kind')).toHaveLength(2);
	});

	test('unused with nothing says so', () => {
		expect(summarize('unused', ok({ orphanedSymbols: [], orphanedFiles: [] })).lines).toEqual(['No unused symbols found']);
	});

	test('a result of the wrong shape never throws', () => {
		for (const tab of ['status', 'diagnose', 'deps', 'unused'] as const satisfies readonly Tab[]) {
			expect(() => summarize(tab, ok('text'))).not.toThrow();
			expect(() => summarize(tab, ok(null))).not.toThrow();
		}
	});

	test('a long list ends with a count of the rest', () => {
		const many = { file: 'a.ts', directDependents: Array.from({ length: 20 }, (_, i) => ({ filePath: `src/f${i}.ts` })) };
		const lines = summarize('deps', ok(many), { direction: 'dependents', path: 'a.ts' }).lines;
		expect(lines.at(-1)).toBe('+5 more');
	});

	test('an error is the code, the message and the guidance', () => {
		const s = summarize('status', { success: false, error: { code: 'AUTH_ERROR', message: 'Bad key', guidance: ['Run constellation auth'] } });
		expect(s.lines).toEqual(['AUTH_ERROR: Bad key', 'Run constellation auth']);
		expect(s.items[0]).toMatchObject({ badge: { kind: 'status', value: 'error' } });
		expect(s.items[1]).toMatchObject({ dim: true });
		expect(s.error?.code).toBe('AUTH_ERROR');
	});
});

describe('command.run without a pane', () => {
	for (const surfaces of [['vscode'], []] as const) {
		test(`answers with text on ${surfaces.join() || 'no surface'} and opens nothing`, async ($, on) => {
			const { events, turns } = world(on, { surfaces });
			const r = await run($, 'unused');
			expect(r.text).toContain('2 unused symbols');
			expect(r.text).toContain('helper (function)');
			expect(r.text).toContain('as of 0123456');
			expect(events).toEqual([]);
			expect(turns()).toBe(0);
		});
	}

	test('status text names the connection', async ($, on) => {
		world(on, { surfaces: ['vscode'] });
		const r = await run($);
		expect(r.text).toContain('Connection: ok');
		expect(r.text).toContain('Project: app');
	});

	test('an error answers with its code and guidance', async ($, on) => {
		world(on, { surfaces: ['vscode'], answer: () => failure('AUTH_ERROR', 'Bad key', ['Run constellation auth']) });
		const r = await run($);
		expect(r.text).toContain('AUTH_ERROR: Bad key');
		expect(r.text).toContain('Run constellation auth');
	});

	test('deps needs a file', async ($, on) => {
		const { codes } = world(on, { surfaces: ['vscode'] });
		const r = await run($, 'deps');
		expect(r.text).toBe('Usage: /constellation deps <file>');
		expect(codes).toEqual([]);
	});

	test('deps sends the path as a JSON string', async ($, on) => {
		const { codes } = world(on, { surfaces: ['vscode'] });
		await run($, 'deps src/"odd".ts');
		expect(codes).toEqual(['return await api.getDependencies({ filePath: "src/\\"odd\\".ts" })']);
	});
});

describe('the pane', () => {
	test('the command opens the pane and answers without a model call', async ($, on) => {
		const { events, turns } = world(on);
		const r = await run($);
		expect(r).toEqual({});
		expect(events).toEqual(['open:constellation']);
		expect(turns()).toBe(0);
	});

	for (const surface of SURFACES) {
		test(`the status tab draws the title, mark, badges and commit on ${surface}`, async ($, on) => {
			world(on);
			await run($);
			const ui = await mountPane($, surface);
			await settle();
			// The terminal draws the CLI banner, starting in galactic; Desktop the compact one.
			const first = surface === 'terminal' ? '╭──' : '>';
			expect((await exact(ui, first))?.props['color']).toBe(palette.galactic);
			expect((await exact(ui, 'app'))?.props['bold']).toBe(true);
			expect(await ui.find({ type: 'Text', text: TAB_HINT_STATUS })).toBeDefined();
			expect(await ui.find({ type: 'Text', text: /1-4 switch tabs · r refresh · esc close/ })).toBeDefined();
			expect(await ui.find({ type: 'Text', text: /as of 0123456 · indexed/ })).toBeDefined();
			expect(await ui.find({ type: 'Text', text: /✓ ok/ })).toBeDefined();
			expect(await ui.find({ type: 'Text', text: /Connection/ })).toBeDefined();
		});

		test(`the diagnose tab draws the capabilities on ${surface}`, async ($, on) => {
			world(on);
			await run($, 'diagnose');
			const ui = await mountPane($, surface);
			await settle();
			expect(await ui.find({ type: 'Text', text: '120' })).toBeDefined();
			expect(await ui.find({ type: 'Text', text: 'main' })).toBeDefined();
		});

		test(`the deps tab draws file rows with the path field on ${surface}`, async ($, on) => {
			world(on);
			await run($, 'deps src/app.ts');
			const ui = await mountPane($, surface);
			await settle();
			expect(await ui.find({ type: 'Input', key: 'deps-path' })).toMatchObject({ props: { value: 'src/app.ts' } });
			expect(await ui.find({ type: 'Button', key: 'dep:src/lib.ts' })).toBeDefined();
			expect(await ui.find({ type: 'Text', text: /as of 0123456/ })).toBeDefined();
		});

		test(`the unused tab draws kind badges grouped by file on ${surface}`, async ($, on) => {
			world(on);
			await run($, 'unused');
			const ui = await mountPane($, surface);
			await settle();
			expect(await ui.find({ type: 'Text', text: 'src/util.ts' })).toMatchObject({ props: { dimColor: true } });
			expect(await ui.find({ type: 'Text', text: /• function helper/ })).toBeDefined();
			const kinds = await ui.findAll({ type: 'Text', text: /• class/ });
			expect(kinds.length).toBeGreaterThan(0);
		});
	}

	test('an error draws its code as an error badge with the guidance dim', async ($, on) => {
		world(on, { answer: () => failure('PROJECT_NOT_INDEXED', 'Not indexed', ['Run constellation index']) });
		await run($);
		const ui = await mountPane($, 'terminal');
		await settle();
		expect(await ui.find({ type: 'Text', text: /✗ error PROJECT_NOT_INDEXED/ })).toBeDefined();
		expect(await ui.find({ type: 'Text', text: 'Run constellation index' })).toMatchObject({ props: { dimColor: true } });
		expect(await ui.find({ type: 'Button', key: 'dep:x' })).toBeUndefined();
	});

	test('the pane redraws when the query lands, replacing the pending badge', async ($, on) => {
		let release: (value: McpToolResult) => void = () => {};
		const gate = new Promise<McpToolResult>((resolve) => {
			release = resolve;
		});
		world(on, { answer: () => gate });
		await run($);
		const ui = await mountPane($, 'terminal');
		expect(await ui.find({ type: 'Text', text: /◐ pending/ })).toBeDefined();
		expect(await ui.find({ type: 'Text', text: /Connection/ })).toBeUndefined();
		release(success(PING));
		await settle();
		expect(await ui.find({ type: 'Text', text: /◐ pending/ })).toBeUndefined();
		expect(await ui.find({ type: 'Text', text: /Connection/ })).toBeDefined();
	});

	/** The first query waits on a gate; later ones answer at once. Returns the gate's release. */
	function gateFirst(on: On, stale: McpToolResult) {
		let release: (value: McpToolResult) => void = () => {};
		const gate = new Promise<McpToolResult>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		const { codes } = world(on, { answer: () => (calls++ === 0 ? gate : success(PING)) });
		return { codes, release: () => release(stale) };
	}

	test('an answer that lands after a refresh is discarded and the fresh one is cached', async ($, on) => {
		const { codes, release } = gateFirst(on, failure('STALE_CODE', 'stale'));
		await run($);
		const ui = await mountPane($, 'terminal');
		await settle();
		await ui.press({ key: 'refresh' });
		await settle();
		expect(codes).toHaveLength(2);
		release();
		await settle();
		expect(await ui.find({ type: 'Text', text: /STALE_CODE/ })).toBeUndefined();
		expect(await ui.find({ type: 'Text', text: /Connection/ })).toBeDefined();
		await ui.press({ key: 'tab-unused' });
		await settle();
		await ui.press({ key: 'tab-status' });
		await settle();
		expect(codes).toHaveLength(3);
		expect(await ui.find({ type: 'Text', text: /Connection/ })).toBeDefined();
	});

	test('an answer that lands after the deps direction toggled is discarded', async ($, on) => {
		let calls = 0;
		let release: (value: McpToolResult) => void = () => {};
		const gate = new Promise<McpToolResult>((resolve) => {
			release = resolve;
		});
		world(on, { answer: (code) => (calls++ === 0 ? gate : answer(code)) });
		await run($, 'deps src/app.ts');
		const ui = await mountPane($, 'terminal');
		await settle();
		await ui.press({ key: 'deps-toggle' });
		await settle();
		release(success(DEPS));
		await settle();
		expect(await ui.find({ type: 'Button', key: 'dep:src/lib.ts' })).toBeUndefined();
		expect(await ui.find({ type: 'Button', key: 'dep:src/main.ts' })).toBeDefined();
	});

	test('an answer that lands after the pane closed is not kept', async ($, on) => {
		const { codes, release } = gateFirst(on, success(PING));
		await run($);
		const ui = await mountPane($, 'terminal');
		await settle();
		await ui.press({ key: 'close' });
		release();
		await settle();
		await ui.unmount();
		const again = await mountPane($, 'terminal');
		await settle();
		expect(codes).toHaveLength(2);
		expect(await again.find({ type: 'Text', text: /Connection/ })).toBeDefined();
	});

	test('a failing MCP call draws an error badge', async ($, on) => {
		world(on, {
			answer: () => {
				throw new Error('socket closed');
			},
		});
		await run($);
		const ui = await mountPane($, 'terminal');
		await settle();
		expect(await ui.find({ type: 'Text', text: /✗ error MCP_CALL_FAILED/ })).toBeDefined();
		expect(await ui.find({ type: 'Text', text: /no implementation for mcp\.call/ })).toBeDefined();
	});

	test('a drawing that cannot read the working directory draws an error badge', async ($, on) => {
		const { armed } = world(on, { throws: 'session.cwd' });
		await run($);
		const first = await mountPane($, 'terminal');
		await settle();
		await first.press({ key: 'close' });
		await first.unmount();
		armed.cwd = true;
		const again = await mountPane($, 'terminal');
		await settle();
		expect(await again.find({ type: 'Text', text: /✗ error MCP_CALL_FAILED/ })).toBeDefined();
		expect(await again.find({ type: 'Text', text: /MCP_CALL_FAILED: no implementation for session\.cwd/ })).toBeDefined();
	});

	test('an unreadable theme falls back to the dark colors', async ($, on) => {
		world(on, { theme: 'light-ansi', throws: 'config.list' });
		await run($);
		const ui = await mountPane($, 'terminal');
		await settle();
		const badge = (await ui.findAll({ type: 'Text' })).find((t) => t.children.includes('✓ ok'));
		expect(badge?.props['color']).toBe(palette.cosmic);
	});

	test('a surface that is neither terminal nor desktop passes through', async ($, on) => {
		world(on);
		on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'fallthrough' }));
		await run($);
		const ui = await $.ui.mount({
			plugin: 'constellation',
			surface: 'vscode',
			component: 'Pane',
			requestId: 'constellation',
			props: { title: 'Constellation', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
		});
		await settle();
		expect(await ui.find({ type: 'Text', text: 'Constellation' })).toBeUndefined();
		expect(await ui.find({ type: 'Text', text: 'fallthrough' })).toBeDefined();
	});

	test('a tab is queried once and cached', async ($, on) => {
		const { codes } = world(on);
		await run($);
		const ui = await mountPane($, 'terminal');
		await settle();
		await ui.press({ key: 'tab-unused' });
		await settle();
		await ui.press({ key: 'tab-status' });
		await settle();
		expect(codes).toHaveLength(2);
	});

	test('the tab buttons switch tabs', async ($, on) => {
		world(on);
		await run($);
		const ui = await mountPane($, 'terminal');
		await settle();
		const labels = async () => (await ui.findAll({ type: 'Button' })).map((b) => String(b.props['label']));
		expect(await labels()).toContain('▸ Status');
		await ui.press({ key: 'tab-diagnose' });
		await settle();
		expect(await labels()).toContain('▸ Diagnose');
		expect(await ui.find({ type: 'Text', text: '120' })).toBeDefined();
		await ui.press({ key: 'tab-deps' });
		expect(await ui.find({ type: 'Input', key: 'deps-path' })).toBeDefined();
		await ui.press({ key: 'tab-unused' });
		await settle();
		expect(await ui.find({ type: 'Text', text: /• function helper/ })).toBeDefined();
		await ui.press({ key: 'tab-status' });
		expect(await labels()).toContain('▸ Status');
	});

	test('the tab buttons carry the digit hotkeys and refresh carries r', async ($, on) => {
		world(on);
		await run($);
		const ui = await mountPane($, 'terminal');
		const hotkeys = Object.fromEntries((await ui.findAll({ type: 'Button' })).map((b) => [b.key, b.props['hotkey']]));
		expect(hotkeys).toMatchObject({ 'tab-status': '1', 'tab-diagnose': '2', 'tab-deps': '3', 'tab-unused': '4', refresh: 'r' });
		expect(hotkeys['close']).toBeUndefined();
	});

	test('refresh asks again', async ($, on) => {
		const { codes } = world(on);
		await run($);
		const ui = await mountPane($, 'terminal');
		await settle();
		expect(codes).toHaveLength(1);
		await ui.press({ key: 'refresh' });
		await settle();
		expect(codes).toHaveLength(2);
	});

	test('the toggle switches deps between dependencies and dependents', async ($, on) => {
		const { codes } = world(on);
		await run($, 'deps src/app.ts');
		const ui = await mountPane($, 'terminal');
		await settle();
		await ui.press({ key: 'deps-toggle' });
		await settle();
		expect(codes.at(-1)).toContain('getDependents');
		expect(await ui.find({ type: 'Button', key: 'dep:src/main.ts' })).toBeDefined();
	});

	test('pressing a deps row follows that file', async ($, on) => {
		const { codes } = world(on);
		await run($, 'deps src/app.ts');
		const ui = await mountPane($, 'terminal');
		await settle();
		await ui.press({ key: 'dep:src/lib.ts' });
		await settle();
		expect(codes.at(-1)).toContain('"src/lib.ts"');
		expect(await ui.find({ type: 'Input', key: 'deps-path' })).toMatchObject({ props: { value: 'src/lib.ts' } });
	});

	test('submitting the path field queries that file', async ($, on) => {
		const { codes } = world(on);
		await run($, 'deps');
		const ui = await mountPane($, 'terminal');
		await settle();
		expect(codes).toEqual([]);
		await ui.input({ key: 'deps-path', text: ' src/app.ts ' });
		await settle();
		expect(codes).toEqual(['return await api.getDependencies({ filePath: "src/app.ts" })']);
	});

	test('the close button closes the pane', async ($, on) => {
		const { events } = world(on);
		await run($);
		const ui = await mountPane($, 'terminal');
		await ui.press({ key: 'close' });
		expect(events).toEqual(['open:constellation', 'close:constellation']);
	});

	test('the pane opens focused and closes on Escape', async ($, on) => {
		const { opens } = world(on);
		await run($);
		expect(opens).toEqual([{ id: 'constellation', title: 'Constellation', focus: true, closeOnEscape: true }]);
	});

	test('a working directory that is not a project offers its projects, and the pick sticks', async ($, on) => {
		// The session sits in /work/app, a workspace root above two projects.
		const { cwds } = world(on, {
			answer: (code, cwd) =>
				cwd === '/work/app'
					? { content: [{ type: 'text', text: JSON.stringify({ success: false, error: { code: 'CWD_NOT_INDEXED', message: 'no project', guidance: ['re-invoke code_intel'], context: { candidates: ['/work/app/core', '/work/app/web'] } } }) }], isError: false }
					: answer(code),
		});
		await run($);
		const first = await mountPane($, 'terminal');
		await settle();
		expect(await first.find({ key: 'project:/work/app/core' })).toBeDefined();
		expect(await first.find({ type: 'Text', text: 're-invoke code_intel' })).toBeUndefined();
		expect(await first.find({ type: 'Text', text: /CWD_NOT_INDEXED/ })).toBeUndefined();
		expect(await first.find({ key: 'tab-status' })).toBeUndefined();
		expect(await first.find({ key: 'refresh' })).toBeUndefined();
		expect(await first.find({ key: 'close' })).toBeDefined();

		await first.press({ key: 'project:/work/app/web' });
		await settle();
		expect(cwds.at(-1)).toBe('/work/app/web');
		expect(await first.find({ type: 'Text', text: /Connection/ })).toBeDefined();
		expect(await first.find({ key: 'tab-status' })).toBeDefined();
		await first.press({ key: 'close' });
		await first.unmount();

		// Opening the pane again from the same directory goes straight to the picked project.
		await run($);
		const again = await mountPane($, 'terminal');
		await settle();
		expect(cwds.at(-1)).toBe('/work/app/web');
		expect(await again.find({ type: 'Text', text: /Connection/ })).toBeDefined();
	});

	const WORKSPACE = (code: string, cwd: string): McpToolResult => {
		if (cwd === '/work/app') {
			const error = { code: 'CWD_NOT_INDEXED', message: 'no project', context: { candidates: ['/work/app/core', '/work/app/web'] } };
			return { content: [{ type: 'text', text: JSON.stringify({ success: false, error }) }], isError: false };
		}
		if (code === 'return await api.getCapabilities()') {
			return success({ isIndexed: true, supportedLanguages: ['typescript'], fileCount: 42, lastIndexedAt: INDEXED_AT });
		}
		return answer(code);
	};

	test('the picker rows carry digit hotkeys, focus the first, and show each project in one line', async ($, on) => {
		world(on, { answer: WORKSPACE });
		await run($);
		const ui = await mountPane($, 'terminal');
		await settle();
		const core = await ui.find({ key: 'project:/work/app/core' });
		const web = await ui.find({ key: 'project:/work/app/web' });
		expect(core?.props).toMatchObject({ hotkey: '1', autoFocus: true, plain: true });
		expect(web?.props).toMatchObject({ hotkey: '2' });
		expect(web?.props['autoFocus']).toBeUndefined();
		expect(await ui.find({ type: 'Text', text: /typescript · 42 files/ })).toBeDefined();
	});

	test('a pick is remembered for the next session and switch project forgets it', async ($, on) => {
		const { store, cwds } = world(on, { answer: WORKSPACE });
		await run($);
		const ui = await mountPane($, 'terminal');
		await settle();
		await ui.press({ key: 'project:/work/app/core' });
		await settle();
		expect(store.get('project:/work/app')).toBe('/work/app/core');
		expect((await exact(ui, 'core'))?.props['bold']).toBe(true);
		expect(await ui.find({ key: 'switch-project' })).toBeDefined();

		await ui.press({ key: 'switch-project' });
		await settle();
		expect(store.has('project:/work/app')).toBe(false);
		expect(cwds.at(-1)).not.toBe('/work/app/core');
		expect(await ui.find({ key: 'project:/work/app/web' })).toBeDefined();
	});

	test('a pick saved by an earlier session opens straight into that project', async ($, on) => {
		const { cwds } = world(on, { answer: WORKSPACE, saved: [['project:/work/app', '/work/app/web']] });
		await run($);
		const ui = await mountPane($, 'terminal');
		await settle();
		expect(cwds[0]).toBe('/work/app/web');
		expect(await ui.find({ type: 'Text', text: /Connection/ })).toBeDefined();
	});

	test('the header follows the pane width: banner, then the boxed header, then one line', async ($, on) => {
		world(on);
		await run($);
		const wide = await mountPane($, 'terminal', 100);
		await settle();
		expect(await reads(wide, /CONSTELLATIONDEV\.IO/)).toBe(true);
		await wide.unmount();
		const medium = await mountPane($, 'terminal', 60);
		await settle();
		expect(await reads(medium, />_ CONSTELLATION:\/\/CODE_INTEL/)).toBe(true);
		expect(await reads(medium, /CONSTELLATIONDEV\.IO/)).toBe(false);
		await medium.unmount();
		const narrow = await mountPane($, 'terminal', 30);
		await settle();
		expect(await reads(narrow, />_CONSTELLATION:\/\/$/)).toBe(true);
		expect(await reads(narrow, /CODE_INTEL/)).toBe(false);
	});

	test('the picker names its keys and hides the tab keys', async ($, on) => {
		world(on, { answer: WORKSPACE });
		await run($);
		const ui = await mountPane($, 'terminal');
		await settle();
		expect(await exact(ui, 'Choose a project')).toBeDefined();
		expect(await ui.find({ type: 'Text', text: /1-9 open a project/ })).toBeDefined();
		expect(await ui.find({ type: 'Text', text: /switch tabs/ })).toBeUndefined();
	});

	test('a project of its own shows no switch control', async ($, on) => {
		world(on);
		await run($);
		const ui = await mountPane($, 'terminal');
		await settle();
		expect((await exact(ui, 'app'))?.props['bold']).toBe(true);
		expect(await ui.find({ key: 'switch-project' })).toBeUndefined();
	});

	test('Close is marked as the dismiss control of the pane', async ($, on) => {
		world(on);
		await run($);
		const ui = await mountPane($, 'terminal');
		await settle();
		expect((await ui.find({ key: 'close' }))?.props['role']).toBe('dismiss');
	});

	test('closing clears what the pane held', async ($, on) => {
		const { codes } = world(on);
		await run($, 'unused');
		const first = await mountPane($, 'terminal');
		await settle();
		await first.press({ key: 'close' });
		await first.unmount();
		// With nothing held, a drawing starts over on the status tab and asks again.
		const again = await mountPane($, 'terminal');
		await settle();
		expect(codes).toHaveLength(2);
		expect(codes[1]).toBe('return await api.ping()');
		expect(await again.find({ type: 'Text', text: /Connection/ })).toBeDefined();
	});

	const okColor = async (ui: Awaited<ReturnType<typeof mountPane>>) =>
		(await ui.findAll({ type: 'Text' })).find((t) => t.children.includes('✓ ok'))?.props['color'];
	/** The color of the banner's first run, at the gradient's left edge. */
	const markColor = async (ui: Awaited<ReturnType<typeof mountPane>>) =>
		(await ui.findAll({ type: 'Text' })).find((t) => t.children.includes('╭──'))?.props['color'];

	test('a light theme swaps the green for the theme success color and keeps the brand blue', async ($, on) => {
		world(on, { theme: 'light' });
		await run($);
		const ui = await mountPane($, 'terminal');
		await settle();
		expect(await okColor(ui)).toBe('success');
		expect(await markColor(ui)).toBe(palette.galactic);
	});

	test('an ANSI or color-blind theme draws with the theme colors only', async ($, on) => {
		world(on, { theme: 'dark-daltonized' });
		await run($);
		const ui = await mountPane($, 'terminal');
		await settle();
		expect(await okColor(ui)).toBe('success');
		expect(await markColor(ui)).toBe('suggestion');
	});

	test('the colors option set to theme draws with the theme colors on a dark theme', { options: { colors: 'theme' } }, async ($, on) => {
		world(on, { theme: 'dark' });
		await run($);
		const ui = await mountPane($, 'terminal');
		await settle();
		expect(await okColor(ui)).toBe('success');
	});

	test('the colors option set to none draws no color and keeps the words', { options: { colors: 'none' } }, async ($, on) => {
		world(on, { theme: 'dark' });
		await run($);
		const ui = await mountPane($, 'terminal');
		await settle();
		expect(await okColor(ui)).toBeUndefined();
		expect(await markColor(ui)).toBeUndefined();
		expect(await ui.find({ type: 'Text', text: '✓ ok' })).toBeDefined();
	});

	test('a dark theme keeps the green', async ($, on) => {
		world(on, { theme: 'dark' });
		await run($);
		const ui = await mountPane($, 'terminal');
		await settle();
		const badge = (await ui.findAll({ type: 'Text' })).find((t) => t.children.includes('✓ ok'));
		expect(badge?.props['color']).toBe(palette.cosmic);
	});
});

describe('registration', () => {
	test('session.start registers the command and passes through', async ($, on) => {
		const registered: unknown[] = [];
		on('session.start', (_, e) => ({ cwd: e.cwd }));
		on('command.register', (_, e) => {
			registered.push(e);
			return { value: { command: e.name } };
		});
		const r = await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true });
		expect(r.cwd).toBe('/work/app');
		expect(registered).toEqual([
			{ name: COMMAND, description: expect.any(String), argumentHint: expect.any(String), immediate: true },
		]);
	});

	test('a refused registration does not fail the session', async ($, on) => {
		on('session.start', (_, e) => ({ cwd: e.cwd }));
		on('command.register', () => {
			throw new Error('refused');
		});
		const r = await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true });
		expect(r.cwd).toBe('/work/app');
	});
});
