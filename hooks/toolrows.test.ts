import type { On, RenderPropsOf } from 'claude-code';
import { describe, expect, test } from 'claude-code/testing';
import type { Engine, Mounted } from 'claude-code/testing';
import { palette } from './theme';
import { methodsOf, outputText, projectName, registerToolRows, resetToolRows } from './toolrows';

const TOOL = 'mcp__plugin_constellation_constellation__code_intel';
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const SURFACES = ['terminal', 'desktop'] as const;

const CALL_CODE = 'const [i, d] = await Promise.all([api.impactAnalysis({ symbolId: "s1" }), api.getDependents({ filePath: "src/app.ts" })]); return { i, d }';

const IMPACT = {
	symbol: { id: 's1', name: 'Graph', kind: 'class', filePath: 'src/graph.ts' },
	directDependents: [{ name: 'Renderer', kind: 'function', depth: 1 }],
	impactedFiles: [],
	breakingChangeRisk: { riskLevel: 'high', factors: ['exported'], recommendations: [] },
	summary: { directDependentCount: 2, transitiveDependentCount: 6, impactedFileCount: 4, testFileCount: 1, productionFileCount: 3, maxDepth: 2 },
};
const DEPENDENTS = {
	file: 'src/app.ts',
	directDependents: [{ filePath: 'src/main.ts' }, { filePath: 'src/app.test.ts' }, { filePath: 'src/cli.ts' }],
};
const DEPENDENCIES = {
	file: 'src/app.ts',
	directDependencies: [
		{ type: 'file', filePath: 'src/lib.ts', isDefault: false, isNamespace: false },
		{ type: 'module', filePath: null, moduleName: 'zod', isDefault: false, isNamespace: false },
	],
};
const SEARCH = {
	symbols: [
		{ id: 's1', name: 'GraphService', kind: 'class', filePath: 'src/service.ts', line: 3 },
		{ id: 's2', name: 'GraphNode', kind: 'interface', filePath: 'src/node.ts', line: 1 },
		{ id: 's3', name: 'graphOf', kind: 'function', filePath: 'src/of.ts', line: 7 },
		{ id: 's4', name: 'graphCount', kind: 'variable', filePath: 'src/count.ts', line: 2 },
	],
	pagination: { total: 12, hasMore: true },
};
const ORPHANS = {
	orphanedSymbols: [
		{ symbolId: 'a', name: 'helper', kind: 'function', filePath: 'src/util.ts' },
		{ symbolId: 'b', name: 'Legacy', kind: 'class', filePath: 'src/util.ts' },
	],
	orphanedFiles: [],
	summary: { totalOrphanedSymbols: 5, totalOrphanedFiles: 0, potentialDeletions: 5 },
};
const CALLS = {
	root: { name: 'Graph', filePath: 'src/graph.ts', line: 10 },
	callers: [{ symbolId: 'c1', name: 'outer', depth: 1 }],
	callees: [
		{ symbolId: 'c2', name: 'inner', depth: 1 },
		{ symbolId: 'c3', name: 'deeper', depth: 2 },
	],
};
const PING = { pong: true };

/** A successful code_intel reply as the row's output carries it: the envelope's JSON text, a plain string. */
function reply(result: unknown): string {
	return JSON.stringify({ success: true, asOfCommit: COMMIT, lastIndexedAt: '2026-01-01T00:00:00.000Z', result, time: 140 });
}

/** An errored call's output, as the row carries it: `Error: ` and the envelope, pretty-printed. */
function errored(error: Record<string, unknown>): string {
	return `Error: ${JSON.stringify({ success: false, error }, null, 2)}`;
}

const AUTH = {
	code: 'AUTH_ERROR',
	message: '[AUTH_ERROR] Access key is invalid',
	guidance: ['Run constellation auth', 'Call code_intel again with cwd'],
};

/** The CWD_NOT_INDEXED error a call from a workspace root above several projects gets. */
const NOT_INDEXED = {
	code: 'CWD_NOT_INDEXED',
	type: 'ConfigCacheError',
	message: "[CWD_NOT_INDEXED] No constellation.json found at git root '/w' (2 candidate project roots discovered)",
	recoverable: true,
	guidance: [
		"No constellation.json was found at git root '/w'.",
		'Discovered 2 candidate project roots: /w/app, /w/api',
		'Re-invoke `code_intel` with `cwd` set to one of these project roots.',
		'The Constellation workspace is multi-project: each project owns its own constellation.json at its repo root.',
	],
	context: { apiMethod: 'code_intel', gitRoot: '/w', candidates: ['/w/app', '/w/api'] },
	docs: 'https://docs.constellationdev.io/setup',
};

/** A stand-in for Claude Code's own row beneath the plugin, and the `/config` rows the plugin reads. */
function world(on: On, { theme = 'dark', verbose = false }: { theme?: string; verbose?: boolean } = {}): void {
	on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'fallthrough' }));
	on('config.list', () => ({
		value: [
			{ key: 'theme', label: 'Theme', kind: 'choice', value: theme, provider: { plugin: 'engine', tier: 'core' }, isLocked: false },
			{ key: 'verbose', label: 'Verbose output', kind: 'boolean', value: verbose, provider: { plugin: 'engine', tier: 'core' }, isLocked: false },
		],
	}));
}

function useProps(id: string, input: unknown, tool = TOOL): RenderPropsOf['ToolUse'] {
	return { tool_use_id: id, tool, input, isRunning: false, isErrored: false, isInterrupted: false };
}

function resultProps(id: string, output: unknown, isErrored = false, tool = TOOL): RenderPropsOf['ToolResult'] {
	return { tool_use_id: id, tool, output, isErrored };
}

type Surface = (typeof SURFACES)[number] | 'vscode';

async function mountUse($: Engine, surface: Surface, id: string, input: unknown, tool = TOOL) {
	return $.ui.mount({ plugin: 'constellation', surface, component: 'ToolUse', requestId: id, props: useProps(id, input, tool) });
}

async function mountResult($: Engine, surface: Surface, id: string, output: unknown, isErrored = false, tool = TOOL) {
	return $.ui.mount({ plugin: 'constellation', surface, component: 'ToolResult', requestId: id, props: resultProps(id, output, isErrored, tool) });
}

type Drawing = Pick<Mounted<Surface>, 'drawn' | 'findAll'>;

/** Every string in a drawn tree, in order, as one line. */
function flat(node: unknown): string {
	if (typeof node === 'string') return node;
	if (typeof node !== 'object' || node === null) return '';
	const children: unknown = Reflect.get(node, 'children');
	return Array.isArray(children) ? children.map(flat).join('') : '';
}

async function line(ui: Drawing): Promise<string> {
	return flat(await ui.drawn());
}

/** The Text whose only child is exactly `text`. */
async function exact(ui: Drawing, text: string) {
	return (await ui.findAll({ type: 'Text' })).find((t) => t.children.length === 1 && t.children[0] === text);
}

describe('methodsOf', () => {
	test('lists each api method once, in order of first call', () => {
		expect(methodsOf(CALL_CODE)).toEqual(['impactAnalysis', 'getDependents']);
		expect(methodsOf('await api.ping(); await api.searchSymbols({}); await api.ping()')).toEqual(['ping', 'searchSymbols']);
		expect(methodsOf('return 1')).toEqual([]);
	});
});

describe('projectName', () => {
	test('is the last segment of a string cwd, on either slash', () => {
		expect(projectName('/x/constellation-core')).toBe('constellation-core');
		expect(projectName('/x/constellation-core/')).toBe('constellation-core');
		expect(projectName('C:\\work\\app')).toBe('app');
		expect(projectName(undefined)).toBeUndefined();
		expect(projectName(42)).toBeUndefined();
		expect(projectName('/')).toBeUndefined();
	});
});

describe('outputText', () => {
	test('reads a string, a content-block array, or an object with content', () => {
		expect(outputText('{"success":true}')).toBe('{"success":true}');
		expect(outputText([{ type: 'image', data: 'x' }, { type: 'text', text: 'a' }])).toBe('a');
		expect(outputText({ content: [{ type: 'text', text: 'b' }], isError: false })).toBe('b');
		expect(outputText({ structuredContent: { success: false, error: 'lost' } })).toBeUndefined();
		expect(outputText([{ type: 'image', data: 'x' }])).toBeUndefined();
		expect(outputText(undefined)).toBeUndefined();
	});
});

describe('call row', () => {
	test('names the mark, the methods and the project', async ($, on) => {
		world(on);
		for (const surface of SURFACES) {
			const ui = await mountUse($, surface, `use-${surface}`, { code: CALL_CODE, cwd: '/x/constellation-core' });
			expect(await line(ui)).toBe('✦ code_intel · impactAnalysis, getDependents · constellation-core');
			expect((await exact(ui, '✦ code_intel'))?.props['color']).toBe(palette.nebula);
			expect((await exact(ui, 'constellation-core'))?.props['dimColor']).toBe(true);
			expect(await ui.find({ type: 'Text', text: 'fallthrough' })).toBeUndefined();
		}
	});

	test('leaves out the methods and the project when there are none', async ($, on) => {
		world(on);
		for (const surface of SURFACES) {
			const ui = await mountUse($, surface, `bare-${surface}`, { code: 'return 1' });
			expect(await line(ui)).toBe('✦ code_intel');
		}
	});

	test('an input without code keeps Claude Code row', async ($, on) => {
		world(on);
		for (const surface of SURFACES) {
			for (const [i, input] of [{ cwd: '/x/app' }, 'code', null].entries()) {
				const ui = await mountUse($, surface, `nocode-${surface}-${i}`, input);
				expect(await line(ui)).toBe('fallthrough');
			}
		}
	});
});

describe('result row', () => {
	const cases: [string, unknown, string][] = [
		['impactAnalysis', IMPACT, '✗ HIGH · 8 dependents · 1 test file'],
		['getDependents', DEPENDENTS, '3 dependent files · 1 test file'],
		['getDependencies', DEPENDENCIES, '2 dependency files'],
		['searchSymbols', SEARCH, '12 symbols · GraphService, GraphNode, graphOf'],
		['findOrphanedCode', ORPHANS, '5 exports'],
		['getCallGraph', CALLS, '3 nodes · depth 2'],
		['ping', PING, '✓ connected'],
		['a combined return', { i: IMPACT, d: DEPENDENTS }, 'result: 2 keys'],
	];
	for (const [name, result, expected] of cases) {
		test(`summarizes ${name} with the time and commit`, async ($, on) => {
			world(on);
			for (const surface of SURFACES) {
				const ui = await mountResult($, surface, `${name}-${surface}`, reply(result));
				expect(await line(ui)).toBe(`${expected} · 140 ms · as of 0123456`);
				expect((await exact(ui, '140 ms · as of 0123456'))?.props['dimColor']).toBe(true);
			}
		});
	}

	test('counts are bold and the risk badge is colored', async ($, on) => {
		world(on);
		const ui = await mountResult($, 'terminal', 'bold', reply(IMPACT));
		expect((await exact(ui, '8'))?.props['bold']).toBe(true);
		expect((await exact(ui, '✗ HIGH'))?.props['color']).toBe(palette.stellar);
	});

	test('a dependents result with no test file leaves the test count out', async ($, on) => {
		world(on);
		const ui = await mountResult($, 'terminal', 'no-tests', reply({ file: 'src/app.ts', directDependents: [{ filePath: 'src/main.ts' }] }));
		expect(await line(ui)).toBe('1 dependent file · 140 ms · as of 0123456');
	});

	test('a search shows only the first three names, each in its kind color', async ($, on) => {
		world(on);
		const ui = await mountResult($, 'terminal', 'names', reply(SEARCH));
		expect((await exact(ui, 'GraphService'))?.props['color']).toBe(palette.galactic);
		expect((await exact(ui, 'GraphNode'))?.props['color']).toBe(palette.galactic);
		expect((await exact(ui, 'graphOf'))?.props['color']).toBe(palette.nebula);
		expect(await line(ui)).not.toContain('graphCount');
	});

	test('a ping names the project from its call', async ($, on) => {
		world(on);
		for (const surface of SURFACES) {
			const id = `ping-${surface}`;
			await mountUse($, surface, id, { code: 'return await api.ping()', cwd: '/x/constellation-core' });
			const ui = await mountResult($, surface, id, reply(PING));
			expect(await line(ui)).toBe('✓ connected · constellation-core · 140 ms · as of 0123456');
			expect((await exact(ui, '✓ connected'))?.props['color']).toBe(palette.cosmic);
		}
	});

	test('any other return is counted, with no descent', async ($, on) => {
		world(on);
		for (const surface of SURFACES) {
			expect(await line(await mountResult($, surface, `keys-${surface}`, reply({ a: 1, b: 2 })))).toBe('result: 2 keys · 140 ms · as of 0123456');
			expect(await line(await mountResult($, surface, `items-${surface}`, reply([1, 2, 3])))).toBe('result: 3 items · 140 ms · as of 0123456');
			expect(await line(await mountResult($, surface, `scalar-${surface}`, reply('done')))).toBe('result: string · 140 ms · as of 0123456');
			expect(await line(await mountResult($, surface, `none-${surface}`, JSON.stringify({ success: true })))).toBe('result: undefined');
		}
	});

	test('the output as a content-block object or array parses too', async ($, on) => {
		world(on);
		for (const surface of SURFACES) {
			const wrapped = { content: [{ type: 'text', text: reply({ a: 1, b: 2 }) }] };
			expect(await line(await mountResult($, surface, `wrapped-${surface}`, wrapped))).toBe('result: 2 keys · 140 ms · as of 0123456');
			const blocks = [{ type: 'text', text: reply([1]) }];
			expect(await line(await mountResult($, surface, `blocks-${surface}`, blocks))).toBe('result: 1 item · 140 ms · as of 0123456');
		}
	});

	test('unreadable output draws the generic line', async ($, on) => {
		world(on);
		for (const surface of SURFACES) {
			expect(await line(await mountResult($, surface, `bad-${surface}`, 'not json'))).toBe('result: unreadable');
			expect(await line(await mountResult($, surface, `empty-${surface}`, undefined))).toBe('result: unreadable');
		}
	});

	test('a redraw reuses the parsed envelope', async ($, on) => {
		world(on);
		const ui = await mountResult($, 'terminal', 'redraw', reply(DEPENDENCIES));
		await ui.redraw(resultProps('redraw', 'not json'));
		expect(await line(ui)).toBe('2 dependency files · 140 ms · as of 0123456');
	});
});

describe('error row', () => {
	test("shows the code in the error color and the person's step, not the agent's", async ($, on) => {
		world(on);
		for (const surface of SURFACES) {
			const ui = await mountResult($, surface, `auth-${surface}`, errored(AUTH), true);
			expect(await line(ui)).toBe('✗ AUTH_ERROR · constellation auth');
			expect(await line(ui)).not.toContain('code_intel');
			expect((await exact(ui, '✗ AUTH_ERROR'))?.props['color']).toBe(palette.stellar);
		}
	});

	test('the error a workspace root gets reads its note for a person', async ($, on) => {
		world(on);
		const ui = await mountResult($, 'terminal', 'not-indexed', errored(NOT_INDEXED), true);
		expect(await line(ui)).toBe('✗ CWD_NOT_INDEXED · The Constellation workspace is multi-project: each project owns its own constellation.json at its repo root.');
	});

	test('an error envelope not marked as errored is an error row too', async ($, on) => {
		world(on);
		const ui = await mountResult($, 'terminal', 'unmarked', JSON.stringify({ success: false, error: AUTH, time: 12 }));
		expect(await line(ui)).toBe('✗ AUTH_ERROR · constellation auth · 12 ms');
	});

	test('an errored call whose output is not an envelope keeps Claude Code row', async ($, on) => {
		world(on);
		for (const surface of SURFACES) {
			expect(await line(await mountResult($, surface, `raw-${surface}`, 'Error: not json', true))).toBe('fallthrough');
			expect(await line(await mountResult($, surface, `success-${surface}`, `Error: ${reply(PING)}`, true))).toBe('fallthrough');
		}
	});
});

describe('passthrough', () => {
	test('other tools draw Claude Code row unchanged', async ($, on) => {
		world(on);
		for (const surface of SURFACES) {
			const use = await mountUse($, surface, `bash-${surface}`, { command: 'ls' }, 'Bash');
			expect(await use.drawn()).toEqual({ type: 'Text', children: ['fallthrough'] });
			const result = await mountResult($, surface, `bash-${surface}`, { stdout: 'a', stderr: '', interrupted: false }, false, 'Bash');
			expect(await result.drawn()).toEqual({ type: 'Text', children: ['fallthrough'] });
		}
	});

	test('a surface that is neither terminal nor desktop passes through', async ($, on) => {
		world(on);
		expect(await line(await mountUse($, 'vscode', 'vs', { code: CALL_CODE }))).toBe('fallthrough');
		expect(await line(await mountResult($, 'vscode', 'vs', reply(PING)))).toBe('fallthrough');
	});
});

describe('verbose', () => {
	test("draws Claude Code row under the summary when on", async ($, on) => {
		world(on, { verbose: true });
		for (const surface of SURFACES) {
			const ui = await mountResult($, surface, `verbose-${surface}`, reply(PING));
			const tree = await ui.drawn();
			expect(tree.type).toBe('Box');
			expect(flat(tree)).toBe('✓ connected · 140 ms · as of 0123456fallthrough');
			expect(await ui.find({ type: 'Text', text: 'fallthrough' })).toBeDefined();
		}
	});

	test('draws only the summary when off', async ($, on) => {
		world(on, { verbose: false });
		const ui = await mountUse($, 'terminal', 'quiet', { code: CALL_CODE });
		expect(await ui.find({ type: 'Text', text: 'fallthrough' })).toBeUndefined();
	});
});

describe('colors', () => {
	test("'none' draws no color but keeps the words and glyphs", { options: { colors: 'none' } }, async ($, on) => {
		world(on);
		for (const surface of SURFACES) {
			const use = await mountUse($, surface, `plain-${surface}`, { code: CALL_CODE, cwd: '/x/app' });
			expect(await line(use)).toBe('✦ code_intel · impactAnalysis, getDependents · app');
			const result = await mountResult($, surface, `plain-${surface}`, reply(IMPACT));
			expect(await line(result)).toBe('✗ HIGH · 8 dependents · 1 test file · 140 ms · as of 0123456');
			for (const ui of [use, result]) {
				for (const t of await ui.findAll({ type: 'Text' })) expect(t.props['color']).toBeUndefined();
			}
		}
	});

	test('a light theme swaps the green for the theme color', async ($, on) => {
		world(on, { theme: 'light' });
		const ui = await mountResult($, 'terminal', 'light', reply(PING));
		expect((await exact(ui, '✓ connected'))?.props['color']).toBe('success');
	});
});

/**
 * The rows hook as the hooks module registers it, raised directly with a plain
 * element table, so the test shares the module's cache that `resetToolRows`
 * clears (the plugin the kit loads is a separate module instance).
 */
function direct() {
	let hook: ((...args: unknown[]) => Promise<unknown>) | undefined;
	const capture = (...args: unknown[]): void => {
		hook = args[args.length - 1] as typeof hook;
	};
	registerToolRows(capture as unknown as On, {});
	const element =
		(type: string) =>
		({ children, ...props }: Record<string, unknown>) => ({ type, props, children: Array.isArray(children) ? children : [children] });
	const el = { Text: element('Text'), Box: element('Box') };
	const $ = { ui: { resolve: () => el }, config: { list: async () => [] } };
	const next = async () => 'fallthrough';
	const render = async (component: string, requestId: string, props: unknown) =>
		flat(await hook?.($, { surface: 'terminal', component, requestId, props }, next));
	return {
		use: (id: string, cwd: string) => render('ToolUse', id, useProps(id, { code: 'return await api.ping()', cwd })),
		result: (id: string) => render('ToolResult', id, resultProps(id, reply(PING))),
	};
}

describe('cache', () => {
	test('a result row names the project its call row stored', async () => {
		resetToolRows();
		const rows = direct();
		expect(await rows.use('stored', '/x/app')).toBe('✦ code_intel · ping · app');
		expect(await rows.result('stored')).toBe('✓ connected · app · 140 ms · as of 0123456');
	});

	test('resetToolRows forgets the project, and the result still renders', async () => {
		resetToolRows();
		const rows = direct();
		await rows.use('reset', '/x/app');
		resetToolRows();
		expect(await rows.result('reset')).toBe('✓ connected · 140 ms · as of 0123456');
	});

	test('holds at most 200 rows, dropping the oldest', async () => {
		resetToolRows();
		const rows = direct();
		await rows.use('oldest', '/x/app');
		for (let i = 0; i < 200; i++) await rows.use(`row-${i}`, '/x/other');
		expect(await rows.result('oldest')).toBe('✓ connected · 140 ms · as of 0123456');
		expect(await rows.result('row-199')).toBe('✓ connected · other · 140 ms · as of 0123456');
	});

	test('a result with no call row renders through the plugin', async ($, on) => {
		world(on);
		expect(await line(await mountResult($, 'terminal', 'never-called', reply(PING)))).toBe('✓ connected · 140 ms · as of 0123456');
	});
});
