import type { On, PluginOptions } from 'claude-code';
import { describe, expect, mock, test } from 'claude-code/testing';
import { registerBudget } from './budget';
import { freshnessLine, registerFreshness, track } from './freshness';
import { collectEvidence, fileRisk, hasEvidence, resetRiskCache, type RiskPort } from './risk';
import { REMINDER_TEXT, registerNudges, SESSION_TEXT } from './nudge';
import { registerOnboarding } from './onboarding';
import { registerSession } from './session';

const KEY = 'ak:test-key';
const PROJECT = '/work/app';
const CODE_INTEL = 'mcp__plugin_constellation_constellation__code_intel';

type Answer = { additionalContext?: string[]; context?: string[]; deny?: string; result?: unknown; text?: string; isError?: true };
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

/** The session's access key as `$.env.get` answers it. */
let sessionKey: string | undefined = KEY;

/** The git commands the handlers ran, and the commit HEAD is at. */
const gitRuns: string[][] = [];
/** Whether `git status` reports changes, how many `$.config.list` reads were made, the surfaces the session has and what `$.ui.log` got. */
let dirtyTree = false;
let configReads = 0;
let surfaces: string[] = ['terminal'];
const logLines: string[] = [];
const HEAD = '0123456789abcdef0123456789abcdef01234567';

const $ = {
	env: { get: async () => sessionKey },
	session: { cwd: async () => PROJECT, surfaces: async () => surfaces },
	ui: {
		invalidate: () => {
			invalidations += 1;
		},
		resolve: () => EL,
		log: (text: string) => void logLines.push(text),
	},
	store: { get: async () => undefined },
	config: {
		list: async () => {
			configReads += 1;
			return [];
		},
	},
	clock: { now: async () => Date.now() },
	process: {
		run: async (argv: readonly string[]) => {
			gitRuns.push([...argv]);
			if (argv.includes('rev-parse')) return { exitCode: 0, stdout: `${HEAD}\nrefs/heads/main\n` };
			return { exitCode: 0, stdout: argv.includes('rev-list') ? '3\n' : argv.includes('status') && dirtyTree ? ' M a.ts\n' : '' };
		},
	},
	fs: {
		exists: async (path: string) => {
			existsCalls += 1;
			return path === `${PROJECT}/constellation.json`;
		},
	},
};

/**
 * The budget and nudge handlers as one hooks module registers them, raised
 * directly, so each test starts from a budget this module instance can read.
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
	registerFreshness(capture as unknown as On, options);
	invalidations = 0;
	gitRuns.length = 0;
	dirtyTree = false;
	configReads = 0;
	surfaces = ['terminal'];
	logLines.length = 0;

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
	return {
		turn: (turnId: string) => raise('turn.start', { text: '', turnId }),
		codeIntel: (agentId?: string) => raise('tool.call', { tool: CODE_INTEL, tool_use_id: 'u', agentId }),
		/** A code_intel call running `code` for `agentId`, raised by `origin`, over a bottom that answers `answer`. */
		program: (agentId: string, code: string, answer: Answer, origin = ENGINE) =>
			raise('tool.call', { tool: CODE_INTEL, tool_use_id: 'u', agentId, code }, async () => answer, origin),
		sessionStart: (source: string) => raise('classic.SessionStart', { source }),
		/** The band above the prompt as drawn, or the marker beneath when it passes. */
		/** The raw tree the band returns over a `bottom` that draws `beneath`, with the survey flag as given. */
		draw: (beneath: object = { type: 'Text', props: { children: 'beneath' } }, hasSurvey = false) =>
			raise('ui.render', { component: 'AbovePrompt', surface: 'terminal', props: { hasSurvey } }, async () => beneath),
		band: async () => shown(await raise('ui.render', { component: 'AbovePrompt', surface: 'terminal', props: { hasSurvey: false } }, async () => ({ text: 'beneath' }))),
		runEnds: (agentId: string) => raise('turn.complete', { turnId: 'r', agentId }),
		/** What the search handler adds for a Grep of a symbol by `agentId`, the main conversation when absent. */
		search: async (agentId?: string, pattern = 'AuthService') =>
			(await raise('tool.call', { tool: 'Grep', pattern, tool_use_id: `call-${(calls += 1)}`, agentId })).context,
	};
}

const REMINDER = [REMINDER_TEXT];

/** A code_intel call that failed with AUTH_ERROR, as the agent's tool call returns it: errored, `Error: ` before the envelope. */
const AUTH_ERROR_TEXT = `Error: ${JSON.stringify({ success: false, error: { code: 'AUTH_ERROR', message: 'Invalid access key' } })}`;
const AUTH_ERROR_CALL: Answer = { isError: true, result: AUTH_ERROR_TEXT, text: AUTH_ERROR_TEXT };

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
		await m.program('main', 'return await api.ping()', AUTH_ERROR_CALL);
		expect(invalidations).toBe(1);
		expect(await m.band()).toContain('Constellation sign-in failed');
	});

	test("with no key set, the agent's AUTH_ERROR says not signed in", async () => {
		const m = load({});
		sessionKey = undefined;
		try {
			await m.program('main', 'return await api.ping()', AUTH_ERROR_CALL);
		} finally {
			sessionKey = KEY;
		}
		expect(await m.band()).toContain("Constellation isn't signed in");
	});

	test('a SessionStart clear takes the onboarding band down', async () => {
		const m = load({});
		await m.program('main', 'return await api.ping()', AUTH_ERROR_CALL);
		await m.sessionStart('clear');
		expect(await m.band()).toBe('');
	});

	test("a plugin's own code_intel error leaves the onboarding band alone", async () => {
		const m = load({});
		await m.program('main', 'return await api.ping()', AUTH_ERROR_CALL, { plugin: 'constellation', tier: 'user' });
		expect(invalidations).toBe(0);
		expect(await m.band()).toBe('');
	});

	test("an agent's code_intel answer with a newer index commit updates the freshness indicator", async () => {
		const m = load({});
		track(PROJECT);
		const old = 'fedcba9876543210fedcba9876543210fedcba98';
		await m.program('main', 'return await api.ping()', { text: JSON.stringify({ success: true, result: {}, asOfCommit: old }) });
		for (let i = 0; i < 50; i++) await Promise.resolve();
		expect(gitRuns.some((argv) => argv.includes('rev-parse'))).toBe(true);
		expect(freshnessLine(0)?.text).toBe('✦ index 3 commits behind');
		expect(invalidations).toBe(1);
	});

	test("a plugin's own code_intel answer and a denied call leave the freshness indicator alone", async () => {
		const m = load({});
		track(PROJECT);
		const text = JSON.stringify({ success: true, result: {}, asOfCommit: 'fedcba9876543210fedcba9876543210fedcba98' });
		await m.program('main', 'return await api.ping()', { text }, { plugin: 'constellation', tier: 'user' });
		await m.program('main', 'return await api.ping()', { deny: 'no', text });
		for (let i = 0; i < 50; i++) await Promise.resolve();
		expect(gitRuns).toEqual([]);
		expect(freshnessLine(0)).toBeUndefined();
		expect(invalidations).toBe(0);
	});

	test('a SessionStart reset clears subagent budgets too', async () => {
		const m = load({ nudgeLimit: 1 });
		await m.turn('t1');
		await m.search('agent-1');
		await m.sessionStart('clear');
		expect(await m.search('agent-1')).toEqual(REMINDER);
	});
});

describe('freshness band above the prompt', () => {
	const OLD = 'fedcba9876543210fedcba9876543210fedcba98';
	const staleAnswer = (asOfCommit = OLD): Answer => ({
		text: JSON.stringify({ success: true, result: {}, asOfCommit, lastIndexedAt: new Date(Date.now() - 7_200_000).toISOString() }),
	});
	const settle = async () => {
		for (let i = 0; i < 50; i++) await Promise.resolve();
	};
	/** Loads the module with the index behind HEAD by three commits. */
	const behind = async (state: { dirty?: boolean; cannotDraw?: boolean } = {}) => {
		const m = load({});
		track(PROJECT);
		dirtyTree = state.dirty === true;
		if (state.cannotDraw === true) surfaces = [];
		await m.program('main', 'return await api.ping()', staleAnswer());
		await settle();
		return m;
	};
	/** The row's text as the terminal joins its pieces: no space between them. */
	const flat = (tree: unknown) => shown(tree).replace(/ {2,}/g, ' ');
	const BENEATH = { type: 'Text', props: { children: 'beneath' } };

	test('a fresh index returns what the lower mod returned and reads no store, clock or config', async () => {
		for (const dirty of [false, true]) {
			const m = load({});
			track(PROJECT);
			dirtyTree = dirty;
			await m.program('main', 'return await api.ping()', staleAnswer(HEAD));
			await settle();
			expect(await m.draw(BENEATH)).toBe(BENEATH);
			expect(configReads).toBe(0);
		}
	});

	test('behind shows the state and index age above a lower mod element', async () => {
		const m = await behind();
		const tree = await m.draw();
		expect(flat(tree)).toBe('✦ index 3 commits behind · indexed 2h ago beneath');
		expect(Reflect.get(Reflect.get(tree, 'props'), 'flexDirection')).toBe('column');
		expect(configReads).toBe(1);
	});

	test('a dirty tree adds the local changes suffix', async () => {
		const m = await behind({ dirty: true });
		expect(flat(await m.draw())).toContain(' + local changes');
	});

	test('draws the row alone when nothing draws beneath', async () => {
		const m = await behind();
		for (const none of [{ type: 'engine', ref: 0 }, { type: 'Box', props: { children: [] } }]) {
			expect(flat(await m.draw(none))).toBe('✦ index 3 commits behind · indexed 2h ago');
		}
	});

	test('an error with no index shows its code and guidance', async () => {
		const m = load({});
		track(PROJECT);
		const failed = { success: false, error: { code: 'API_UNREACHABLE', message: 'unreachable' } };
		await m.program('main', 'return await api.ping()', { text: JSON.stringify(failed) });
		expect(shown(await m.draw())).toContain('✦ API_UNREACHABLE');
	});

	test('yields to a survey', async () => {
		const m = await behind();
		const before = configReads;
		expect(await m.draw(BENEATH, true)).toBe(BENEATH);
		expect(configReads).toBe(before);
	});

	test('an onboarding state, shown or dismissed, hides the freshness row', async () => {
		const m = await behind();
		await m.program('main', 'return await api.ping()', AUTH_ERROR_CALL);
		const tree = await m.draw();
		expect(shown(tree)).toContain('Constellation sign-in failed');
		expect(shown(tree)).not.toContain('index 3 commits behind');
	});

	test('a surface that cannot draw gets one log line when behind, and none on a second recheck', async () => {
		const m = await behind({ cannotDraw: true });
		expect(logLines).toEqual(['✦ index 3 commits behind · indexed 2h ago']);
		await m.program('main', 'return await api.ping()', staleAnswer('ab' + OLD.slice(2)));
		await settle();
		expect(logLines).toHaveLength(1);
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
