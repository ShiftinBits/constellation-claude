import type { McpToolResult, On, PluginOptions, RenderSurface, ToolCallArgs, ToolCheckResult } from 'claude-code';
import { describe, expect, mock, test } from 'claude-code/testing';
import { forgetAgentImpact, headline, registerImpactGate } from './impact';
import { type FileRisk, noteCodeIntel, RETRY_MS } from './risk';
import { registerSession } from './session';

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
	/** What `$.ui.ask` resolves to, or an Error it rejects with; `Proceed` when not given. */
	answer?: string | Error;
	/** What `$.session.surfaces` resolves to; the terminal when not given. */
	surfaces?: readonly RenderSurface[];
	/** When true, code_intel never answers and the gate's deadline passes at once. */
	slow?: boolean;
	/** The access key; `KEY` when not given. */
	key?: string;
	/** Paths that exist besides `constellation.json` at the root; the edited file when not given. */
	files?: readonly string[];
};

/** What the fake `$` recorded. */
type Calls = {
	asks: Array<{ question: string; options: unknown }>;
	toasts: Array<{ text: string; options: unknown }>;
	logs: string[];
	programs: number;
	envReads: number;
	/** Every path `$.fs.exists` was asked about. */
	exists: string[];
	/** `$.clock.after` timers, in the order they were set. */
	timers: Array<{ ms: number; fn: () => void }>;
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

	const calls: Calls = { asks: [], toasts: [], logs: [], programs: 0, envReads: 0, exists: [], timers: [] };
	const files = new Set([`${PROJECT}/constellation.json`, ...(world.files ?? [FILE])]);
	const $ = {
		env: {
			get: async () => {
				calls.envReads += 1;
				return world.key ?? KEY;
			},
		},
		session: { cwd: async () => PROJECT, surfaces: async () => world.surfaces ?? ['terminal'] },
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
		ui: {
			ask: async (question: string, opts: unknown) => {
				calls.asks.push({ question, options: opts });
				const answer = world.answer ?? 'Proceed';
				if (answer instanceof Error) throw answer;
				return answer;
			},
			toast: (text: string, opts: unknown) => {
				calls.toasts.push({ text, options: opts });
			},
			log: (text: string) => {
				calls.logs.push(text);
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

	/** A real call's check (it carries a `tool_use_id`) of `tool` on `path`, over core's `decision`. */
	const check = (decision: ToolCheckResult['decision'] = 'allow', path = FILE, tool = 'Edit') => {
		const field = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path';
		return raise('tool.check', { tool, input: { [field]: path }, tool_use_id: 'u1' }, async () => ({ decision }));
	};

	/** A query's check of an Edit of `FILE`: no `tool_use_id`, as another plugin's `$.tool.check` raises it. */
	const query = (decision: ToolCheckResult['decision']) =>
		raise('tool.check', { tool: 'Edit', input: { file_path: FILE } }, async () => ({ decision }));

	/** An agent's real Edit of `path`, over a bottom that lets it through. */
	const edit = (path = FILE, agentId = 'agent-1', tool = 'Edit'): Promise<object> => {
		const field = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path';
		const e = { tool, [field]: path, tool_use_id: 'u1', agentId };
		return raise('tool.call', e, async () => ({ result: 'ran' }) as unknown as ToolCheckResult);
	};

	const sessionStart = (source: string) =>
		raise('classic.SessionStart', { source }, async () => ({ decision: 'allow' }));

	/** A prompt submitted in permission mode `mode`, as `classic.UserPromptSubmit` carries it. */
	const prompt = (mode: string) =>
		raise('classic.UserPromptSubmit', { prompt: 'edit it', permission_mode: mode }, async () => ({ decision: 'allow' }));

	return { calls, check, query, edit, sessionStart, prompt };
}

const HIGH: FileRisk = {
	path: 'src/core.ts',
	dependents: 25,
	topDependents: ['src/dep0.ts', 'src/dep1.ts', 'src/dep2.ts'],
	usedSymbols: ['Core'],
	level: 'high',
	asOfCommit: '0123456',
};

const HEADLINE = '>_CONSTELLATION:// src/core.ts: 25 dependents · HIGH risk (as of 0123456)';
const QUESTION = `${HEADLINE}\nTop dependents: src/dep0.ts, src/dep1.ts, src/dep2.ts\nEdit it anyway?`;
const OPTIONS = ['Proceed', "Proceed, and don't ask again for this file", 'Cancel'];
const DENY: ToolCheckResult = {
	decision: 'deny',
	reason: 'The user declined this edit to src/core.ts (25 dependents, HIGH risk). Ask before trying a different approach.',
};

describe('headline', () => {
	test('names the file, its dependents, the risk word and the commit', () => {
		expect(headline(HIGH)).toBe(HEADLINE);
	});

	test('leaves the commit out when it is unknown', () => {
		const { asOfCommit: _commit, ...risk } = HIGH;
		expect(headline({ ...risk, dependents: 60, level: 'critical' })).toBe('>_CONSTELLATION:// src/core.ts: 60 dependents · CRITICAL risk');
	});
});

describe('impact gate dialog', () => {
	test('an allowed edit to a high-risk file asks, and Proceed allows it', async () => {
		const m = load({ impactGate: 'dialog' });
		expect(await m.check()).toEqual({ decision: 'allow' });
		expect(m.calls.asks).toEqual([{ question: QUESTION, options: OPTIONS }]);
		expect(m.calls.toasts).toEqual([]);
	});

	test('Cancel denies with the reason the model reads', async () => {
		const m = load({ impactGate: 'dialog' }, { answer: 'Cancel' });
		expect(await m.check()).toEqual(DENY);
	});

	test('free text typed under Other denies with what the user typed', async () => {
		const m = load({ impactGate: 'dialog' }, { answer: 'go ahead, but keep the export name' });
		expect(await m.check()).toEqual({ ...DENY, reason: `${DENY.reason} The user said: "go ahead, but keep the export name"` });
	});

	test("don't ask again allows the edit and suppresses a later dialog for that file only", async () => {
		const other = `${PROJECT}/src/other.ts`;
		const m = load({ impactGate: 'dialog' }, { answer: "Proceed, and don't ask again for this file", files: [FILE, other] });
		expect(await m.check()).toEqual({ decision: 'allow' });
		expect(await m.check()).toEqual({ decision: 'allow' });
		expect(m.calls.asks.length).toBe(1);
		await m.check('allow', other);
		expect(m.calls.asks.length).toBe(2);
	});

	test('a SessionStart clear forgets the files not to ask about', async () => {
		const m = load({ impactGate: 'dialog' }, { answer: "Proceed, and don't ask again for this file" });
		await m.check();
		await m.sessionStart('clear');
		await m.check();
		expect(m.calls.asks.length).toBe(2);
	});

	test('an edit core already sends to the permission prompt gets one toast and no dialog', async () => {
		const m = load({ impactGate: 'dialog' });
		expect(await m.check('ask')).toEqual({ decision: 'ask' });
		expect(m.calls.toasts).toEqual([{ text: HEADLINE, options: { timeoutMs: 10000 } }]);
		expect(m.calls.asks).toEqual([]);
	});

	test('an edit core denies is left alone', async () => {
		const m = load({ impactGate: 'dialog' });
		expect(await m.check('deny')).toEqual({ decision: 'deny' });
		expect(m.calls.asks).toEqual([]);
		expect(m.calls.programs).toBe(0);
	});

	test('a query (no tool_use_id) is left alone and reads nothing', async () => {
		const m = load({ impactGate: 'dialog' });
		expect(await m.query('allow')).toEqual({ decision: 'allow' });
		expect(await m.query('ask')).toEqual({ decision: 'ask' });
		expect(m.calls.asks).toEqual([]);
		expect(m.calls.toasts).toEqual([]);
		expect(m.calls.envReads).toBe(0);
	});

	test('a low-risk file is left alone', async () => {
		const m = load({ impactGate: 'dialog' }, { dependents: 4 });
		expect(await m.check()).toEqual({ decision: 'allow' });
		expect(m.calls.asks).toEqual([]);
		expect(m.calls.programs).toBe(1);
	});

	test('a Write that creates a new file is left alone and makes no lookup', async () => {
		const m = load({ impactGate: 'dialog' }, { files: [] });
		expect(await m.check('allow', FILE, 'Write')).toEqual({ decision: 'allow' });
		expect(m.calls.asks).toEqual([]);
		expect(m.calls.programs).toBe(0);
	});

	test('a Write over an existing high-risk file asks', async () => {
		const m = load({ impactGate: 'dialog' });
		await m.check('allow', FILE, 'Write');
		expect(m.calls.asks.length).toBe(1);
	});

	test('a NotebookEdit reads notebook_path', async () => {
		const m = load({ impactGate: 'dialog' }, { answer: 'Cancel' });
		expect((await m.check('allow', FILE, 'NotebookEdit')).decision).toBe('deny');
	});

	test('a code_intel error is left alone', async () => {
		const m = load({ impactGate: 'dialog' }, { success: false });
		expect(await m.check()).toEqual({ decision: 'allow' });
		expect(m.calls.asks).toEqual([]);
	});

	test('no access key is left alone', async () => {
		const m = load({ impactGate: 'dialog' }, { key: 'sk:other' });
		expect(await m.check()).toEqual({ decision: 'allow' });
		expect(m.calls.programs).toBe(0);
	});

	test('a file outside any indexed project is left alone', async () => {
		const m = load({ impactGate: 'dialog' });
		expect(await m.check('allow', '/elsewhere/a.ts')).toEqual({ decision: 'allow' });
		expect(m.calls.programs).toBe(0);
	});

	for (const impactGate of [undefined, 'off', 'loud']) {
		test(`impactGate ${String(impactGate)} registers no gate`, async () => {
			const m = load(impactGate === undefined ? {} : { impactGate });
			expect(await m.check()).toEqual({ decision: 'allow' });
			expect(m.calls.asks).toEqual([]);
			expect(m.calls.programs).toBe(0);
		});
	}

	test('impactThreshold critical leaves a high-risk file alone and asks for a critical one', async () => {
		const high = load({ impactGate: 'dialog', impactThreshold: 'critical' });
		await high.check();
		expect(high.calls.asks).toEqual([]);
		const critical = load({ impactGate: 'dialog', impactThreshold: 'critical' }, { dependents: 50 });
		await critical.check();
		expect(critical.calls.asks.length).toBe(1);
	});

	test('with no surfaces (headless) the edit stays allowed, nothing is asked and one line is logged', async () => {
		const m = load({ impactGate: 'dialog' }, { surfaces: [] });
		expect(await m.check()).toEqual({ decision: 'allow' });
		expect(m.calls.asks).toEqual([]);
		expect(m.calls.logs).toEqual([`${HEADLINE} (could not ask, edit allowed)`]);
	});

	test('a dismissed dialog (Esc) denies as Cancel does, whatever the rejection says', async () => {
		const m = load({ impactGate: 'dialog' }, { answer: new Error('dismissed') });
		expect(await m.check()).toEqual(DENY);
		expect(m.calls.logs).toEqual([]);
	});

	test('a remembered file makes no second lookup', async () => {
		const m = load({ impactGate: 'dialog' }, { answer: "Proceed, and don't ask again for this file" });
		await m.check();
		await m.check();
		expect(m.calls.programs).toBe(1);
	});

	test('a path with .. segments is gated as the file it names, and remembered as one file', async () => {
		const m = load({ impactGate: 'dialog' }, { answer: "Proceed, and don't ask again for this file" });
		await m.check('allow', `${PROJECT}/src/../src/core.ts`);
		await m.check();
		expect(m.calls.asks).toEqual([{ question: QUESTION, options: OPTIONS }]);
	});

	test('a lookup slower than the deadline lets the edit go ahead ungated', async () => {
		const m = load({ impactGate: 'dialog' }, { slow: true });
		expect(await m.check()).toEqual({ decision: 'allow' });
		expect(m.calls.asks).toEqual([]);
		expect(m.calls.programs).toBe(1);
	});

	test('a failed lookup is not repeated until its retry timer fires', async () => {
		const m = load({ impactGate: 'dialog' }, { success: false });
		await m.check();
		await m.check();
		expect(m.calls.programs).toBe(1);
		const retry = m.calls.timers.find((t) => t.ms === RETRY_MS);
		retry?.fn();
		await m.check();
		expect(m.calls.programs).toBe(2);
	});
});

describe('impact gate in auto mode', () => {
	const ASK: ToolCheckResult = { decision: 'ask' };

	for (const impactGate of ['dialog', 'native']) {
		test(`${impactGate}: an edit headed to the auto-mode classifier asks, and Proceed leaves it to the classifier`, async () => {
			const m = load({ impactGate });
			await m.prompt('auto');
			expect(await m.check('ask')).toEqual(ASK);
			expect(m.calls.asks).toEqual([{ question: QUESTION, options: OPTIONS }]);
			expect(m.calls.toasts).toEqual([]);
		});

		test(`${impactGate}: Cancel refuses an edit headed to the classifier`, async () => {
			const m = load({ impactGate }, { answer: 'Cancel' });
			await m.prompt('auto');
			expect(await m.check('ask')).toEqual(DENY);
		});
	}

	test('a remembered file is not asked about again', async () => {
		const m = load({ impactGate: 'dialog' }, { answer: "Proceed, and don't ask again for this file" });
		await m.prompt('auto');
		await m.check('ask');
		await m.check('ask');
		expect(m.calls.asks.length).toBe(1);
		expect(m.calls.programs).toBe(1);
	});

	test('in default mode an ask still reaches the permission prompt: a toast in dialog mode, nothing in native', async () => {
		const dialog = load({ impactGate: 'dialog' });
		await dialog.prompt('default');
		expect(await dialog.check('ask')).toEqual(ASK);
		expect(dialog.calls.asks).toEqual([]);
		expect(dialog.calls.toasts.length).toBe(1);
		const native = load({ impactGate: 'native' });
		await native.prompt('default');
		expect(await native.check('ask')).toEqual(ASK);
		expect(native.calls.toasts).toEqual([]);
		expect(native.calls.programs).toBe(0);
	});

	test('a SessionStart clear forgets the mode', async () => {
		const m = load({ impactGate: 'dialog' });
		await m.prompt('auto');
		await m.sessionStart('clear');
		await m.check('ask');
		expect(m.calls.asks).toEqual([]);
		expect(m.calls.toasts.length).toBe(1);
	});
});

describe('impact gate native', () => {
	const ASK: ToolCheckResult = { decision: 'ask', reason: '25 dependents, HIGH risk' };

	test('an allowed edit to a high-risk file is downgraded to the permission prompt with one toast', async () => {
		const m = load({ impactGate: 'native' });
		expect(await m.check()).toEqual(ASK);
		expect(m.calls.toasts).toEqual([{ text: HEADLINE, options: { timeoutMs: 10000 } }]);
		expect(m.calls.asks).toEqual([]);
	});

	test('an ask decision passes through with no toast and no lookup', async () => {
		const m = load({ impactGate: 'native' });
		expect(await m.check('ask')).toEqual({ decision: 'ask' });
		expect(m.calls.toasts).toEqual([]);
		expect(m.calls.programs).toBe(0);
	});

	test('a deny decision passes through with no toast', async () => {
		const m = load({ impactGate: 'native' });
		expect(await m.check('deny')).toEqual({ decision: 'deny' });
		expect(m.calls.toasts).toEqual([]);
		expect(m.calls.programs).toBe(0);
	});

	test('a query (no tool_use_id) is left alone', async () => {
		const m = load({ impactGate: 'native' });
		expect(await m.query('allow')).toEqual({ decision: 'allow' });
		expect(m.calls.toasts).toEqual([]);
		expect(m.calls.envReads).toBe(0);
	});

	test('a low-risk file is left alone', async () => {
		const m = load({ impactGate: 'native' }, { dependents: 2 });
		expect(await m.check()).toEqual({ decision: 'allow' });
		expect(m.calls.toasts).toEqual([]);
	});

	test('a new file is left alone', async () => {
		const m = load({ impactGate: 'native' }, { files: [] });
		expect(await m.check('allow', FILE, 'Write')).toEqual({ decision: 'allow' });
		expect(m.calls.toasts).toEqual([]);
	});

	test('mode off is left alone', async () => {
		const m = load({ impactGate: 'off' });
		expect(await m.check()).toEqual({ decision: 'allow' });
		expect(m.calls.toasts).toEqual([]);
	});

	test('a code_intel error is left alone', async () => {
		const m = load({ impactGate: 'native' }, { success: false });
		expect(await m.check()).toEqual({ decision: 'allow' });
		expect(m.calls.toasts).toEqual([]);
	});

	test('with no surfaces the edit stays allowed, nothing is shown and nothing is looked up', async () => {
		const m = load({ impactGate: 'native' }, { surfaces: [] });
		expect(await m.check()).toEqual({ decision: 'allow' });
		expect(m.calls.toasts).toEqual([]);
		expect(m.calls.programs).toBe(0);
	});
});

describe('impact gate require-analysis', () => {
	const RAN = { result: 'ran' };
	/** A successful code_intel answer, as `noteCodeIntel` reads it. */
	const OK = { text: '{"success":true}' };
	const DENIED =
		'>_CONSTELLATION:// src/core.ts has 25 dependents (HIGH risk, as of 0123456). Top dependents: src/dep0.ts, src/dep1.ts, src/dep2.ts. Symbols they import from it: Core. Check that your change keeps these callers working (use code_intel impactAnalysis / traceSymbolUsage on the symbols you change), then retry the edit.';
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

	test('a SessionStart clear forgets the refusals', async () => {
		const m = load(options);
		await m.edit();
		await m.sessionStart('clear');
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
		const m = load(options);
		expect(await m.check()).toEqual({ decision: 'allow' });
		expect(m.calls.asks).toEqual([]);
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
	test('a $.tool.check query of a high-risk file is left alone: no lookup, no dialog, no toast', { options: { impactGate: 'dialog' } }, async ($, on) => {
		const raised: string[] = [];
		mock.env(on, { CONSTELLATION_ACCESS_KEY: KEY });
		on('session.cwd', () => ({ value: PROJECT }));
		on('session.surfaces', () => ({ value: ['terminal'] }));
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
		on('ui.toast', (_$, e) => {
			raised.push(`toast ${e.text}`);
			return { value: undefined };
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
