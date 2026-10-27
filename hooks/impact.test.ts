import type { McpToolResult, On, PluginOptions, ToolCallArgs, ToolCheckApprover, ToolCheckResult } from 'claude-code';
import { describe, expect, mock, test } from 'claude-code/testing';
import { forgetAgentImpact, headline, impactLine, promptReason, registerImpactGate } from './impact';
import { type FileRisk, noteCodeIntel, RETRY_MS } from './risk';
import { registerSession } from './session';
import { BRAND } from './theme';

const KEY = 'ak:test-key';
const PROJECT = '/work/app';
const FILE = `${PROJECT}/src/core.ts`;
const COMMIT = '0123456789abcdef';

type Bottom = (e: object) => Promise<ToolCheckResult>;
type Next = Bottom & { signal: AbortSignal };
type Handler = ($: object, e: object, next: Next) => Promise<ToolCheckResult>;
type Registered = { event: string; matcher: Record<string, unknown>; handler: Handler };

/** True when the event `e` satisfies a matcher: a pattern, a list of values, or a value per field. */
function matches(matcher: Record<string, unknown>, e: object): boolean {
	return Object.entries(matcher).every(([field, want]) => {
		const got: unknown = Reflect.get(e, field);
		if (want instanceof RegExp) return want.test(String(got));
		if (Array.isArray(want)) return want.includes(got);
		return want === got;
	});
}

type World = {
	/** Direct dependents code_intel reports for the file; 25 (high) when not given. */
	dependents?: number;
	/** Whether code_intel answers with success; true when not given. */
	success?: boolean;
	/** When true, code_intel never answers and the gate's deadline passes at once. */
	slow?: boolean;
	/** The access key; `KEY` when not given. */
	key?: string;
	/** Paths that exist besides `constellation.json` at the root; the edited file when not given. */
	files?: readonly string[];
};

/** What the fake `$` recorded. */
type Calls = {
	programs: number;
	envReads: number;
	/** Every path `$.fs.exists` was asked about. */
	exists: string[];
	/** `$.clock.after` timers, in the order they were set. */
	timers: Array<{ ms: number; fn: () => void }>;
	/** What the gate's `$.tool.check` queries asked about. */
	queries: unknown[];
};

/**
 * The gate and session handlers as one hooks module registers them, raised
 * directly with a fake `$`: `$.tool.check` cannot pass a `tool_use_id`, so a
 * loaded plugin only ever sees queries.
 */
function load(options: PluginOptions, world: World = {}) {
	const registered: Registered[] = [];
	const capture = (event: string, ...rest: unknown[]) => {
		const handler = rest[rest.length - 1] as Handler;
		const matcher = rest.length > 1 ? (rest[0] as Record<string, unknown>) : {};
		registered.push({ event, matcher, handler });
	};
	registerImpactGate(capture as unknown as On, options);
	registerSession(capture as unknown as On);

	const calls: Calls = { programs: 0, envReads: 0, exists: [], timers: [], queries: [] };
	/** Core's decision for the check being raised, which the gate's `$.tool.check` query resolves to. */
	let core: ToolCheckResult['decision'] = 'allow';
	const files = new Set([`${PROJECT}/constellation.json`, ...(world.files ?? [FILE])]);
	const $ = {
		env: {
			get: async () => {
				calls.envReads += 1;
				return world.key ?? KEY;
			},
		},
		session: { cwd: async () => PROJECT },
		tool: {
			check: async (query: unknown): Promise<ToolCheckResult> => {
				calls.queries.push(query);
				return { decision: core };
			},
		},
		fs: {
			exists: async (path: string) => {
				calls.exists.push(path);
				return files.has(path);
			},
		},
		mcp: {
			connect: async () => ({ isConnected: true, server: 'plugin:constellation:constellation' }),
			call: async (): Promise<McpToolResult> => {
				calls.programs += 1;
				if (world.slow) return new Promise<McpToolResult>(() => {});
				const count = world.dependents ?? 25;
				const body = {
					success: world.success ?? true,
					result: { dependents: Array.from({ length: count }, (_, i) => `src/dep${i}.ts`), used: ['Core'] },
					asOfCommit: COMMIT,
				};
				return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false };
			},
		},
		clock: {
			// The deadline passes at once in a slow world; otherwise it waits until the hook aborts it.
			sleep: (_ms: number, opts?: { signal?: AbortSignal }) =>
				world.slow
					? Promise.resolve()
					: new Promise<void>((_, reject) => opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
			after: (ms: number, fn: () => void) => {
				calls.timers.push({ ms, fn });
				return { cancel: () => {} };
			},
		},
	};

	/** Raises `event` through the handlers that match it, in registration order, over `bottom`. */
	const raise = (event: string, e: object, bottom: Bottom): Promise<ToolCheckResult> => {
		const chain = registered.filter((r) => r.event === event && matches(r.matcher, e));
		const signal = new AbortController().signal;
		const step = (i: number): Next =>
			Object.assign(
				(input: object) => {
					const hook = chain[i];
					return hook === undefined ? bottom(input) : hook.handler($, input, step(i + 1));
				},
				{ signal },
			);
		return step(0)(e);
	};

	/**
	 * A real call's check (it carries a `tool_use_id`) of `tool` on `path`, over
	 * core's `decision`, with `approver` answering its asks (`null` leaves the
	 * field out, as where nobody can be asked).
	 */
	const check = (decision: ToolCheckResult['decision'] = 'allow', path = FILE, tool = 'Edit', approver: ToolCheckApprover | null = 'person') => {
		const field = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path';
		core = decision;
		const e = { tool, input: { [field]: path }, tool_use_id: 'u1', ...(approver === null ? {} : { approver }) };
		return raise('tool.check', e, async () => ({ decision }));
	};

	/** A query's check of an Edit of `FILE`: no `tool_use_id` and no approver, as another plugin's `$.tool.check` raises it. */
	const query = (decision: ToolCheckResult['decision']) =>
		raise('tool.check', { tool: 'Edit', input: { file_path: FILE } }, async () => ({ decision }));

	/** An agent's real Edit of `path`, over a bottom that lets it through. */
	const edit = (path = FILE, agentId = 'agent-1', tool = 'Edit'): Promise<object> => {
		const field = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path';
		const e = { tool, [field]: path, tool_use_id: 'u1', agentId };
		return raise('tool.call', e, async () => ({ result: 'ran' }) as unknown as ToolCheckResult);
	};

	/**
	 * A real Edit of `path`: its `tool.call` with the check raised inside it under the same
	 * `tool_use_id`, over core's `decision`, ending in `outcome` (the tool ran, by default).
	 * Resolves to the check's verdict.
	 */
	const run = async (decision: ToolCheckResult['decision'] = 'allow', path = FILE, outcome: object = { result: 'ran' }) => {
		let verdict: ToolCheckResult | undefined;
		await raise('tool.call', { tool: 'Edit', file_path: path, tool_use_id: 'u1' }, async () => {
			verdict = await check(decision, path);
			return outcome as unknown as ToolCheckResult;
		});
		return verdict;
	};

	/** The session ending for `reason`, as `/clear` (`clear`) or `/resume` and `/branch` (`resume`) raise it. */
	const sessionEnd = (reason: string) =>
		raise('session.end', { reason, sessionId: 'session-1', resume: { id: 'session-1' } }, async () => ({ decision: 'allow' }));

	return { calls, check, query, edit, run, sessionEnd };
}

const HIGH: FileRisk = {
	path: 'src/core.ts',
	dependents: 25,
	topDependents: ['src/dep0.ts', 'src/dep1.ts', 'src/dep2.ts'],
	usedSymbols: ['Core'],
	level: 'high',
	asOfCommit: '0123456',
};

/** The impact line without the brand. */
const LINE = 'HIGH risk · 25 dependents · src/core.ts · as of 0123456';
const HEADLINE = `${BRAND} · ${LINE}`;
const REASON = `${HEADLINE} · top dependents: src/dep0.ts, src/dep1.ts, src/dep2.ts`;
const ASK: ToolCheckResult = { decision: 'ask', reason: REASON };

describe('headline', () => {
	test('names the risk word, the dependents, the file and the commit', () => {
		expect(headline(HIGH)).toBe(HEADLINE);
	});

	test('leaves the commit out when it is unknown', () => {
		const { asOfCommit: _commit, ...risk } = HIGH;
		expect(headline({ ...risk, dependents: 60, level: 'critical' })).toBe(`${BRAND} · CRITICAL risk · 60 dependents · src/core.ts`);
	});

	test('impactLine is the headline without the brand', () => {
		expect(impactLine(HIGH)).toBe(LINE);
	});

	test('the prompt reason is the headline and the top dependents, or the headline alone without any', () => {
		expect(promptReason(HIGH)).toBe(REASON);
		expect(promptReason({ ...HIGH, topDependents: [] })).toBe(HEADLINE);
	});
});

describe('impact gate ask', () => {
	const options = { impactGate: 'ask' };

	test('an edit core would run without asking goes to the permission prompt with the impact as the reason', async () => {
		expect(await load(options).check()).toEqual(ASK);
	});

	test('an edit core already asks about gets the impact as the reason', async () => {
		expect(await load(options).check('ask')).toEqual(ASK);
	});

	test("core's decision is queried for the same tool and input", async () => {
		const m = load(options);
		await m.check();
		expect(m.calls.queries).toEqual([{ tool: 'Edit', input: { file_path: FILE } }]);
	});

	test('an approved edit that ran leaves later edits to the file to core, with no second lookup', async () => {
		const m = load(options);
		expect(await m.run()).toEqual(ASK);
		expect(await m.run()).toEqual({ decision: 'allow' });
		expect(await m.run('ask')).toEqual({ decision: 'ask' });
		expect(m.calls.programs).toBe(1);
	});

	test('only the file that was approved is left to core', async () => {
		const other = `${PROJECT}/src/other.ts`;
		const m = load(options, { files: [FILE, other] });
		await m.run();
		expect((await m.run('allow', other))?.decision).toBe('ask');
	});

	test('a refused edit asks again next time', async () => {
		const m = load(options);
		await m.run('allow', FILE, { deny: 'refused' });
		expect(await m.run()).toEqual(ASK);
	});

	test('an edit whose tool reported an error (a rejected prompt, a failed edit) asks again next time', async () => {
		const m = load(options);
		await m.run('allow', FILE, { isError: true, result: 'The user rejected this edit', text: 'rejected' });
		expect(await m.run()).toEqual(ASK);
	});

	test('a path with .. segments is remembered as the file it names', async () => {
		const m = load(options);
		await m.run('allow', `${PROJECT}/src/../src/core.ts`);
		expect(await m.run()).toEqual({ decision: 'allow' });
	});

	test('a /clear forgets the files already asked about', async () => {
		const m = load(options);
		await m.run();
		await m.sessionEnd('clear');
		expect(await m.run()).toEqual(ASK);
	});

	for (const impactGate of ['dialog', 'native']) {
		test(`the earlier value ${impactGate} works as ask`, async () => {
			expect(await load({ impactGate }).check()).toEqual(ASK);
		});
	}

	test('an edit core denies is left alone, with no lookup', async () => {
		const m = load(options);
		expect(await m.check('deny')).toEqual({ decision: 'deny' });
		expect(m.calls.programs).toBe(0);
	});

	test('a query (no tool_use_id) is left alone and reads nothing', async () => {
		const m = load(options);
		expect(await m.query('allow')).toEqual({ decision: 'allow' });
		expect(await m.query('ask')).toEqual({ decision: 'ask' });
		expect(m.calls.envReads).toBe(0);
	});

	test('a low-risk file is left alone', async () => {
		const m = load(options, { dependents: 4 });
		expect(await m.check()).toEqual({ decision: 'allow' });
		expect(m.calls.programs).toBe(1);
	});

	test('a Write that creates a new file is left alone and makes no lookup', async () => {
		const m = load(options, { files: [] });
		expect(await m.check('allow', FILE, 'Write')).toEqual({ decision: 'allow' });
		expect(m.calls.programs).toBe(0);
	});

	test('a Write over an existing high-risk file asks', async () => {
		expect(await load(options).check('allow', FILE, 'Write')).toEqual(ASK);
	});

	test('a MultiEdit asks, and a NotebookEdit reads notebook_path', async () => {
		expect(await load(options).check('allow', FILE, 'MultiEdit')).toEqual(ASK);
		expect(await load(options).check('allow', FILE, 'NotebookEdit')).toEqual(ASK);
	});

	test('a code_intel error is left alone', async () => {
		expect(await load(options, { success: false }).check()).toEqual({ decision: 'allow' });
	});

	test('no access key is left alone', async () => {
		const m = load(options, { key: 'sk:other' });
		expect(await m.check()).toEqual({ decision: 'allow' });
		expect(m.calls.programs).toBe(0);
	});

	test('a file outside any indexed project is left alone', async () => {
		const m = load(options);
		expect(await m.check('allow', '/elsewhere/a.ts')).toEqual({ decision: 'allow' });
		expect(m.calls.programs).toBe(0);
	});

	for (const impactGate of [undefined, 'off', 'loud']) {
		test(`impactGate ${String(impactGate)} registers no gate`, async () => {
			const m = load(impactGate === undefined ? {} : { impactGate });
			expect(await m.check()).toEqual({ decision: 'allow' });
			expect(m.calls.programs).toBe(0);
		});
	}

	test('impactThreshold critical leaves a high-risk file alone and asks for a critical one', async () => {
		expect(await load({ ...options, impactThreshold: 'critical' }).check()).toEqual({ decision: 'allow' });
		expect((await load({ ...options, impactThreshold: 'critical' }, { dependents: 50 }).check())?.decision).toBe('ask');
	});

	test('a lookup slower than the deadline lets the edit go ahead ungated', async () => {
		const m = load(options, { slow: true });
		expect(await m.check()).toEqual({ decision: 'allow' });
		expect(m.calls.programs).toBe(1);
	});

	test('a failed lookup is not repeated until its retry timer fires', async () => {
		const m = load(options, { success: false });
		await m.check();
		await m.check();
		expect(m.calls.programs).toBe(1);
		const retry = m.calls.timers.find((t) => t.ms === RETRY_MS);
		retry?.fn();
		await m.check();
		expect(m.calls.programs).toBe(2);
	});
});

describe('impact gate ask by approver and core decision', () => {
	type Decision = ToolCheckResult['decision'];
	type Row = { approver: ToolCheckApprover | null; core: Decision; result: ToolCheckResult; lookups: number };
	const rows: Row[] = [
		{ approver: null, core: 'allow', result: { decision: 'allow' }, lookups: 0 },
		{ approver: null, core: 'ask', result: { decision: 'ask' }, lookups: 0 },
		{ approver: null, core: 'deny', result: { decision: 'deny' }, lookups: 0 },
		{ approver: 'host', core: 'allow', result: ASK, lookups: 1 },
		{ approver: 'host', core: 'ask', result: ASK, lookups: 1 },
		{ approver: 'host', core: 'deny', result: { decision: 'deny' }, lookups: 0 },
		{ approver: 'person', core: 'allow', result: ASK, lookups: 1 },
		{ approver: 'person', core: 'ask', result: ASK, lookups: 1 },
		{ approver: 'person', core: 'deny', result: { decision: 'deny' }, lookups: 0 },
	];

	for (const row of rows) {
		test(`approver ${row.approver ?? 'absent'}, core ${row.core} -> ${row.result.decision}`, async () => {
			const m = load({ impactGate: 'ask' });
			expect(await m.check(row.core, FILE, 'Edit', row.approver)).toEqual(row.result);
			expect(m.calls.programs).toBe(row.lookups);
		});
	}

	const quiet: Array<{ name: string; options: PluginOptions; world: World }> = [
		{ name: 'a file below the threshold', options: {}, world: { dependents: 4 } },
		{ name: 'a high-risk file under impactThreshold critical', options: { impactThreshold: 'critical' }, world: {} },
		{ name: 'a failed lookup (unknown risk)', options: {}, world: { success: false } },
		{ name: 'a lookup past the deadline (unknown risk)', options: {}, world: { slow: true } },
	];

	for (const approver of ['host', 'person'] as const) {
		for (const core of ['allow', 'ask'] as const) {
			for (const q of quiet) {
				test(`approver ${approver}, core ${core}, ${q.name} keeps core's decision`, async () => {
					const m = load({ impactGate: 'ask', ...q.options }, q.world);
					expect(await m.check(core, FILE, 'Edit', approver)).toEqual({ decision: core });
				});
			}
		}
	}
});

describe('impact gate require-analysis', () => {
	const RAN = { result: 'ran' };
	/** A successful code_intel answer, as `noteCodeIntel` reads it. */
	const OK = { text: '{"success":true}' };
	const DENIED =
		'✦ >_CONSTELLATION://CODE_INTEL · src/core.ts has 25 dependents (HIGH risk, as of 0123456). Top dependents: src/dep0.ts, src/dep1.ts, src/dep2.ts. Symbols they import from it: Core. Check that your change keeps these callers working (use code_intel impactAnalysis / traceSymbolUsage on the symbols you change), then retry the edit.';
	const options = { impactGate: 'require-analysis' };

	test('the first edit to a high-risk file is denied with the report and the retry passes', async () => {
		const m = load(options);
		expect(await m.edit()).toEqual({ deny: DENIED });
		expect(await m.edit()).toEqual(RAN);
		expect(await m.edit()).toEqual(RAN);
	});

	test('each agent is refused once per file', async () => {
		const m = load(options);
		await m.edit(FILE, 'agent-1');
		expect(await m.edit(FILE, 'agent-2')).toEqual({ deny: DENIED });
		expect(await m.edit(FILE, 'agent-2')).toEqual(RAN);
	});

	test('an agent run ending forgets its refusal and evidence', async () => {
		const m = load(options);
		await m.edit();
		forgetAgentImpact('agent-1');
		expect(await m.edit()).toEqual({ deny: DENIED });
	});

	test('a /clear forgets the refusals', async () => {
		const m = load(options);
		await m.edit();
		await m.sessionEnd('clear');
		expect(await m.edit()).toEqual({ deny: DENIED });
	});

	test('a low-risk file passes', async () => {
		expect(await load(options, { dependents: 4 }).edit()).toEqual(RAN);
	});

	test('a new file passes without a lookup', async () => {
		const m = load(options, { files: [] });
		expect(await m.edit(FILE, 'agent-1', 'Write')).toEqual(RAN);
		expect(m.calls.programs).toBe(0);
	});

	test('mode off passes', async () => {
		const m = load({ impactGate: 'off' });
		expect(await m.edit()).toEqual(RAN);
		expect(m.calls.programs).toBe(0);
	});

	test('a code_intel error passes, and so does the next edit to the file', async () => {
		const m = load(options, { success: false });
		expect(await m.edit()).toEqual(RAN);
		expect(await m.edit()).toEqual(RAN);
		expect(m.calls.programs).toBe(1);
	});

	test('a lookup that misses the deadline passes, and its late result refuses no later edit', async () => {
		const m = load(options, { slow: true });
		expect(await m.edit()).toEqual(RAN);
		expect(await m.edit()).toEqual(RAN);
		expect(m.calls.programs).toBe(1);
	});

	test('a NotebookEdit reads notebook_path', async () => {
		expect(await load(options).edit(FILE, 'agent-1', 'NotebookEdit')).toEqual({ deny: DENIED });
	});

	test('registers no tool.check hook', async () => {
		expect(await load(options).check()).toEqual({ decision: 'allow' });
	});

	test('earlier code_intel naming the file passes for that agent only', async () => {
		const m = load(options);
		noteCodeIntel('agent-1', { code: 'api.getDependents({ filePath: "src/core.ts" })' }, OK);
		expect(await m.edit(FILE, 'agent-1')).toEqual(RAN);
		expect(await m.edit(FILE, 'agent-2')).toEqual({ deny: DENIED });
	});

	test('earlier impact analysis of a symbol its dependents import passes', async () => {
		const m = load(options);
		const code = "const { symbols } = await api.searchSymbols({ query: 'Core' }); return api.impactAnalysis({ symbolId: symbols[0].id });";
		noteCodeIntel('agent-1', { code }, OK);
		expect(await m.edit()).toEqual(RAN);
	});

	test('a search alone, or a path that only ends like the file, is not evidence', async () => {
		const m = load(options);
		noteCodeIntel('agent-1', { code: "api.searchSymbols({ query: 'Core' })" }, OK);
		noteCodeIntel('agent-1', { code: "api.getDependents({ filePath: 'packages/b/src/core.ts' })" }, OK);
		expect(await m.edit()).toEqual({ deny: DENIED });
	});

	test('an absolute path in the analysis counts', async () => {
		const m = load(options);
		noteCodeIntel('agent-1', { code: `api.getDependents({ filePath: '${FILE}' })` }, OK);
		expect(await m.edit()).toEqual(RAN);
	});

	test('the walk for constellation.json starts at the file\'s directory', async () => {
		const m = load(options);
		await m.edit();
		expect(m.calls.exists).not.toContain(`${FILE}/constellation.json`);
	});

	test('a refused file makes no second lookup for that agent', async () => {
		const m = load(options);
		await m.edit();
		await m.edit();
		expect(m.calls.programs).toBe(1);
	});
});

describe('impact gate as a loaded plugin', () => {
	test('a $.tool.check query of a high-risk file is left alone: no lookup and no ask', { options: { impactGate: 'ask' } }, async ($, on) => {
		const raised: string[] = [];
		mock.env(on, { CONSTELLATION_ACCESS_KEY: KEY });
		on('session.cwd', () => ({ value: PROJECT }));
		on('fs.exists', (_$, e) => ({ value: e.path === `${PROJECT}/constellation.json` || e.path === FILE }));
		on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:constellation:constellation' } }));
		on('mcp.call', () => {
			raised.push('code_intel');
			const result = { dependents: Array.from({ length: 25 }, (_, i) => `src/dep${i}.ts`), used: [] };
			return { value: { content: [{ type: 'text', text: JSON.stringify({ success: true, result }) }], isError: false } };
		});
		on('tool.check', () => ({ decision: 'allow' }));
		on('tool.call', (_$, e) => {
			raised.push(String(e.tool));
			return { result: 'Proceed' };
		});
		expect(await $.tool.check({ tool: 'Edit', input: { file_path: FILE } })).toEqual({ decision: 'allow' });
		expect(raised).toEqual([]);
	});

	/** Answers the gate's reads as an indexed project where `FILE` has 25 dependents; the Edit itself runs. */
	function world(on: On) {
		mock.env(on, { CONSTELLATION_ACCESS_KEY: KEY });
		mock.clock(on);
		on('session.cwd', () => ({ value: PROJECT }));
		on('fs.exists', (_$, e) => ({ value: e.path === `${PROJECT}/constellation.json` || e.path === FILE }));
		on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:constellation:constellation' } }));
		on('mcp.call', () => {
			const result = { dependents: Array.from({ length: 25 }, (_, i) => `src/dep${i}.ts`), used: ['Core'] };
			return { value: { content: [{ type: 'text', text: JSON.stringify({ success: true, result }) }], isError: false } };
		});
		on('tool.call', () => ({ result: 'ran' }));
	}

	const EDIT = { tool: 'Edit', file_path: FILE, tool_use_id: 'u1' } as unknown as ToolCallArgs;

	test('impactGate require-analysis refuses the first edit to a high-risk file and lets the retry run', { options: { impactGate: 'require-analysis' } }, async ($, on) => {
		world(on);
		const first = await $.tool.call(EDIT);
		expect('deny' in first ? first.deny : undefined).toContain('25 dependents');
		expect(await $.tool.call(EDIT)).toEqual({ result: 'ran' });
	});

	test('impactGate unset lets an edit to a high-risk file run', async ($, on) => {
		world(on);
		expect(await $.tool.call(EDIT)).toEqual({ result: 'ran' });
	});
});
