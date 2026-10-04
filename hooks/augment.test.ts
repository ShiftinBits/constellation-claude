import type { McpToolResult, On, ToolCallArgs, ToolCallResult } from 'claude-code';
import { describe, expect, mock, test } from 'claude-code/testing';
import { augmentLine, FAILURE_BACKOFF_MS, type LookupApi, lookupCode, lookupSymbol, SOFT_DEADLINE_MS } from './augment';

const KEY = 'ak:test-key';
const PROJECT = '/work/app';
const SERVER = 'plugin:constellation:constellation';
const CODE_INTEL = 'mcp__plugin_constellation_constellation__code_intel';

const SEARCH = { tool: 'Bash', command: 'rg AuthService src/' } as const;

const OUTPUT = 'src/auth/auth.service.ts:12:export class AuthService {';

/** What core answers for the search: its record, the model's text and the ref to its messages. */
const BENEATH = {
	ref: 7,
	result: { stdout: OUTPUT, stderr: '', interrupted: false },
	text: OUTPUT,
};

const FOUND = {
	name: 'AuthService',
	kind: 'class',
	filePath: 'src/auth/auth.service.ts',
	line: 12,
	usages: 4,
	definitions: 1,
};

const LINE = augmentLine(FOUND);

/** A code_intel response whose envelope is `body`. */
function envelope(body: unknown): McpToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false };
}

type World = {
	/** What `$.mcp.call` answers; a lookup that finds `FOUND` when not given. */
	answer?: () => McpToolResult | Promise<McpToolResult>;
	/** The access key; `KEY` when not given. */
	key?: string | null;
	/** The working directory; inside the project when not given. */
	cwd?: string;
	/** What the search itself answers; `BENEATH` when not given. */
	beneath?: ToolCallResult;
};

/**
 * Answers everything beneath the plugin: the key, the cwd, a project at
 * `/work/app`, the MCP server, the tool call itself and the events the other
 * hooks of the module pass on. Returns the clock and the code_intel calls made.
 */
function world(
	on: On,
	{ answer = () => envelope({ success: true, result: FOUND }), key = KEY, cwd = PROJECT, beneath = BENEATH }: World = {},
) {
	mock.env(on, key === null ? {} : { CONSTELLATION_ACCESS_KEY: key });
	const clock = mock.clock(on);
	const codes: unknown[] = [];
	on('session.cwd', () => ({ value: cwd }));
	on('fs.exists', (_, e) => ({ value: e.path === `${PROJECT}/constellation.json` }));
	on('mcp.connect', () => ({ value: { isConnected: true, server: SERVER } }));
	on('mcp.call', async (_, e) => {
		codes.push(e.args.code);
		return { value: await answer() };
	});
	on('turn.start', (_, e) => ({ turnId: e.turnId }));
	on('classic.PreToolUse', () => ({}));
	on('tool.call', () => beneath);
	return { clock, codes };
}

describe('search result augment', () => {
	test('a Bash rg of a symbol gains exactly one line with kind, location and usages', async ($, on) => {
		const { codes } = world(on);
		const r = await $.tool.call(SEARCH);
		expect(r).toEqual({ ...BENEATH, context: [LINE] });
		expect(LINE).toBe(
			'>_CONSTELLATION:// AuthService (class) is defined at src/auth/auth.service.ts:12, with 4 usages. Use code_intel for references, callers, and impact.',
		);
		expect(codes.length).toBe(1);
		expect(String(codes[0])).toContain('(api, "AuthService");');
	});

	test('a Grep of a symbol gains the same line when the build raises Grep', async ($, on) => {
		world(on);
		// This build's tool table has no Grep, though the kit raises it, so the input is typed by hand.
		const grep = { tool: 'Grep', pattern: 'class AuthService', path: `${PROJECT}/src` };
		const r = await $.tool.call(grep as unknown as ToolCallArgs);
		expect(r.context).toEqual([LINE]);
	});

	test('keeps the context the chain beneath produced', async ($, on) => {
		world(on, { beneath: { ...BENEATH, context: ['earlier'] } });
		const r = await $.tool.call(SEARCH);
		expect(r.context).toEqual(['earlier', LINE]);
	});

	for (const command of ["rg 'connection refused' src", 'rg TODO', 'grep -rn "foo|bar" .', 'cat log | grep AuthService', 'ls -la']) {
		test(`\`${command}\` is left as it was`, async ($, on) => {
			const { codes } = world(on);
			expect(await $.tool.call({ tool: 'Bash', command })).toEqual(BENEATH);
			expect(codes.length).toBe(0);
		});
	}

	test('a code_intel error envelope leaves the result as it was', async ($, on) => {
		world(on, { answer: () => envelope({ success: false, error: { code: 'PROJECT_NOT_INDEXED' } }) });
		expect(await $.tool.call(SEARCH)).toEqual(BENEATH);
	});

	test('no exact match leaves the result as it was', async ($, on) => {
		world(on, { answer: () => envelope({ success: true, result: null }) });
		expect(await $.tool.call(SEARCH)).toEqual(BENEATH);
	});

	test('a lookup slower than the deadline leaves the result as it was', async ($, on) => {
		const { clock } = world(on, { answer: () => new Promise<McpToolResult>(() => {}) });
		const pending = $.tool.call(SEARCH);
		await clock.settle();
		await clock.advance(SOFT_DEADLINE_MS);
		expect(await pending).toEqual(BENEATH);
	});

	test('a failed lookup is retried only after the backoff, and does not use up the symbol', async ($, on) => {
		let fail = true;
		const { clock, codes } = world(on, {
			answer: () => envelope(fail ? { success: false, error: { code: 'API_UNREACHABLE' } } : { success: true, result: FOUND }),
		});
		expect(await $.tool.call(SEARCH)).toEqual(BENEATH);
		fail = false;
		expect(await $.tool.call(SEARCH)).toEqual(BENEATH);
		expect(codes.length).toBe(1);
		await clock.advance(FAILURE_BACKOFF_MS);
		expect((await $.tool.call(SEARCH)).context).toEqual([LINE]);
		expect(codes.length).toBe(2);
	});

	test('no exact match is remembered, so a repeat search makes no second lookup', async ($, on) => {
		const { codes } = world(on, { answer: () => envelope({ success: true, result: null }) });
		expect(await $.tool.call(SEARCH)).toEqual(BENEATH);
		expect(await $.tool.call(SEARCH)).toEqual(BENEATH);
		expect(codes.length).toBe(1);
	});

	test('two searches for a symbol at once show one line', async ($, on) => {
		const { codes } = world(on);
		const [a, b] = await Promise.all([$.tool.call(SEARCH), $.tool.call({ tool: 'Bash', command: 'grep -rn AuthService test' })]);
		expect([a.context, b.context]).toContainEqual([LINE]);
		expect([a, b]).toContainEqual(BENEATH);
		expect(codes.length).toBe(1);
	});

	test('a subagent gets its own line for a symbol the main conversation already saw', async ($, on) => {
		const { codes } = world(on);
		expect((await $.tool.call(SEARCH)).context).toEqual([LINE]);
		const sub = { ...SEARCH, agentId: 'agent-1' };
		expect((await $.tool.call(sub as unknown as ToolCallArgs)).context).toEqual([LINE]);
		expect(codes.length).toBe(1);
	});

	test('a failure from before /clear never evicts a lookup made after it', async ($, on) => {
		let fail = true;
		const { clock, codes } = world(on, {
			answer: () => envelope(fail ? { success: false, error: { code: 'API_UNREACHABLE' } } : { success: true, result: FOUND }),
		});
		on('classic.SessionStart', () => ({}));
		expect(await $.tool.call(SEARCH)).toEqual(BENEATH);
		await $.classic.SessionStart({ source: 'clear' });
		fail = false;
		expect((await $.tool.call(SEARCH)).context).toEqual([LINE]);
		await clock.advance(FAILURE_BACKOFF_MS);
		const sub = { ...SEARCH, agentId: 'agent-1' };
		expect((await $.tool.call(sub as unknown as ToolCallArgs)).context).toEqual([LINE]);
		expect(codes.length).toBe(2);
	});

	test('a subagent continued after its run ended is shown the line again', async ($, on) => {
		const { codes } = world(on);
		on('turn.complete', () => ({ text: '' }));
		const sub = { ...SEARCH, agentId: 'agent-1' } as unknown as ToolCallArgs;
		expect((await $.tool.call(sub)).context).toEqual([LINE]);
		expect(await $.tool.call(sub)).toEqual(BENEATH);
		await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'r1', agentId: 'agent-1', reason: 'end' } as never);
		expect((await $.tool.call(sub)).context).toEqual([LINE]);
		expect(codes.length).toBe(1);
	});

	test('a shell search of another directory uses the project there', async ($, on) => {
		const { codes } = world(on, { cwd: '/elsewhere' });
		const r = await $.tool.call({ tool: 'Bash', command: `cd ${PROJECT} && rg AuthService src` });
		expect(r.context).toEqual([LINE]);
		expect(codes.length).toBe(1);
	});

	test('/clear lets a symbol be shown again', async ($, on) => {
		world(on);
		on('classic.SessionStart', () => ({}));
		expect((await $.tool.call(SEARCH)).context).toEqual([LINE]);
		await $.classic.SessionStart({ source: 'clear' });
		expect((await $.tool.call(SEARCH)).context).toEqual([LINE]);
	});

	test('the same symbol is augmented once', async ($, on) => {
		const { codes } = world(on);
		expect((await $.tool.call(SEARCH)).context).toEqual([LINE]);
		expect(await $.tool.call({ tool: 'Bash', command: 'grep -rn AuthService .' })).toEqual(BENEATH);
		expect(codes.length).toBe(1);
	});

	test('a code_intel call earlier in the same turn means no augment', async ($, on) => {
		const { codes } = world(on);
		await $.turn.start({ text: 'hi', turnId: 't1' });
		await $.tool.call({ tool: CODE_INTEL, code: 'return 1', cwd: PROJECT });
		expect(await $.tool.call(SEARCH)).toEqual(BENEATH);
		expect(codes.length).toBe(0);
	});

	test('a used-up reminder budget does not stop the augment', { options: { nudgeLimit: 0 } }, async ($, on) => {
		world(on);
		await $.turn.start({ text: 'hi', turnId: 't1' });
		expect((await $.tool.call(SEARCH)).context).toEqual([LINE]);
	});

	test('augmentGrep false means no augment', { options: { augmentGrep: false } }, async ($, on) => {
		const { codes } = world(on);
		expect(await $.tool.call(SEARCH)).toEqual(BENEATH);
		expect(codes.length).toBe(0);
	});

	test('no key means no augment', async ($, on) => {
		const { codes } = world(on, { key: null });
		expect(await $.tool.call(SEARCH)).toEqual(BENEATH);
		expect(codes.length).toBe(0);
	});

	test('a key that does not start with ak: means no augment', async ($, on) => {
		world(on, { key: 'sk:other' });
		expect(await $.tool.call(SEARCH)).toEqual(BENEATH);
	});

	test('a search outside any indexed project means no augment', async ($, on) => {
		const { codes } = world(on, { cwd: '/elsewhere' });
		expect(await $.tool.call(SEARCH)).toEqual(BENEATH);
		expect(codes.length).toBe(0);
	});

	test('a denied search is left as it was', async ($, on) => {
		world(on, { beneath: { deny: 'not allowed' } });
		expect(await $.tool.call(SEARCH)).toEqual({ deny: 'not allowed' });
	});

	test('an errored search is left as it was', async ($, on) => {
		const errored = { ref: 7, result: 'Exit code 2', text: 'Exit code 2', isError: true } as const;
		world(on, { beneath: errored });
		expect(await $.tool.call(SEARCH)).toEqual(errored);
	});
});

describe('augment line', () => {
	test('one usage is singular', () => {
		expect(augmentLine({ ...FOUND, usages: 1 })).toContain('with 1 usage.');
	});

	test('a name several symbols share says the reported one is the most used', () => {
		expect(augmentLine({ ...FOUND, definitions: 3 })).toContain(
			'src/auth/auth.service.ts:12, the most used of 3 symbols with that name, with 4 usages.',
		);
	});
});

type Symbol = { name: string; kind: string; filePath: string; line: number; isExported: boolean; usageCount?: number };
type SearchParams = Parameters<LookupApi['searchSymbols']>[0];

/** Runs the lookup against a graph of `symbols`, searched by substring and in name order like `searchSymbols`. */
async function runLookup(name: string, symbols: readonly Symbol[]): Promise<{ result: unknown; calls: SearchParams[] }> {
	const calls: SearchParams[] = [];
	const api: LookupApi = {
		searchSymbols: async (params) => {
			calls.push(params);
			const matching = symbols
				.filter((s) => s.name.toLowerCase().includes(params.query.toLowerCase()))
				.filter((s) => params.isExported === undefined || s.isExported === params.isExported)
				.sort((a, b) => a.name.localeCompare(b.name))
				.map((s) => (params.includeUsageCount ? s : { ...s, usageCount: undefined }));
			return { symbols: matching.slice(0, params.limit) };
		},
	};
	return { result: await lookupSymbol(api, name), calls };
}

const symbol = (name: string, extra: Partial<Symbol> = {}): Symbol => ({
	name,
	kind: 'class',
	filePath: `src/${name}.ts`,
	line: 1,
	isExported: true,
	usageCount: 0,
	...extra,
});

describe('code_intel lookup program', () => {
	test('finds the exact name far down a page of substring matches', async () => {
		const noise = Array.from({ length: 80 }, (_, i) => symbol(`AddOrganization${String(i).padStart(2, '0')}`));
		const { result, calls } = await runLookup('Organization', [...noise, symbol('Organization', { line: 25, usageCount: 85 })]);
		expect(result).toEqual({ name: 'Organization', kind: 'class', filePath: 'src/Organization.ts', line: 25, usages: 85, definitions: 1 });
		expect(calls[0]).toEqual({ query: 'Organization', limit: 100, includeUsageCount: true, isExported: true });
	});

	test('reports the most used of several symbols with the name', async () => {
		const { result } = await runLookup('User', [
			symbol('User', { filePath: 'test/fixtures/user.ts', usageCount: 0 }),
			symbol('User', { filePath: 'src/entities/User.ts', usageCount: 106 }),
		]);
		expect(result).toMatchObject({ filePath: 'src/entities/User.ts', usages: 106, definitions: 2 });
	});

	test('falls back to symbols that are not exported', async () => {
		const { result, calls } = await runLookup('Logger', [symbol('Logger', { isExported: false, usageCount: 7 })]);
		expect(result).toMatchObject({ name: 'Logger', usages: 7 });
		expect(calls.length).toBe(2);
	});

	test('an unexported symbol nothing uses is not reported', async () => {
		const { result } = await runLookup('Logger', [symbol('Logger', { isExported: false, usageCount: 0 })]);
		expect(result).toBe(null);
	});

	test('a name with no exact match gives null', async () => {
		const { result } = await runLookup('Auth', [symbol('AuthService'), symbol('authHeader')]);
		expect(result).toBe(null);
	});

	test('the program sent to code_intel runs the same function with the quoted name', () => {
		const code = lookupCode('Auth"Service');
		expect(code).toStartWith('return await (async function lookupSymbol(api, name)');
		expect(code).toEndWith(')(api, "Auth\\"Service");');
	});
});
