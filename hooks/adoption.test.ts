import type { On } from 'claude-code';
import { describe, expect, test } from 'claude-code/testing';
import {
	type Buckets,
	type Counts,
	dayKey,
	forgetDays,
	loadStats,
	noteCodeIntelCall,
	noteSearch,
	persist,
	ratio,
	resetAdoption,
	sessionCounts,
	total,
} from './adoption';
import { registerBudget } from './budget';
import { registerNudges } from './nudge';

const KEY = 'ak:test-key';
const PROJECT = '/work/app';
const CODE_INTEL = 'mcp__plugin_constellation_constellation__code_intel';

/** Local noon, so the local date is the same in every time zone. */
const NOON = new Date(2026, 9, 5, 12).getTime();
/** Local noon `days` days before `NOON`. */
const daysBack = (days: number) => new Date(2026, 9, 5 - days, 12).getTime();

type Answer = { context?: string[]; deny?: string; result?: unknown; text?: string; isError?: true };
type Bottom = (e: object) => Promise<Answer>;
/** Who raised the dispatch, as `next.origin` holds it. */
type Origin = { plugin: string; tier: string };
type Next = Bottom & { origin: Origin };
type Handler = ($: object, e: object, next: Next) => Promise<Answer>;
type Registered = { event: string; matcher: Record<string, unknown>; handler: Handler };

/** The model's own call: the engine raises it. */
const ENGINE: Origin = { plugin: 'engine', tier: 'core' };
/** This plugin's own `$.mcp.call`. */
const PLUGIN: Origin = { plugin: 'constellation', tier: 'user' };

const counts = (codeIntel: number, codeIntelMs: number, symbol: number, literal: number): Counts => ({ codeIntel, codeIntelMs, symbol, literal });
const NONE = counts(0, 0, 0, 0);

/** A store over a `Map` that keeps JSON copies, as `$.store` does, so a saved entry is not the object the module still changes. */
function fakeStore() {
	const data = new Map<string, string>();
	return {
		data,
		get: async (key: string): Promise<unknown> => {
			const text = data.get(key);
			return text === undefined ? undefined : JSON.parse(text);
		},
		set: async (key: string, value: unknown): Promise<void> => {
			data.set(key, JSON.stringify(value));
		},
		delete: async (key: string): Promise<void> => {
			data.delete(key);
		},
		keys: async () => [...data.keys()],
	};
}

type Store = ReturnType<typeof fakeStore>;

/** What the store holds under `key`, read as an entry. */
async function stored(store: Store, key: string): Promise<Buckets> {
	return (await store.get(key)) as Buckets;
}

/** The answer of a code_intel call that took `time` milliseconds. */
const took = (time: number): Answer => ({ text: JSON.stringify({ success: true, result: {}, time }) });

/** A code_intel call that failed, as the agent's tool call returns it: errored, `Error: ` before the envelope. */
const AUTH_ERROR_TEXT = `Error: ${JSON.stringify({ success: false, error: { code: 'AUTH_ERROR', message: 'Invalid access key' } })}`;
const AUTH_ERROR_CALL: Answer = { isError: true, result: AUTH_ERROR_TEXT, text: AUTH_ERROR_TEXT };

/**
 * The budget and nudge handlers as one hooks module registers them, raised
 * directly over `store`, with the session totals and the day entries in memory
 * started over.
 */
function load(store: Store = fakeStore()) {
	resetAdoption();
	forgetDays();
	const registered: Registered[] = [];
	const capture = (event: string, ...rest: unknown[]) => {
		const handler = rest[rest.length - 1] as Handler;
		const matcher = rest.length > 1 ? (rest[0] as Record<string, unknown>) : {};
		registered.push({ event, matcher, handler });
	};
	registerBudget(capture as unknown as On, {});
	registerNudges(capture as unknown as On);

	const $ = {
		env: { get: async () => KEY },
		session: { cwd: async () => PROJECT, surfaces: async () => ['terminal'], id: async () => 'session-1' },
		ui: { invalidate: () => undefined, log: () => undefined },
		store,
		clock: { now: async () => NOON },
		fs: { exists: async (path: string) => path === `${PROJECT}/constellation.json` },
	};

	const raise = (e: object, answer: Answer, origin: Origin): Promise<Answer> => {
		const chain = registered.filter(
			(r) => r.event === 'tool.call' && (r.matcher.tool as RegExp).test(String(Reflect.get(e, 'tool'))),
		);
		const step = (i: number): Next =>
			Object.assign(
				(input: object) => {
					const hook = chain[i];
					return hook === undefined ? Promise.resolve(answer) : hook.handler($, input, step(i + 1));
				},
				{ origin },
			);
		return step(0)(e);
	};

	return {
		store,
		key: dayKey(NOON, 'session-1'),
		/** A code_intel call by `agentId` (the main conversation when absent), raised by `origin`, that answers `answer`. */
		codeIntel: (answer: Answer, agentId?: string, origin = ENGINE) =>
			raise({ tool: CODE_INTEL, tool_use_id: 'u', agentId }, answer, origin),
		grep: (pattern: string, agentId?: string, answer: Answer = {}) =>
			raise({ tool: 'Grep', pattern, tool_use_id: 'u', agentId }, answer, ENGINE),
		bash: (command: string, agentId?: string) => raise({ tool: 'Bash', command, tool_use_id: 'u', agentId }, {}, ENGINE),
	};
}

describe('adoption counting through the hooks', () => {
	test('counts the agent\'s code_intel calls and searches per bucket, and nothing else', async () => {
		const m = load();
		await m.codeIntel(took(42));
		await m.codeIntel(took(1000), undefined, PLUGIN);
		await m.grep('AuthService');
		await m.grep('connection refused');
		await m.bash('ls -la');
		await m.bash('rg AuthService');
		await m.grep('UserService', undefined, { deny: 'no' });
		await m.codeIntel(took(8), 'agent-1');
		await m.grep('AuthService', 'agent-1');
		await m.grep('TODO', 'agent-2');

		const session = sessionCounts();
		expect(session).toEqual({ main: counts(1, 42, 2, 1), subagents: counts(1, 8, 1, 1) });
		expect(ratio(session.main)).toBe(1 / 3);
		expect(ratio(session.subagents)).toBe(0.5);
		expect(total(session)).toEqual(counts(2, 50, 3, 2));
		expect(ratio(total(session))).toBe(0.4);
		expect(await stored(m.store, m.key)).toEqual(session);
	});

	test('an errored code_intel call counts, with no time to add', async () => {
		const m = load();
		await m.codeIntel(AUTH_ERROR_CALL);
		expect(sessionCounts().main).toEqual(counts(1, 0, 0, 0));
	});

	test('a refused code_intel call is not counted', async () => {
		const m = load();
		await m.codeIntel({ deny: 'no' });
		expect(sessionCounts().main).toEqual(NONE);
		expect(m.store.data.size).toBe(0);
	});

	test('a store that fails leaves the answers as they came and the session counts in place', async () => {
		const store = fakeStore();
		store.set = async () => {
			throw new Error('store full');
		};
		const m = load(store);
		expect(await m.codeIntel(took(5))).toEqual(took(5));
		expect(await m.grep('connection refused', undefined, { result: 'ran' })).toEqual({ result: 'ran' });
		expect(sessionCounts().main).toEqual(counts(1, 5, 0, 1));
	});
});

describe('ratio', () => {
	test('is undefined with no code_intel call and no symbol-like search', () => {
		expect(ratio(counts(0, 0, 0, 7))).toBeUndefined();
	});

	test('leaves literal searches out', () => {
		expect(ratio(counts(3, 0, 1, 50))).toBe(0.75);
	});
});

describe('dayKey', () => {
	test('names the local date and the session', () => {
		expect(dayKey(NOON, 'abc')).toBe('adoption:2026-10-05:abc');
		expect(dayKey(new Date(2026, 0, 9, 12).getTime(), 'abc')).toBe('adoption:2026-01-09:abc');
	});
});

describe('stored day totals', () => {
	test('two sessions writing in turn over one store lose nothing', async () => {
		resetAdoption();
		forgetDays();
		const store = fakeStore();
		const [a, b] = [dayKey(NOON, 'session-a'), dayKey(NOON, 'session-b')];
		await persist(noteCodeIntelCall(true, 10), a, store.get, store.set);
		await persist(noteSearch(true, true), b, store.get, store.set);
		await persist(noteCodeIntelCall(false, 5), a, store.get, store.set);
		// The second session's module was loaded later: it holds nothing of the first one's in memory.
		forgetDays();
		await persist(noteSearch(false, false), b, store.get, store.set);
		await persist(noteCodeIntelCall(true), b, store.get, store.set);
		await persist(noteSearch(true, true), a, store.get, store.set);

		expect(await stored(store, a)).toEqual({ main: counts(1, 10, 1, 0), subagents: counts(1, 5, 0, 0) });
		expect(await stored(store, b)).toEqual({ main: counts(1, 0, 1, 0), subagents: counts(0, 0, 0, 1) });
		const stats = await loadStats(NOON, await store.keys(), store.get, store.delete);
		expect(stats).toEqual({ today: counts(3, 15, 2, 1), last30: counts(3, 15, 2, 1) });
	});

	test('two counts arriving together for a new key read the store once and both land', async () => {
		resetAdoption();
		forgetDays();
		const store = fakeStore();
		const key = dayKey(NOON, 'session-a');
		await store.set(key, { main: counts(4, 40, 0, 0), subagents: NONE });
		let reads = 0;
		const get = (k: string) => {
			reads += 1;
			return store.get(k);
		};
		await Promise.all([
			persist(noteCodeIntelCall(true, 1), key, get, store.set),
			persist(noteSearch(true, true), key, get, store.set),
		]);
		expect(reads).toBe(1);
		expect(await stored(store, key)).toEqual({ main: counts(5, 41, 1, 0), subagents: NONE });
	});

	test('after a reload the next count adds to the stored entry', async () => {
		resetAdoption();
		forgetDays();
		const store = fakeStore();
		const key = dayKey(NOON, 'session-a');
		await persist(noteCodeIntelCall(true, 10), key, store.get, store.set);
		await persist(noteCodeIntelCall(true, 10), key, store.get, store.set);
		await persist(noteSearch(false, true), key, store.get, store.set);
		forgetDays();
		await persist(noteCodeIntelCall(true, 10), key, store.get, store.set);
		expect(await stored(store, key)).toEqual({ main: counts(3, 30, 0, 0), subagents: counts(0, 0, 1, 0) });
	});

	test('a stored value that is not an entry is counted from zero', async () => {
		resetAdoption();
		forgetDays();
		const store = fakeStore();
		const key = dayKey(NOON, 'session-a');
		await store.set(key, { main: { codeIntel: 'many' } });
		await persist(noteSearch(true, false), key, store.get, store.set);
		expect(await stored(store, key)).toEqual({ main: counts(0, 0, 0, 1), subagents: NONE });
	});

	test('a read that fails is tried again by the next count', async () => {
		resetAdoption();
		forgetDays();
		const store = fakeStore();
		const key = dayKey(NOON, 'session-a');
		await store.set(key, { main: counts(2, 0, 0, 0), subagents: NONE });
		const failing = async () => {
			throw new Error('store unavailable');
		};
		await expect(persist(noteCodeIntelCall(true), key, failing, store.set)).rejects.toThrow('store unavailable');
		await persist(noteCodeIntelCall(true), key, store.get, store.set);
		expect((await stored(store, key)).main).toEqual(counts(3, 0, 0, 0));
	});

	test('resetAdoption zeroes the session totals and leaves the stored day totals', async () => {
		resetAdoption();
		forgetDays();
		const store = fakeStore();
		const key = dayKey(NOON, 'session-a');
		await persist(noteCodeIntelCall(true, 10), key, store.get, store.set);
		await persist(noteSearch(false, true), key, store.get, store.set);

		resetAdoption();
		expect(sessionCounts()).toEqual({ main: NONE, subagents: NONE });
		expect(await stored(store, key)).toEqual({ main: counts(1, 10, 0, 0), subagents: counts(0, 0, 1, 0) });

		await persist(noteCodeIntelCall(true, 10), key, store.get, store.set);
		expect(sessionCounts().main).toEqual(counts(1, 10, 0, 0));
		expect((await stored(store, key)).main).toEqual(counts(2, 20, 0, 0));
	});
});

describe('loadStats', () => {
	const entry = (codeIntel: number): Buckets => ({ main: counts(codeIntel, 0, 0, 0), subagents: counts(0, 0, 1, 0) });

	test('sums today and the last 30 days, and deletes what is older', async () => {
		const store = fakeStore();
		await store.set(dayKey(NOON, 'a'), entry(1));
		await store.set(dayKey(NOON, 'b'), entry(2));
		await store.set(dayKey(daysBack(1), 'a'), entry(4));
		await store.set(dayKey(daysBack(29), 'a'), entry(8));
		await store.set(dayKey(daysBack(31), 'a'), entry(16));

		const stats = await loadStats(NOON, await store.keys(), store.get, store.delete);

		expect(stats).toEqual({ today: counts(3, 0, 2, 0), last30: counts(15, 0, 4, 0) });
		expect(await store.keys()).toEqual([dayKey(NOON, 'a'), dayKey(NOON, 'b'), dayKey(daysBack(1), 'a'), dayKey(daysBack(29), 'a')]);
	});

	test('skips keys and values that are not its own', async () => {
		const store = fakeStore();
		await store.set('project:/work/app', '/work/app');
		await store.set('adoption:someday:a', entry(1));
		await store.set(dayKey(NOON, 'broken'), { main: 'x' });
		await store.set(dayKey(NOON, 'a'), entry(2));

		const stats = await loadStats(NOON, await store.keys(), store.get, store.delete);

		expect(stats).toEqual({ today: counts(2, 0, 1, 0), last30: counts(2, 0, 1, 0) });
		expect(store.data.size).toBe(4);
	});
});
