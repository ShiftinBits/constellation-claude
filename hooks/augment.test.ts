import type { McpToolResult, On, ToolCallArgs, ToolCallResult } from 'claude-code';
import { describe, expect, mock, test } from 'claude-code/testing';
import { augmentLine, SOFT_DEADLINE_MS } from './augment';

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
	dependents: 4,
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
	test('a Bash rg of a symbol gains exactly one line with kind, location and dependents', async ($, on) => {
		const { codes } = world(on);
		const r = await $.tool.call(SEARCH);
		expect(r).toEqual({ ...BENEATH, context: [LINE] });
		expect(LINE).toBe(
			'✦ code_intel: AuthService is a class at src/auth/auth.service.ts:12 (4 dependents). Use code_intel for references, callers, and impact.',
		);
		expect(codes.length).toBe(1);
		expect(String(codes[0])).toContain('const NAME = "AuthService";');
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

	test('a failed lookup does not use up the symbol', async ($, on) => {
		let fail = true;
		world(on, { answer: () => envelope(fail ? { success: false, error: { code: 'API_UNREACHABLE' } } : { success: true, result: FOUND }) });
		expect(await $.tool.call(SEARCH)).toEqual(BENEATH);
		fail = false;
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
		const { codes } = world(on, { beneath: { deny: 'not allowed' } });
		expect(await $.tool.call(SEARCH)).toEqual({ deny: 'not allowed' });
		expect(codes.length).toBe(0);
	});

	test('an errored search is left as it was', async ($, on) => {
		const errored = { ref: 7, result: 'Exit code 2', text: 'Exit code 2', isError: true } as const;
		const { codes } = world(on, { beneath: errored });
		expect(await $.tool.call(SEARCH)).toEqual(errored);
		expect(codes.length).toBe(0);
	});
});
