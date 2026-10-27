import type { On } from 'claude-code';
import { describe, expect, test } from 'claude-code/testing';
import { hasNudgeLeft, registerBudget, spendNudge } from './budget';
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

/**
 * The budget and session handlers as one hooks module registers them, with a
 * main-conversation budget of one nudge, already spent. `end(reason)` raises
 * `session.end` through the handlers that match it.
 */
function spentSession() {
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

	const end = async (reason: string) => {
		const e = { reason, sessionId: 'session-1', resume: { id: 'session-1' } };
		const chain = registered.filter((r) => r.event === 'session.end' && matches(r.matcher, e));
		const step =
			(i: number) =>
			(input: object): Promise<object> => {
				const hook = chain[i];
				return hook === undefined ? Promise.resolve({ sessionId: 'session-1' }) : hook.handler({}, input, step(i + 1));
			};
		return step(0)(e);
	};
	return { end };
}

describe('session end', () => {
	for (const reason of ['clear', 'resume']) {
		test(`a session ending with ${reason} starts the module state over`, async () => {
			const { end } = spentSession();
			expect(await end(reason)).toEqual({ sessionId: 'session-1' });
			expect(hasNudgeLeft({})).toBe(true);
		});
	}

	for (const reason of ['prompt_input_exit', 'logout', 'other']) {
		test(`a session ending with ${reason} keeps the module state`, async () => {
			const { end } = spentSession();
			expect(await end(reason)).toEqual({ sessionId: 'session-1' });
			expect(hasNudgeLeft({})).toBe(false);
		});
	}
});
