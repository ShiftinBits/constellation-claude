import { atom, read, update } from 'claude-code';
import type { On, StateDollar } from 'claude-code';
import { describe, expect, test } from 'claude-code/testing';
import { ADOPTION_SHAPE, NO_COUNTS } from './adoption';
import { hasNudgeLeft, registerBudget, spendNudge } from './budget';
import { NO_PANE, PANE_SHAPE } from './command';
import { FRESHNESS_SHAPE } from './freshness';
import { BAND_SHAPE, NO_BAND } from './onboarding';
import { registerSession } from './session';

type Handler = ($: object, e: object, next: (e: object) => Promise<object>) => Promise<object>;
type Registered = { event: string; matcher: Record<string, unknown>; handler: Handler };

/** True when the event `e` satisfies a matcher: a list of values or a value per field. */
function matches(matcher: Record<string, unknown>, e: object): boolean {
	return Object.entries(matcher).every(([field, want]) => {
		const got: unknown = Reflect.get(e, field);
		if (Array.isArray(want)) return want.includes(got);
		return want === got;
	});
}

/** `$.state` over a `Map`, as the host keeps it: each value with a version, and a write that misses on a stale `ifVersion`. */
function fakeState() {
	const values = new Map<string, { value: unknown; version: number }>();
	const id = (ref: { plugin: string; key: string }) => `${ref.plugin}:${ref.key}`;
	return {
		get: async (ref: { plugin: string; key: string }) => values.get(id(ref)) ?? { value: undefined, version: 0 },
		set: async (ref: { plugin: string; key: string }, value: unknown, options: { ifVersion?: number } = {}) => {
			const held = values.get(id(ref)) ?? { value: undefined, version: 0 };
			if (options.ifVersion !== undefined && options.ifVersion !== held.version) return { isSet: false, version: held.version };
			values.set(id(ref), { value: JSON.parse(JSON.stringify(value)), version: held.version + 1 });
			return { isSet: true, version: held.version + 1 };
		},
	};
}

const ADOPTION = atom({ plugin: 'constellation', key: 'adoption' } as const, NO_COUNTS, { shape: ADOPTION_SHAPE });
const BAND = atom({ plugin: 'constellation', key: 'band' } as const, NO_BAND, { shape: BAND_SHAPE });
const FRESHNESS = atom({ plugin: 'constellation', key: 'freshness' } as const, null, { shape: FRESHNESS_SHAPE });
const PANE = atom({ plugin: 'constellation', key: 'pane' } as const, NO_PANE, { shape: PANE_SHAPE });

/** Counts, a band, a freshness line and a pane on the diagnose tab with its answer, as a conversation leaves them. */
const COUNTED = { main: { codeIntel: 2, codeIntelMs: 30, symbol: 1, literal: 0 }, subagents: NO_COUNTS.subagents };
const BEHIND = { kind: 'behind' as const, behind: 3 };
const DIAGNOSED = { ...NO_PANE, tab: 'diagnose' as const, cwd: '/work/app', results: { diagnose: { success: true, result: {} } } };

/**
 * The budget and session handlers as one hooks module registers them, with a
 * main-conversation budget of one nudge, already spent, and `$.state` holding
 * what a conversation drew: counts, the band `band`, a freshness line and a
 * pane. `end(reason)` raises `session.end` through the handlers that match it.
 */
async function spentSession(band: { state?: 'sign-in-again' | 'not-set-up'; detail?: string } = { state: 'sign-in-again' }) {
	const registered: Registered[] = [];
	const capture = (event: string, ...rest: unknown[]) => {
		const handler = rest[rest.length - 1] as Handler;
		const matcher = rest.length > 1 ? (rest[0] as Record<string, unknown>) : {};
		registered.push({ event, matcher, handler });
	};
	registerBudget(capture as unknown as On, { nudgeLimit: 1 });
	registerSession(capture as unknown as On);
	expect(spendNudge({})).toBe(true);
	expect(hasNudgeLeft({})).toBe(false);
	const $ = { state: fakeState() };
	const state$ = $ as unknown as StateDollar;
	await update(state$, ADOPTION, () => COUNTED);
	await update(state$, BAND, () => band);
	await update(state$, FRESHNESS, () => BEHIND);
	await update(state$, PANE, () => DIAGNOSED);
	/** What `$.state` holds now. */
	const held = async () => ({
		adoption: await read(state$, ADOPTION),
		band: await read(state$, BAND),
		freshness: await read(state$, FRESHNESS),
		pane: await read(state$, PANE),
	});

	const end = async (reason: string) => {
		const e = { reason, sessionId: 'session-1', resume: { id: 'session-1' } };
		const chain = registered.filter((r) => r.event === 'session.end' && matches(r.matcher, e));
		const step =
			(i: number) =>
			(input: object): Promise<object> => {
				const hook = chain[i];
				return hook === undefined ? Promise.resolve({ sessionId: 'session-1' }) : hook.handler($, input, step(i + 1));
			};
		return step(0)(e);
	};
	return { end, held };
}

describe('session end', () => {
	for (const reason of ['clear', 'resume']) {
		test(`a session ending with ${reason} starts the module state over`, async () => {
			const { end } = await spentSession();
			expect(await end(reason)).toEqual({ sessionId: 'session-1' });
			expect(hasNudgeLeft({})).toBe(true);
		});

		test(`a session ending with ${reason} starts the drawn state over, and keeps the freshness line`, async () => {
			const { end, held } = await spentSession();
			await end(reason);
			expect(await held()).toEqual({ adoption: NO_COUNTS, band: NO_BAND, freshness: BEHIND, pane: NO_PANE });
		});
	}

	test('a session ending with clear keeps a not set up band, which describes the process, not the conversation', async () => {
		const { end, held } = await spentSession({ state: 'not-set-up' });
		await end('clear');
		expect((await held()).band).toEqual({ state: 'not-set-up' });
	});

	for (const reason of ['prompt_input_exit', 'logout', 'other']) {
		test(`a session ending with ${reason} keeps the module state`, async () => {
			const { end } = await spentSession();
			expect(await end(reason)).toEqual({ sessionId: 'session-1' });
			expect(hasNudgeLeft({})).toBe(false);
		});

		test(`a session ending with ${reason} keeps the drawn state`, async () => {
			const { end, held } = await spentSession();
			await end(reason);
			expect(await held()).toEqual({ adoption: COUNTED, band: { state: 'sign-in-again' }, freshness: BEHIND, pane: DIAGNOSED });
		});
	}
});
