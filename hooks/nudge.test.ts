import type { On } from 'claude-code';
import { describe, expect, mock, test } from 'claude-code/testing';
import { registerAdoption } from './adoption';
import { registerBudget } from './budget';
import { REMINDER_TEXT, registerNudges, SESSION_TEXT } from './nudge';

const KEY = 'ak:test-key';

type Answer = { context?: string[]; deny?: string };

type Handler = (
	$: {
		env: { get: (name: string) => Promise<string | undefined> };
		session: { cwd: () => Promise<string>; id: () => Promise<string> };
		fs: { exists: (path: string) => Promise<boolean> };
		store: {
			get: (key: string) => Promise<unknown>;
			set: (key: string, value: unknown) => Promise<void>;
			keys: () => Promise<string[]>;
			delete: (key: string) => Promise<void>;
		};
		clock: { now: () => Promise<number> };
	},
	e: object,
	next: ((e: object) => Promise<Answer>) & { origin: { plugin: string; tier: string } },
) => Promise<Answer>;

const PROJECT = '/work/app';
const OUTSIDE = '/elsewhere';

/**
 * The search handler the module registers on `tool.call`, called directly with a
 * constructed envelope. Registering the budget starts every call with a full one.
 */
function searchCall(): Handler {
	let handler: Handler | undefined;
	const capture = (pattern: string, ...rest: unknown[]) => {
		if (pattern === 'tool.call') handler = rest[rest.length - 1] as Handler;
	};
	registerAdoption((() => {}) as unknown as On, {});
	registerBudget((() => {}) as unknown as On, {});
	registerNudges(capture as unknown as On);
	if (!handler) throw new Error('no tool.call handler registered');
	return handler;
}

/**
 * What the search handler adds for a tool call, given the key, the working
 * directory, and what the chain beneath answers. `/work/app` holds a
 * constellation.json; `/elsewhere` does not.
 */
async function nudgesFor(
	e: object,
	key: string | undefined,
	beneath: Answer = {},
	cwd: string = PROJECT,
): Promise<Answer> {
	const $ = {
		env: { get: async () => key },
		session: { cwd: async () => cwd, id: async () => 'session-1' },
		fs: { exists: async (path: string) => path === `${PROJECT}/constellation.json` },
		store: { get: async () => undefined, set: async () => undefined, keys: async () => [], delete: async () => undefined },
		clock: { now: async () => 0 },
	};
	// The model's own call: the engine raises it.
	return searchCall()($, e, Object.assign(async () => beneath, { origin: { plugin: 'engine', tier: 'core' } }));
}

const CASES: ReadonlyArray<readonly [string, object]> = [
	['Bash rg of a symbol', { tool: 'Bash', command: 'rg AuthService src/' }],
	['Bash grep of a symbol', { tool: 'Bash', command: 'grep -rn getUser .' }],
	['Bash git grep of a symbol', { tool: 'Bash', command: 'git grep Foo' }],
	['Grep of a declaration', { tool: 'Grep', pattern: 'class UserService' }],
	['Grep of a symbol', { tool: 'Grep', pattern: 'AuthService' }],
	['Glob with a PascalCase stem', { tool: 'Glob', pattern: '**/UserService.ts' }],
];

const QUIET_CASES: ReadonlyArray<readonly [string, object]> = [
	['Bash grep of quoted text', { tool: 'Bash', command: "grep -rn 'connection refused' src" }],
	['Bash grep after a pipe', { tool: 'Bash', command: 'cat log.txt | grep ERROR' }],
	['Bash git log piped to grep', { tool: 'Bash', command: 'git log | grep x' }],
	['Bash awk', { tool: 'Bash', command: 'awk /AuthService/ file' }],
	['Bash findstr', { tool: 'Bash', command: 'findstr AuthService file' }],
	['Bash without a search command', { tool: 'Bash', command: 'ls -la' }],
	['Bash with an empty command', { tool: 'Bash', command: '' }],
	['Grep of a marker word', { tool: 'Grep', pattern: 'TODO' }],
	['Grep of error text', { tool: 'Grep', pattern: 'connection refused' }],
	['Grep with no pattern', { tool: 'Grep' }],
	['Glob of an extension', { tool: 'Glob', pattern: '**/*.ts' }],
	['Grep of a symbol in a path outside any project', { tool: 'Grep', pattern: 'AuthService', path: `${OUTSIDE}/src` }],
	['Glob of a symbol in a path outside any project', { tool: 'Glob', pattern: '**/UserService.ts', path: OUTSIDE }],
	['another tool', { tool: 'Read', pattern: 'AuthService' }],
];

describe('session and subagent awareness', () => {
	test('SessionStart adds exactly the session text with an ak: key', async ($, on) => {
		mock.env(on, { CONSTELLATION_ACCESS_KEY: KEY });
		on('classic.SessionStart', () => ({}));
		const r = await $.classic.SessionStart({ source: 'startup' });
		expect(r.additionalContext).toEqual([SESSION_TEXT]);
	});

	test('SubagentStart adds exactly the session text with an ak: key', async ($, on) => {
		mock.env(on, { CONSTELLATION_ACCESS_KEY: KEY });
		on('classic.SubagentStart', () => ({}));
		const r = await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' });
		expect(r.additionalContext).toEqual([SESSION_TEXT]);
	});

	test('SessionStart keeps the context the chain beneath produced', async ($, on) => {
		mock.env(on, { CONSTELLATION_ACCESS_KEY: KEY });
		on('classic.SessionStart', () => ({ additionalContext: ['earlier'] }));
		const r = await $.classic.SessionStart({ source: 'resume' });
		expect(r.additionalContext).toEqual(['earlier', SESSION_TEXT]);
	});

	test('SessionStart adds nothing without a key', async ($, on) => {
		mock.env(on, {});
		on('classic.SessionStart', () => ({}));
		const r = await $.classic.SessionStart({ source: 'startup' });
		expect(r.additionalContext).toBeUndefined();
	});

	test('SessionStart adds nothing when the key does not start with ak:', async ($, on) => {
		mock.env(on, { CONSTELLATION_ACCESS_KEY: 'sk:other' });
		on('classic.SessionStart', () => ({}));
		const r = await $.classic.SessionStart({ source: 'startup' });
		expect(r.additionalContext).toBeUndefined();
	});

	test('SubagentStart adds nothing without a key', async ($, on) => {
		mock.env(on, {});
		on('classic.SubagentStart', () => ({}));
		const r = await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' });
		expect(r.additionalContext).toBeUndefined();
	});
});

describe('search nudge', () => {
	for (const [name, e] of CASES) {
		test(`${name} adds exactly one reminder with an ak: key`, async () => {
			expect((await nudgesFor(e, KEY)).context).toEqual([REMINDER_TEXT]);
		});

		test(`${name} adds nothing without a key`, async () => {
			expect((await nudgesFor(e, undefined)).context).toBeUndefined();
		});

		test(`${name} adds nothing when the key does not start with ak:`, async () => {
			expect((await nudgesFor(e, 'sk:other')).context).toBeUndefined();
		});

		test(`${name} adds nothing when the working directory is outside an indexed project`, async () => {
			expect((await nudgesFor(e, KEY, {}, OUTSIDE)).context).toBeUndefined();
		});
	}

	for (const [name, e] of QUIET_CASES) {
		test(`${name} adds nothing`, async () => {
			expect((await nudgesFor(e, KEY)).context).toBeUndefined();
		});
	}

	test('a Grep path inside the project nudges even when the working directory is outside it', async () => {
		const e = { tool: 'Grep', pattern: 'AuthService', path: `${PROJECT}/src` };
		expect((await nudgesFor(e, KEY, {}, OUTSIDE)).context).toEqual([REMINDER_TEXT]);
	});

	test('a Glob path inside the project nudges even when the working directory is outside it', async () => {
		const e = { tool: 'Glob', pattern: '**/UserService.ts', path: PROJECT };
		expect((await nudgesFor(e, KEY, {}, OUTSIDE)).context).toEqual([REMINDER_TEXT]);
	});

	test('a Grep path outside the project adds nothing even when the working directory is inside it', async () => {
		const e = { tool: 'Grep', pattern: 'AuthService', path: OUTSIDE };
		expect((await nudgesFor(e, KEY)).context).toBeUndefined();
	});

	test('a shell search of a path inside the project nudges even when the working directory is outside it', async () => {
		const e = { tool: 'Bash', command: `grep -rn AuthService ${PROJECT}/src` };
		expect((await nudgesFor(e, KEY, {}, OUTSIDE)).context).toEqual([REMINDER_TEXT]);
	});

	test('a cd into the project before a shell search nudges', async () => {
		const e = { tool: 'Bash', command: `cd ${PROJECT} && rg AuthService src` };
		expect((await nudgesFor(e, KEY, {}, OUTSIDE)).context).toEqual([REMINDER_TEXT]);
	});

	test('a shell search of a path outside the project adds nothing even when the working directory is inside it', async () => {
		const e = { tool: 'Bash', command: `rg AuthService ${OUTSIDE}/src` };
		expect((await nudgesFor(e, KEY)).context).toBeUndefined();
	});

	test('keeps the context the chain beneath produced', async () => {
		const r = await nudgesFor({ tool: 'Grep', pattern: 'AuthService' }, KEY, { context: ['earlier'] });
		expect(r).toEqual({ context: ['earlier', REMINDER_TEXT] });
	});

	test('a refused call passes through as it came', async () => {
		const r = await nudgesFor({ tool: 'Grep', pattern: 'AuthService' }, KEY, { deny: 'no' });
		expect(r).toEqual({ deny: 'no' });
	});
});
