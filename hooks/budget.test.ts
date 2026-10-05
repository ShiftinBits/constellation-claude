import type { On, PluginOptions } from 'claude-code';
import { describe, expect, mock, test } from 'claude-code/testing';
import { registerBudget } from './budget';
import { collectEvidence, fileRisk, hasEvidence, resetRiskCache, type RiskPort } from './risk';
import { REMINDER_TEXT, registerNudges, SESSION_TEXT } from './nudge';
import { registerOnboarding } from './onboarding';
import { registerSession } from './session';

const KEY = 'ak:test-key';
const PROJECT = '/work/app';
const CODE_INTEL = 'mcp__plugin_constellation_constellation__code_intel';

type Answer = { additionalContext?: string[]; deny?: string; result?: unknown; text?: string };
type Bottom = (e: object) => Promise<Answer>;
/** Who raised the dispatch, as `next.origin` holds it. */
type Origin = { plugin: string; tier: string };
type Next = Bottom & { origin: Origin };
type Handler = ($: object, e: object, next: Next) => Promise<Answer>;

/** The model's own call: the engine raises it. */
const ENGINE: Origin = { plugin: 'engine', tier: 'core' };
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

/** How many `$.fs.exists` calls the handlers made. */
let existsCalls = 0;

/** Elements as plain data: the type and the props. */
const make =
	(type: string) =>
	(props: Record<string, unknown>) => ({ type, props });
const EL = { Box: make('Box'), Text: make('Text'), Button: make('Button'), Link: make('Link') };

/** The text a drawn tree shows. */
function shown(tree: unknown): string {
	if (typeof tree === 'string') return tree;
	if (Array.isArray(tree)) return tree.map(shown).join(' ');
	if (typeof tree !== 'object' || tree === null) return '';
	return shown(Reflect.get(Reflect.get(tree, 'props') ?? {}, 'children'));
}

/** How many times a handler asked for a redraw. */
let invalidations = 0;

const $ = {
	env: { get: async () => KEY },
	session: { cwd: async () => PROJECT, surfaces: async () => ['terminal'] },
	ui: {
		invalidate: () => {
			invalidations += 1;
		},
		resolve: () => EL,
		log: () => undefined,
	},
	store: { get: async () => undefined },
	config: { list: async () => [] },
	fs: {
		exists: async (path: string) => {
			existsCalls += 1;
			return path === `${PROJECT}/constellation.json`;
		},
	},
};

/**
 * The budget and nudge handlers as one hooks module registers them, raised
 * directly: the test kit does not surface a PreToolUse handler's added context.
 */
function load(options: PluginOptions) {
	resetRiskCache();
	const registered: Registered[] = [];
	const capture = (event: string, ...rest: unknown[]) => {
		const handler = rest[rest.length - 1] as Handler;
		const matcher = rest.length > 1 ? (rest[0] as Record<string, unknown>) : {};
		registered.push({ event, matcher, handler });
	};
	registerBudget(capture as unknown as On, options);
	registerNudges(capture as unknown as On);
	registerSession(capture as unknown as On);
	registerOnboarding(capture as unknown as On, options);
	invalidations = 0;

	/**
	 * Raises `event` through the handlers that match it, in registration order;
	 * what sits beneath them is `bottom`, and `origin` is who raised it.
	 */
	const raise = (event: string, e: object, bottom: Bottom = async () => ({}), origin = ENGINE): Promise<Answer> => {
		const chain = registered.filter((r) => r.event === event && matches(r.matcher, e));
		const step = (i: number): Next =>
			Object.assign(
				(input: object) => {
					const hook = chain[i];
					return hook === undefined ? bottom(input) : hook.handler($, input, step(i + 1));
				},
				{ origin },
			);
		return step(0)(e);
	};

	let calls = 0;
	/** A PreToolUse envelope for a Grep of `pattern`: it carries no `agentId`. */
	const grep = (pattern: string, tool_use_id: string) => ({ tool: 'Grep', pattern, tool_use_id });

	return {
		turn: (turnId: string) => raise('turn.start', { text: '', turnId }),
		codeIntel: (agentId?: string) => raise('tool.call', { tool: CODE_INTEL, tool_use_id: 'u', agentId }),
		/** A code_intel call running `code` for `agentId`, raised by `origin`, over a bottom that answers `answer`. */
		program: (agentId: string, code: string, answer: Answer, origin = ENGINE) =>
			raise('tool.call', { tool: CODE_INTEL, tool_use_id: 'u', agentId, code }, async () => answer, origin),
		sessionStart: (source: string) => raise('classic.SessionStart', { source }),
		/** The band above the prompt as drawn, or the marker beneath when it passes. */
		band: async () => shown(await raise('ui.render', { component: 'AbovePrompt', surface: 'terminal', props: { hasSurvey: false } }, async () => ({ text: 'beneath' }))),
		runEnds: (agentId: string) => raise('turn.complete', { turnId: 'r', agentId }),
		/**
		 * What the PreToolUse handler adds for a Grep of a symbol. As in the engine, the
		 * PreToolUse event runs beneath the call's tool.call, which alone carries `agentId`.
		 */
		search: async (agentId?: string, pattern = 'AuthService') => {
			const id = `call-${(calls += 1)}`;
			const answer = await raise('tool.call', { ...grep(pattern, id), agentId }, (e) =>
				raise('classic.PreToolUse', grep(pattern, Reflect.get(e, 'tool_use_id'))),
			);
			return answer.additionalContext;
		},
		/** A PreToolUse event with no tool.call above it. */
		bareSearch: async (tool_use_id: string) =>
			(await raise('classic.PreToolUse', grep('AuthService', tool_use_id))).additionalContext,
	};
}

const REMINDER = [REMINDER_TEXT];

describe('nudge budget', () => {
	test('gives exactly nudgeLimit reminders and then none', async () => {
		const m = load({ nudgeLimit: 2 });
		await m.turn('t1');
		expect([await m.search(), await m.search(), await m.search(), await m.search()]).toEqual([
			REMINDER,
			REMINDER,
			undefined,
			undefined,
		]);
	});

	test('defaults to three reminders', async () => {
		const m = load({});
		await m.turn('t1');
		expect([await m.search(), await m.search(), await m.search(), await m.search()]).toEqual([
			REMINDER,
			REMINDER,
			REMINDER,
			undefined,
		]);
	});

	test('a limit of zero gives no reminders', async () => {
		const m = load({ nudgeLimit: 0 });
		await m.turn('t1');
		expect(await m.search()).toBeUndefined();
	});

	test('a search that does not qualify spends nothing', async () => {
		const m = load({ nudgeLimit: 1 });
		await m.turn('t1');
		expect(await m.search(undefined, 'connection refused')).toBeUndefined();
		expect(await m.search()).toEqual(REMINDER);
	});

	test('a code_intel call earlier in the turn silences the searches after it and spends nothing', async () => {
		const m = load({ nudgeLimit: 2 });
		await m.turn('t1');
		await m.codeIntel();
		expect(await m.search()).toBeUndefined();
		expect(await m.search()).toBeUndefined();
		await m.turn('t2');
		expect([await m.search(), await m.search(), await m.search()]).toEqual([REMINDER, REMINDER, undefined]);
	});

	test('a search before the code_intel call in the same turn still nudges', async () => {
		const m = load({ nudgeLimit: 2 });
		await m.turn('t1');
		expect(await m.search()).toEqual(REMINDER);
		await m.codeIntel();
		expect(await m.search()).toBeUndefined();
	});

	test('a code_intel call outside any turn silences nothing', async () => {
		const m = load({ nudgeLimit: 2 });
		await m.codeIntel();
		await m.turn('t1');
		expect(await m.search()).toEqual(REMINDER);
	});

	for (const source of ['clear', 'resume', 'fork']) {
		test(`SessionStart from ${source} resets the budget`, async () => {
			const m = load({ nudgeLimit: 1 });
			await m.turn('t1');
			expect(await m.search()).toEqual(REMINDER);
			expect(await m.search()).toBeUndefined();
			await m.sessionStart(source);
			expect(await m.search()).toEqual(REMINDER);
		});
	}

	for (const source of ['startup', 'compact']) {
		test(`SessionStart from ${source} keeps the budget`, async () => {
			const m = load({ nudgeLimit: 1 });
			await m.turn('t1');
			expect(await m.search()).toEqual(REMINDER);
			await m.sessionStart(source);
			expect(await m.search()).toBeUndefined();
		});
	}

	test('a subagent has its own budget', async () => {
		const m = load({ nudgeLimit: 1 });
		await m.turn('t1');
		expect(await m.search()).toEqual(REMINDER);
		expect(await m.search()).toBeUndefined();
		expect(await m.search('agent-1')).toEqual(REMINDER);
		expect(await m.search('agent-1')).toBeUndefined();
		expect(await m.search('agent-2')).toEqual(REMINDER);
	});

	test('a subagent spending its budget leaves the main conversation its own', async () => {
		const m = load({ nudgeLimit: 1 });
		await m.turn('t1');
		expect(await m.search('agent-1')).toEqual(REMINDER);
		expect(await m.search()).toEqual(REMINDER);
	});

	test('a subagent search does not leave its agent behind for a later call', async () => {
		const m = load({ nudgeLimit: 1 });
		await m.turn('t1');
		expect(await m.search('agent-1')).toEqual(REMINDER);
		expect(await m.bareSearch('call-1')).toEqual(REMINDER);
	});

	test('a subagent that called code_intel gets no reminder for the rest of its run', async () => {
		const m = load({ nudgeLimit: 3 });
		await m.turn('t1');
		await m.codeIntel('agent-1');
		expect(await m.search('agent-1')).toBeUndefined();
		expect(await m.search('agent-2')).toEqual(REMINDER);
		expect(await m.search()).toEqual(REMINDER);
	});

	test('a subagent continued after its run ended gets a fresh budget and turn', async () => {
		const m = load({ nudgeLimit: 1 });
		await m.turn('t1');
		await m.codeIntel('agent-1');
		expect(await m.search('agent-1')).toBeUndefined();
		await m.runEnds('agent-1');
		expect(await m.search('agent-1')).toEqual(REMINDER);
	});

	test('a used-up budget skips the walk for constellation.json', async () => {
		const m = load({ nudgeLimit: 1 });
		await m.turn('t1');
		expect(await m.search()).toEqual(REMINDER);
		existsCalls = 0;
		expect(await m.search()).toBeUndefined();
		expect(existsCalls).toBe(0);
	});

	test('a SessionStart clear empties the risk cache', async () => {
		let calls = 0;
		const mcp: RiskPort = {
			after: () => {},
			connect: async () => ({ isConnected: true, server: 's' }),
			call: async () => {
				calls += 1;
				return { content: [{ type: 'text', text: JSON.stringify({ success: true, result: { dependents: [], used: [] } }) }], isError: false };
			},
		};
		const m = load({});
		await fileRisk(mcp, PROJECT, `${PROJECT}/a.ts`);
		await fileRisk(mcp, PROJECT, `${PROJECT}/a.ts`);
		expect(calls).toBe(1);
		await m.sessionStart('clear');
		await fileRisk(mcp, PROJECT, `${PROJECT}/a.ts`);
		expect(calls).toBe(2);
	});

	test('a code_intel call records evidence for its agent only, while collection is on', async () => {
		const m = load({});
		collectEvidence(true);
		await m.program('agent-1', 'api.getDependents({ filePath: "src/core.ts" })', { result: {}, text: '{"success":true}' });
		expect(hasEvidence('agent-1', ['src/core.ts'], [])).toBe(true);
		expect(hasEvidence('agent-2', ['src/core.ts'], [])).toBe(false);
		expect(hasEvidence('main', ['src/core.ts'], [])).toBe(false);
		collectEvidence(false);
	});

	test('with the gate off a code_intel call records no evidence', async () => {
		const m = load({});
		collectEvidence(false);
		await m.program('agent-1', 'api.getDependents({ filePath: "src/core.ts" })', { result: {}, text: '{"success":true}' });
		expect(hasEvidence('agent-1', ['src/core.ts'], [])).toBe(false);
	});

	test('a denied code_intel call records no evidence', async () => {
		const m = load({});
		collectEvidence(true);
		await m.program('agent-1', 'api.getDependents({ filePath: "src/core.ts" })', { deny: 'x' });
		expect(hasEvidence('agent-1', ['src/core.ts'], [])).toBe(false);
		collectEvidence(false);
	});

	test("a plugin's own code_intel call is not evidence but still counts as the turn's code_intel use", async () => {
		const m = load({ nudgeLimit: 1 });
		await m.turn('t1');
		const plugin = { plugin: 'constellation', tier: 'user' };
		collectEvidence(true);
		await m.program('agent-1', 'api.getDependents({ filePath: "src/core.ts" })', { result: {}, text: '{"success":true}' }, plugin);
		expect(hasEvidence('agent-1', ['src/core.ts'], ['Core'])).toBe(false);
		collectEvidence(false);
		expect(await m.search('agent-1')).toBeUndefined();
	});

	test('an AUTH_ERROR from the agent\'s code_intel call reaches the onboarding band', async () => {
		const m = load({});
		const authError = JSON.stringify({ success: false, error: { code: 'AUTH_ERROR', message: 'Invalid access key' } });
		await m.program('main', 'return await api.ping()', { result: authError, text: authError });
		expect(invalidations).toBe(1);
		expect(await m.band()).toContain('Constellation sign-in failed');
	});

	test('a SessionStart clear takes the onboarding band down', async () => {
		const m = load({});
		const authError = JSON.stringify({ success: false, error: { code: 'AUTH_ERROR', message: 'Invalid access key' } });
		await m.program('main', 'return await api.ping()', { result: authError, text: authError });
		await m.sessionStart('clear');
		expect(await m.band()).toBe('');
	});

	test("a plugin's own code_intel error leaves the onboarding band alone", async () => {
		const m = load({});
		const authError = JSON.stringify({ success: false, error: { code: 'AUTH_ERROR', message: 'Invalid access key' } });
		await m.program('main', 'return await api.ping()', { result: authError, text: authError }, { plugin: 'constellation', tier: 'user' });
		expect(invalidations).toBe(0);
		expect(await m.band()).toBe('');
	});

	test('a SessionStart reset clears subagent budgets too', async () => {
		const m = load({ nudgeLimit: 1 });
		await m.turn('t1');
		await m.search('agent-1');
		await m.sessionStart('clear');
		expect(await m.search('agent-1')).toEqual(REMINDER);
	});
});

describe('budget hooks as a loaded plugin', () => {
	test('turn.start, a code_intel call and SessionStart pass through', { options: { nudgeLimit: 2 } }, async ($, on) => {
		mock.env(on, { CONSTELLATION_ACCESS_KEY: KEY });
		on('turn.start', (_$, e) => ({ turnId: e.turnId }));
		on('tool.call', () => ({ result: 'beneath' }));
		on('classic.SessionStart', () => ({ additionalContext: ['beneath'] }));
		expect(await $.turn.start({ text: 'hi', turnId: 't1' })).toEqual({ turnId: 't1' });
		const call = await $.tool.call({ tool: CODE_INTEL, tool_use_id: 'u1' });
		expect(call).toEqual({ result: 'beneath' });
		expect(await $.tool.call({ tool: CODE_INTEL, tool_use_id: 'u2' })).toEqual({ result: 'beneath' });
		const start = await $.classic.SessionStart({ source: 'clear' });
		expect(start.additionalContext).toEqual(['beneath', SESSION_TEXT]);
	});
});
