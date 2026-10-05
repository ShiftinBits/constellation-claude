import type { McpToolResult, On, PluginOptions, ToolCallArgs } from 'claude-code';
import { describe, expect, test } from 'claude-code/testing';
import { probe } from './blast';
import { registerBudget, usedCodeIntelThisTurn } from './budget';
import { collectEvidence, hasEvidence } from './risk';
import { registerSession } from './session';
import { registerTurnSummary, TURN_SUMMARY_DEADLINE_MS } from './turnsummary';

const KEY = 'ak:test-key';
const PROJECT = '/work/app';
const CODE_INTEL = 'mcp__plugin_constellation_constellation__code_intel';
const COMMIT = '0123456789abcdef';
const ANSWER = { text: 'Done.' };

type Answer = Record<string, unknown>;
type Bottom = (e: object) => Promise<Answer>;
type Origin = { plugin: string; tier: string };
type Next = Bottom & { origin: Origin; signal: AbortSignal };
type Handler = ($: object, e: object, next: Next) => Promise<Answer>;
type Registered = { event: string; matcher: Record<string, unknown>; handler: Handler };

const ENGINE: Origin = { plugin: 'engine', tier: 'core' };

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
	/** The access key, or a function read on each call; `KEY` when not given. */
	key?: string | (() => string);
	/** Paths that exist; `constellation.json` at the root and every source file under `src/` when not given. */
	exists?: (path: string) => boolean;
	/** Direct dependents per project-relative file, as the graph holds them. */
	dependents?: Record<string, string[]>;
	/** When set, code_intel answers this failure instead. */
	failure?: 'error' | 'unsuccessful';
	/** When true, code_intel never answers and the deadline passes at once. */
	slow?: boolean;
	/** When set, `$.fs.exists` rejects when asked about a `constellation.json`, or `$.env.get` rejects. */
	rejects?: 'exists' | 'env';
};

/** What the fake `$` recorded. */
type Calls = {
	/** The project-relative files each code_intel lookup asked about. */
	queried: string[][];
	/** The cwd each lookup ran in. */
	cwds: string[];
	/** The deadlines `$.clock.sleep` was asked for. */
	sleeps: number[];
};

/** True for a source file under the project's `src/` (a `constellation.json` there is not one). */
function isSource(path: string): boolean {
	return path.startsWith(`${PROJECT}/src/`) && !path.endsWith('/constellation.json');
}

/** Reads the files, the symbols flag and the page size back out of a serialized `probe` program. */
function probeArgs(code: string): { files: string[]; exports: boolean; page: number } {
	const m = /\(api, (\[.*\]), (true|false), (\d+)\);$/.exec(code);
	if (m === null) throw new Error(`not a probe program: ${code}`);
	return { files: JSON.parse(m[1] ?? '[]') as string[], exports: m[2] === 'true', page: Number(m[3]) };
}

/**
 * The budget, session and turn summary handlers as one hooks module registers
 * them, raised directly with a fake `$`: the test kit has no `$.mcp`, `$.fs`
 * or `$.env.get`. code_intel runs the real `probe` against the world's graph.
 */
function load(options: PluginOptions = {}, world: World = {}) {
	const registered: Registered[] = [];
	const capture = (event: string, ...rest: unknown[]) => {
		const handler = rest[rest.length - 1] as Handler;
		const matcher = rest.length > 1 ? (rest[0] as Record<string, unknown>) : {};
		registered.push({ event, matcher, handler });
	};
	registerBudget(capture as unknown as On, options);
	registerSession(capture as unknown as On);
	registerTurnSummary(capture as unknown as On, options);

	const calls: Calls = { queried: [], cwds: [], sleeps: [] };
	const graph = world.dependents ?? {};
	const exists = world.exists ?? ((p: string) => p === `${PROJECT}/constellation.json` || isSource(p));
	const $ = {
		env: {
			get: async () => {
				if (world.rejects === 'env') throw new Error('env unavailable');
				return typeof world.key === 'function' ? world.key() : (world.key ?? KEY);
			},
		},
		session: { cwd: async () => PROJECT, id: async () => 'session-1' },
		store: { get: async () => undefined, set: async () => undefined },
		fs: {
			exists: async (path: string) => {
				if (world.rejects === 'exists' && path.endsWith('/constellation.json')) throw new Error('fs unavailable');
				return exists(path);
			},
		},
		mcp: {
			connect: async () => ({ isConnected: true, server: 'plugin:constellation:constellation' }),
			call: async (_server: string, _tool: string, args: { code: string; cwd: string }): Promise<McpToolResult> => {
				const { files, exports, page } = probeArgs(args.code);
				calls.queried.push(files);
				calls.cwds.push(args.cwd);
				if (world.slow) return new Promise<McpToolResult>(() => {});
				if (world.failure === 'error') throw new Error('server down');
				if (world.failure === 'unsuccessful') {
					const body = { success: false, error: { code: 'PROJECT_NOT_INDEXED' } };
					return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false };
				}
				const result = await probe(
					{
						getDependents: async ({ filePath }) => ({ directDependents: (graph[filePath] ?? []).map((f) => ({ filePath: f })) }),
					},
					files,
					exports,
					page,
				);
				const body = { success: true, result, asOfCommit: COMMIT };
				return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false };
			},
		},
		clock: {
			now: async () => 0,
			// The deadline passes at once in a slow world; otherwise it waits until the hook aborts it.
			sleep: (ms: number, opts?: { signal?: AbortSignal }) => {
				calls.sleeps.push(ms);
				return world.slow
					? Promise.resolve()
					: new Promise<void>((_, reject) => opts?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
			},
		},
	};

	/** Raises `event` through the handlers that match it, in registration order, over `bottom`. */
	const raise = (event: string, e: object, bottom: Bottom, origin = ENGINE): Promise<Answer> => {
		const chain = registered.filter((r) => r.event === event && matches(r.matcher, e));
		const signal = new AbortController().signal;
		const step = (i: number): Next =>
			Object.assign(
				(input: object) => {
					const hook = chain[i];
					return hook === undefined ? bottom(input) : hook.handler($, input, step(i + 1));
				},
				{ origin, signal },
			);
		return step(0)(e);
	};

	const ran: Answer = { result: 'ran' };

	return {
		calls,
		registered,
		turn: (turnId = 't1') => raise('turn.start', { text: '', turnId }, async () => ({})),
		/** An edit by `tool` of `path`, over a bottom that answers `answer`; MultiEdit is cast, as the tool table lacks it. */
		edit: (path: string, tool = 'Edit', extra: object = {}, answer: Answer = ran) => {
			const field = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path';
			const e = { tool, [field]: path, tool_use_id: 'u1', ...extra } as unknown as ToolCallArgs;
			return raise('tool.call', e, async () => answer);
		},
		/** The main loop's turn ending for `reason`, over a bottom that answers `beneath` (`ANSWER` by default). */
		complete: (reason = 'answer', isAborted = false, beneath: Answer = ANSWER) =>
			raise('turn.complete', { answer: 'Done.', durationMs: 1, isAborted, turnId: 't1', reason }, async () => beneath),
		/** A subagent's run ending. */
		runEnds: (agentId: string) =>
			raise('turn.complete', { answer: '', durationMs: 1, isAborted: false, turnId: 'r1', reason: 'answer', agentId }, async () => ({ text: '' })),
		/** A subagent's code_intel analysis of `src/core.ts`. */
		analyze: (agentId: string) =>
			raise('tool.call', { tool: CODE_INTEL, tool_use_id: 'c1', agentId, code: "return api.getDependents({ filePath: 'src/core.ts' })" }, async () => ({
				text: JSON.stringify({ success: true, result: {} }),
			})),
	};
}

const LINE = '>_CONSTELLATION://';

describe('turn summary line', () => {
	test('two edits give one line with the union of their dependents and its test files', async () => {
		const m = load(
			{},
			{
				dependents: {
					'src/a.ts': ['src/b.ts', 'src/shared.ts', 'src/a.test.ts'],
					'src/b.ts': ['src/shared.ts', 'src/c.ts', 'src/a.ts'],
				},
			},
		);
		await m.turn();
		await m.edit(`${PROJECT}/src/a.ts`);
		await m.edit('src/b.ts');
		await m.edit(`${PROJECT}/src/a.ts`);
		expect(await m.complete()).toEqual({ text: `${LINE} 2 files changed · 3 downstream dependents (1 test file) · as of 0123456` });
		expect(m.calls.queried).toEqual([['src/a.ts', 'src/b.ts']]);
		expect(m.calls.cwds).toEqual([PROJECT]);
		expect(m.calls.sleeps).toEqual([TURN_SUMMARY_DEADLINE_MS]);
	});

	test('Edit, Write, NotebookEdit and MultiEdit are all counted', async () => {
		const m = load({}, { dependents: { 'src/a.ts': ['src/x.ts'] } });
		await m.turn();
		await m.edit(`${PROJECT}/src/a.ts`, 'Edit');
		await m.edit(`${PROJECT}/src/b.ts`, 'Write');
		await m.edit(`${PROJECT}/src/c.ipynb`, 'NotebookEdit');
		await m.edit(`${PROJECT}/src/d.ts`, 'MultiEdit');
		expect(await m.complete()).toEqual({ text: `${LINE} 4 files changed · 1 downstream dependent (0 test files) · as of 0123456` });
		expect(m.calls.queried).toEqual([['src/a.ts', 'src/b.ts', 'src/c.ipynb', 'src/d.ts']]);
	});

	test('a Write to a missing path counts as new and is not queried', async () => {
		const m = load({}, { dependents: { 'src/a.ts': ['src/x.ts', 'src/y.ts'] } });
		await m.turn();
		await m.edit(`${PROJECT}/src/a.ts`);
		await m.edit(`${PROJECT}/lib/new.ts`, 'Write');
		expect(await m.complete()).toEqual({ text: `${LINE} 2 files changed (1 new) · 2 downstream dependents (0 test files) · as of 0123456` });
		expect(m.calls.queried).toEqual([['src/a.ts']]);
	});

	test('a turn of only new files shows the line with no dependents and asks code_intel nothing', async () => {
		const m = load();
		await m.turn();
		await m.edit(`${PROJECT}/lib/one.ts`, 'Write');
		await m.edit(`${PROJECT}/lib/two.ts`, 'Write');
		expect(await m.complete()).toEqual({ text: `${LINE} 2 files changed (2 new) · 0 downstream dependents (0 test files)` });
		expect(m.calls.queried).toEqual([]);
		expect(m.calls.sleeps).toEqual([]);
	});

	test('a file outside the project is neither counted nor queried', async () => {
		const m = load({}, { dependents: { 'src/a.ts': ['src/x.ts'] }, exists: (p) => p === `${PROJECT}/constellation.json` || isSource(p) || p === '/elsewhere/notes.ts' });
		await m.turn();
		await m.edit(`${PROJECT}/src/a.ts`);
		await m.edit('/elsewhere/notes.ts');
		expect(await m.complete()).toEqual({ text: `${LINE} 1 file changed · 1 downstream dependent (0 test files) · as of 0123456` });
		expect(m.calls.queried).toEqual([['src/a.ts']]);
	});

	test('a file outside any project edited first does not hide the line', async () => {
		const m = load({}, { dependents: { 'src/a.ts': ['src/x.ts'] }, exists: (p) => p === `${PROJECT}/constellation.json` || isSource(p) || p === '/elsewhere/plan.md' });
		await m.turn();
		await m.edit('/elsewhere/plan.md');
		await m.edit(`${PROJECT}/src/a.ts`);
		expect(await m.complete()).toEqual({ text: `${LINE} 1 file changed · 1 downstream dependent (0 test files) · as of 0123456` });
		expect(m.calls.queried).toEqual([['src/a.ts']]);
	});

	test('a file that fills its page of dependents shows the count as a floor', async () => {
		const many = Array.from({ length: 100 }, (_, i) => `src/d${i}.ts`);
		const m = load({}, { dependents: { 'src/a.ts': many } });
		await m.turn();
		await m.edit(`${PROJECT}/src/a.ts`);
		expect(await m.complete()).toEqual({ text: `${LINE} 1 file changed · 100+ downstream dependents (0 test files) · as of 0123456` });
	});

	test('a line another hook set stays, with this one under it', async () => {
		const m = load({}, { dependents: { 'src/a.ts': ['src/x.ts'] } });
		await m.turn();
		await m.edit(`${PROJECT}/src/a.ts`);
		expect(await m.complete('answer', false, { text: 'tests: 3 failed' })).toEqual({
			text: `tests: 3 failed\n${LINE} 1 file changed · 1 downstream dependent (0 test files) · as of 0123456`,
		});
	});

	test('a denied edit and a failed edit are not counted', async () => {
		const m = load();
		await m.turn();
		expect(await m.edit(`${PROJECT}/src/a.ts`, 'Edit', {}, { deny: 'no' })).toEqual({ deny: 'no' });
		expect(await m.edit(`${PROJECT}/src/b.ts`, 'Edit', {}, { isError: true, text: 'old_string not found' })).toEqual({
			isError: true,
			text: 'old_string not found',
		});
		expect(await m.complete()).toBe(ANSWER);
		expect(m.calls.queried).toEqual([]);
	});

	test('an edit result passes through unchanged', async () => {
		const m = load();
		await m.turn();
		const answer = { result: 'ran', context: ['beneath'] };
		expect(await m.edit(`${PROJECT}/src/a.ts`, 'Edit', {}, answer)).toBe(answer);
	});

	test('a turn with no edits shows no line', async () => {
		const m = load();
		await m.turn();
		expect(await m.complete()).toBe(ANSWER);
		expect(m.calls.queried).toEqual([]);
	});

	test('no constellation.json shows no line and asks code_intel nothing', async () => {
		const m = load({}, { exists: isSource });
		await m.turn();
		await m.edit(`${PROJECT}/src/a.ts`);
		expect(await m.complete()).toBe(ANSWER);
		expect(m.calls.queried).toEqual([]);
	});

	for (const [reason, isAborted] of [
		['answer', true],
		['aborted', true],
		['error', false],
		['refusal', false],
	] as const) {
		test(`a turn that ends with reason ${reason}${isAborted ? ', aborted,' : ''} shows no line and drops its edits`, async () => {
			const m = load();
			await m.turn();
			await m.edit(`${PROJECT}/src/a.ts`);
			expect(await m.complete(reason, isAborted)).toBe(ANSWER);
			expect(await m.complete()).toBe(ANSWER);
			expect(m.calls.queried).toEqual([]);
		});
	}

	test("a subagent's run ending shows no line, forgets its state and keeps the main turn's edits", async () => {
		const m = load({}, { dependents: { 'src/a.ts': ['src/x.ts'] } });
		collectEvidence(true);
		await m.turn();
		await m.edit(`${PROJECT}/src/a.ts`);
		await m.analyze('agent-1');
		expect(usedCodeIntelThisTurn({ agentId: 'agent-1' })).toBe(true);
		expect(hasEvidence('agent-1', ['src/core.ts'], [])).toBe(true);
		expect(await m.runEnds('agent-1')).toEqual({ text: '' });
		expect(usedCodeIntelThisTurn({ agentId: 'agent-1' })).toBe(false);
		expect(hasEvidence('agent-1', ['src/core.ts'], [])).toBe(false);
		expect(m.calls.queried).toEqual([]);
		collectEvidence(false);
		expect(await m.complete()).toEqual({ text: `${LINE} 1 file changed · 1 downstream dependent (0 test files) · as of 0123456` });
	});

	test("a subagent's edit during the main turn is counted", async () => {
		const m = load();
		await m.turn();
		await m.edit(`${PROJECT}/src/a.ts`);
		await m.edit(`${PROJECT}/src/b.ts`, 'Edit', { agentId: 'agent-1' });
		expect(await m.complete()).toEqual({ text: `${LINE} 2 files changed · 0 downstream dependents (0 test files) · as of 0123456` });
	});

	test('turnSummary false registers no edit hook and shows no line', async () => {
		const edits = (m: ReturnType<typeof load>) =>
			m.registered.filter((r) => r.event === 'tool.call' && matches(r.matcher, { tool: 'Edit' })).length;
		expect(edits(load())).toBe(1);
		const m = load({ turnSummary: false });
		expect(edits(m)).toBe(0);
		await m.turn();
		await m.edit(`${PROJECT}/src/a.ts`);
		expect(await m.complete()).toBe(ANSWER);
		expect(m.calls.queried).toEqual([]);
	});

	test('no access key shows no line, asks code_intel nothing and drops the edits', async () => {
		let key = '';
		const m = load({}, { key: () => key });
		await m.turn();
		await m.edit(`${PROJECT}/src/a.ts`);
		expect(await m.complete()).toBe(ANSWER);
		expect(m.calls.queried).toEqual([]);
		key = KEY;
		await m.turn('t2');
		await m.edit(`${PROJECT}/src/b.ts`);
		await m.complete();
		expect(m.calls.queried).toEqual([['src/b.ts']]);
	});

	for (const failure of ['error', 'unsuccessful'] as const) {
		test(`a code_intel ${failure === 'error' ? 'call that throws' : 'failure'} shows no line and returns the answer unchanged`, async () => {
			const m = load({}, { failure });
			await m.turn();
			await m.edit(`${PROJECT}/src/a.ts`);
			expect(await m.complete()).toBe(ANSWER);
			expect(m.calls.queried).toEqual([['src/a.ts']]);
		});
	}

	for (const rejects of ['exists', 'env'] as const) {
		test(`a rejected ${rejects === 'exists' ? 'constellation.json check' : 'access key read'} shows no line and returns the answer unchanged`, async () => {
			const m = load({}, { rejects });
			await m.turn();
			await m.edit(`${PROJECT}/src/a.ts`);
			expect(await m.complete()).toBe(ANSWER);
			expect(m.calls.queried).toEqual([]);
		});
	}

	test('a lookup slower than the deadline shows no line and returns the answer unchanged', async () => {
		const m = load({}, { slow: true });
		await m.turn();
		await m.edit(`${PROJECT}/src/a.ts`);
		expect(await m.complete()).toBe(ANSWER);
		expect(m.calls.sleeps).toEqual([TURN_SUMMARY_DEADLINE_MS]);
	});

	test('each turn ends with an empty record, a turn with no line too', async () => {
		const m = load();
		await m.turn('t1');
		await m.edit(`${PROJECT}/src/a.ts`);
		expect(await m.complete('aborted', true)).toBe(ANSWER);
		await m.turn('t2');
		expect(await m.complete()).toBe(ANSWER);
		await m.edit(`${PROJECT}/src/b.ts`);
		await m.edit(`${PROJECT}/src/c.ts`);
		expect(await m.complete()).toEqual({ text: `${LINE} 2 files changed · 0 downstream dependents (0 test files) · as of 0123456` });
		expect(await m.complete()).toBe(ANSWER);
	});

	test('a new conversation drops the record', async () => {
		const m = load();
		await m.turn();
		await m.edit(`${PROJECT}/src/a.ts`);
		const registered = m.registered.filter((r) => r.event === 'classic.SessionStart');
		for (const r of registered) {
			const next = Object.assign(async () => ({}), { origin: ENGINE, signal: new AbortController().signal });
			await r.handler({}, { source: 'clear' }, next);
		}
		expect(await m.complete()).toBe(ANSWER);
	});
});
