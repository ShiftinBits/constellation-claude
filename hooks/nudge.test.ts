import type { On } from 'claude-code';
import { describe, expect, mock, test } from 'claude-code/testing';
import { REMINDER_TEXT, registerNudges, SESSION_TEXT } from './nudge';

const KEY = 'ak:test-key';

type Answer = { additionalContext?: string[]; deny?: string };

type Handler = (
	$: { env: { get: (name: string) => Promise<string | undefined> } },
	e: object,
	next: (e: object) => Promise<Answer>,
) => Promise<Answer>;

/** The PreToolUse handler the module registers, called directly with a constructed envelope. */
function preToolUse(): Handler {
	let handler: Handler | undefined;
	const capture = (pattern: string, ...rest: unknown[]) => {
		if (pattern === 'classic.PreToolUse') handler = rest[rest.length - 1] as Handler;
	};
	registerNudges(capture as unknown as On);
	if (!handler) throw new Error('no classic.PreToolUse handler registered');
	return handler;
}

/** What the PreToolUse handler adds for a tool call, given the key and what the chain beneath answers. */
async function nudgesFor(e: object, key: string | undefined, beneath: Answer = {}): Promise<Answer> {
	const $ = { env: { get: async () => key } };
	return preToolUse()($, e, async () => beneath);
}

const CASES: ReadonlyArray<readonly [string, object]> = [
	['Bash rg', { tool: 'Bash', command: 'rg foo src' }],
	['Bash grep in a pipeline', { tool: 'Bash', command: 'git log | grep x' }],
	['Grep', { tool: 'Grep', pattern: 'foo' }],
	['Glob', { tool: 'Glob', pattern: '**/*.ts' }],
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
			expect((await nudgesFor(e, KEY)).additionalContext).toEqual([REMINDER_TEXT]);
		});

		test(`${name} adds nothing without a key`, async () => {
			expect((await nudgesFor(e, undefined)).additionalContext).toBeUndefined();
		});

		test(`${name} adds nothing when the key does not start with ak:`, async () => {
			expect((await nudgesFor(e, 'sk:other')).additionalContext).toBeUndefined();
		});
	}

	test('Bash without a search command adds nothing', async () => {
		const r = await nudgesFor({ tool: 'Bash', command: 'ls -la' }, KEY);
		expect(r.additionalContext).toBeUndefined();
	});

	test('Bash with an empty command adds nothing', async () => {
		const r = await nudgesFor({ tool: 'Bash', command: '' }, KEY);
		expect(r.additionalContext).toBeUndefined();
	});

	test('the Bash trigger matches case-insensitively on word boundaries', async () => {
		expect((await nudgesFor({ tool: 'Bash', command: 'GREP -r x .' }, KEY)).additionalContext).toEqual([REMINDER_TEXT]);
		expect((await nudgesFor({ tool: 'Bash', command: 'echo fargrepper' }, KEY)).additionalContext).toBeUndefined();
	});

	test('keeps a decision and the context the chain beneath produced', async () => {
		const r = await nudgesFor({ tool: 'Grep', pattern: 'foo' }, KEY, { deny: 'no', additionalContext: ['earlier'] });
		expect(r).toEqual({ deny: 'no', additionalContext: ['earlier', REMINDER_TEXT] });
	});
});
