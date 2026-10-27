import type { On, PluginOptions } from 'claude-code';
import { describe, expect, test } from 'claude-code/testing';
import { compareLocal, freshnessBand, freshnessText, freshnessView, observeEnvelope, recheck, registerFreshness, resetFreshness, showsFreshness, startTicks, track } from './freshness';
import type { FreshnessView, Publish } from './freshness';
import { GIT, GIT_ENV, GIT_TIMEOUT_MS } from './lib';
import { BRAND, palette } from './theme';

const ROOT = '/work/app';
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const OLD = 'fedcba9876543210fedcba9876543210fedcba98';
const NOW = Date.parse('2026-05-01T12:00:00Z');
const TWO_HOURS_AGO = '2026-05-01T10:00:00Z';

type Answer = { exitCode: number; stdout: string } | Error;
type Call = { argv: readonly string[]; init: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } };

/** A `run` that records argv and answers per git subcommand. */
function fakeRun(answers: { head?: Answer; count?: Answer }) {
	const calls: Call[] = [];
	const run = async (argv: readonly string[], init: Call['init']) => {
		calls.push({ argv, init });
		const sub = argv[GIT.length];
		const answer = (sub === 'rev-parse' ? answers.head : sub === 'rev-list' ? answers.count : undefined) ?? { exitCode: 0, stdout: '' };
		if (answer instanceof Error) throw answer;
		return answer;
	};
	return { run, calls };
}

const onBranch = (name: string, sha = COMMIT): Answer => ({ exitCode: 0, stdout: `${sha}\nrefs/heads/${name}\n` });
/** What the line last published to `$.state` holds, and how many times it was published: each a redraw of the band. */
const board: { view: FreshnessView | null; writes: number } = { view: null, writes: 0 };
const publish: Publish = async (view) => {
	board.view = view;
	board.writes += 1;
};
/** The line as the band shows it now, from what was published; undefined when there is none. */
const lineText = (now = Date.now()) => (board.view === null ? undefined : freshnessText(board.view, now));

/** A fresh load: the module starts over, and so does the published line. */
const fresh = (options: Record<string, unknown> = {}) => {
	board.view = null;
	board.writes = 0;
	registerFreshness((() => undefined) as unknown as On, options as PluginOptions);
};

describe('freshnessView and freshnessText', () => {
	const index = { asOfCommit: OLD, lastIndexedAt: TWO_HOURS_AGO };
	const local = (over: Partial<{ head: string; behind: number | undefined }> = {}) => ({ head: COMMIT, branch: 'main', behind: 4, ...over });

	test('draws nothing when HEAD is the indexed commit', () => {
		expect(freshnessView({ asOfCommit: COMMIT }, local({ behind: 0 }), undefined)).toBeUndefined();
		expect(freshnessView({ asOfCommit: COMMIT.slice(0, 7) }, local({ behind: 0 }), undefined)).toBeUndefined();
	});

	test('draws nothing without an index or a checkout', () => {
		expect(freshnessView(undefined, local(), undefined)).toBeUndefined();
		expect(freshnessView(index, undefined, undefined)).toBeUndefined();
	});

	test('says how many commits the index is behind', () => {
		const view = freshnessView(index, local(), undefined);
		expect(view && freshnessText(view, NOW)).toBe('✦ >_CONSTELLATION://CODE_INTEL · index 4 commits behind · indexed 2h ago');
	});

	test('uses the singular for one commit', () => {
		const view = freshnessView(index, local({ behind: 1 }), undefined);
		expect(view && freshnessText(view, NOW)).toBe('✦ >_CONSTELLATION://CODE_INTEL · index 1 commit behind · indexed 2h ago');
	});

	test('a zero or unknown count is a mismatch with the short commit', () => {
		for (const behind of [0, undefined]) {
			const view = freshnessView(index, local({ behind }), undefined);
			expect(view && freshnessText(view, NOW)).toBe('✦ >_CONSTELLATION://CODE_INTEL · index at fedcba9 · indexed 2h ago');
		}
	});

	test('leaves the age out when absent or unparseable', () => {
		const view = freshnessView({ asOfCommit: OLD, lastIndexedAt: 'soon' }, local(), undefined);
		expect(view && freshnessText(view, NOW)).toBe('✦ >_CONSTELLATION://CODE_INTEL · index 4 commits behind');
		const none = freshnessView({ asOfCommit: OLD }, local(), undefined);
		expect(none && freshnessText(none, NOW)).toBe('✦ >_CONSTELLATION://CODE_INTEL · index 4 commits behind');
	});

	test('ages read just now, minutes, hours and days', () => {
		const text = (iso: string) => {
			const view = freshnessView({ asOfCommit: OLD, lastIndexedAt: iso }, local(), undefined);
			return view && freshnessText(view, NOW);
		};
		expect(text('2026-05-01T11:59:40Z')).toContain('indexed just now');
		expect(text('2026-05-01T11:55:00Z')).toContain('indexed 5m ago');
		expect(text('2026-04-28T12:00:00Z')).toContain('indexed 3d ago');
	});

	test('an error with no index reads code, headline and next step', () => {
		const view = freshnessView(undefined, undefined, { code: 'WEIRD', message: '[WEIRD] The graph melted', guidance: ['Run `constellation index`'] });
		expect(view && freshnessText(view, NOW)).toBe('✦ >_CONSTELLATION://CODE_INTEL · ✗ WEIRD · The graph melted · const index');
	});
});

describe('compareLocal', () => {
	test('reads commit, branch and count with the guarded git, never the working tree', async () => {
		const { run, calls } = fakeRun({ head: onBranch('feat/x'), count: { exitCode: 0, stdout: '4\n' } });
		expect(await compareLocal(run, ROOT, OLD)).toEqual({ head: COMMIT, branch: 'feat/x', behind: 4 });
		expect(calls.map((c) => c.argv.slice(GIT.length))).toEqual([
			['rev-parse', 'HEAD', '--symbolic-full-name', 'HEAD'],
			['rev-list', '--count', `${OLD}..HEAD`, '--'],
		]);
		for (const call of calls) {
			expect(call.argv.slice(0, GIT.length)).toEqual([...GIT]);
			expect(call.argv).toContain('core.fsmonitor=false');
			expect(call.argv).toContain('core.hooksPath=/dev/null');
			expect(call.argv).toContain('protocol.allow=never');
			expect(call.init).toEqual({ cwd: ROOT, env: GIT_ENV, timeoutMs: GIT_TIMEOUT_MS });
		}
	});

	test('a detached HEAD is the branch HEAD', async () => {
		const { run } = fakeRun({ head: { exitCode: 0, stdout: `${COMMIT}\nHEAD\n` }, count: { exitCode: 0, stdout: '1\n' } });
		expect((await compareLocal(run, ROOT, OLD))?.branch).toBe('HEAD');
	});

	test('skips rev-list when HEAD is the indexed commit', async () => {
		const { run, calls } = fakeRun({ head: onBranch('main') });
		expect(await compareLocal(run, ROOT, COMMIT.slice(0, 7))).toMatchObject({ behind: 0 });
		expect(calls.some((c) => c.argv.includes('rev-list'))).toBe(false);
	});

	test('a failed or unparseable count is unknown', async () => {
		for (const count of [{ exitCode: 128, stdout: '' }, { exitCode: 0, stdout: 'many' }]) {
			const { run } = fakeRun({ head: onBranch('main'), count });
			expect((await compareLocal(run, ROOT, OLD))?.behind).toBeUndefined();
		}
	});

	test('fails open when rev-parse fails or any run rejects', async () => {
		expect(await compareLocal(fakeRun({ head: { exitCode: 128, stdout: '' } }).run, ROOT, OLD)).toBeUndefined();
		expect(await compareLocal(fakeRun({ head: onBranch('main'), count: new Error('timeout') }).run, ROOT, OLD)).toBeUndefined();
	});
});

describe('showFreshness', () => {
	test('off, it registers no hook, tracks no project, runs no git and shows no line', async () => {
		const events: string[] = [];
		fresh();
		registerFreshness(((event: string) => void events.push(event)) as unknown as On, { showFreshness: false } as PluginOptions);
		expect(events).toEqual([]);
		expect(showsFreshness()).toBe(false);
		expect(track(ROOT)).toBe(false);
		const git = fakeRun({ head: onBranch('main'), count: { exitCode: 0, stdout: '4\n' } });
		await observeEnvelope({ success: true, asOfCommit: OLD }, ROOT, git.run, publish);
		await recheck(git.run, publish);
		expect(git.calls).toEqual([]);
		expect(board.writes).toBe(0);
	});

	test('unset, it counts as on', () => {
		fresh();
		expect(showsFreshness()).toBe(true);
		expect(track(ROOT)).toBe(true);
	});
});

describe('observeEnvelope and recheck', () => {
	const ok = (asOfCommit?: string, lastIndexedAt: string | undefined = TWO_HOURS_AGO) => ({
		success: true,
		...(asOfCommit === undefined ? {} : { asOfCommit }),
		...(lastIndexedAt === undefined ? {} : { lastIndexedAt }),
	});
	const behindBy4 = () => fakeRun({ head: onBranch('main'), count: { exitCode: 0, stdout: '4\n' } });

	test('a newer commit shows the line and a repeat of it does not redraw', async () => {
		fresh();
		track(ROOT);
		const { run } = behindBy4();
		await observeEnvelope(ok(OLD), ROOT, run, publish);
		expect(lineText()).toMatch(/^✦ >_CONSTELLATION:\/\/CODE_INTEL · index 4 commits behind · indexed /);
		expect(board.writes).toBe(1);
		await observeEnvelope(ok(OLD), ROOT, run, publish);
		expect(board.writes).toBe(1);
		const newer = fakeRun({ head: onBranch('main'), count: { exitCode: 0, stdout: '2\n' } });
		await observeEnvelope(ok(OLD.replace(/^f/, 'e')), ROOT, newer.run, publish);
		expect(lineText()).toMatch(/^✦ >_CONSTELLATION:\/\/CODE_INTEL · index 2 commits behind/);
		expect(board.writes).toBe(2);
	});

	test('ignores an asOfCommit that is not hex and runs no git', async () => {
		fresh();
		track(ROOT);
		const { run, calls } = behindBy4();
		for (const bad of ['--output=x', 'zzz', 'abc', `${OLD}; rm`]) {
			await observeEnvelope(ok(bad), ROOT, run, publish);
		}
		expect(calls).toEqual([]);
		expect(lineText()).toBeUndefined();
	});

	test('ignores an envelope for another root', async () => {
		fresh();
		track(ROOT);
		const { run, calls } = behindBy4();
		await observeEnvelope(ok(OLD), '/elsewhere', run, publish);
		expect(calls).toEqual([]);
	});

	test('AUTH_ERROR and PROJECT_NOT_INDEXED set no failure; another code does until a success', async () => {
		fresh();
		track(ROOT);
		const { run } = behindBy4();
		for (const code of ['AUTH_ERROR', 'PROJECT_NOT_INDEXED', 'NOT_CONFIGURED', 'MCP_UNAVAILABLE']) {
			await observeEnvelope({ success: false, error: { code } }, ROOT, run, publish);
			expect(lineText()).toBeUndefined();
		}
		expect(board.writes).toBe(0);
		await observeEnvelope({ success: false, error: { code: 'WEIRD', message: 'It broke' } }, ROOT, run, publish);
		expect(lineText()).toMatch(/^✦ >_CONSTELLATION:\/\/CODE_INTEL · ✗ WEIRD · It broke/);
		expect(board.writes).toBe(1);
		await observeEnvelope({ success: true }, ROOT, run, publish);
		expect(lineText()).toBeUndefined();
		expect(board.writes).toBe(2);
	});

	test('a failure does not show once an index is known', async () => {
		fresh();
		track(ROOT);
		const { run } = behindBy4();
		await observeEnvelope(ok(OLD), ROOT, run, publish);
		await observeEnvelope({ success: false, error: { code: 'WEIRD' } }, ROOT, run, publish);
		expect(lineText()).toMatch(/behind/);
	});

	test('a run rejection leaves the state unchanged', async () => {
		fresh();
		track(ROOT);
		await observeEnvelope(ok(OLD), ROOT, behindBy4().run, publish);
		const before = lineText();
		await recheck(fakeRun({ head: new Error('boom') }).run, publish);
		expect(lineText()).toBe(before);
		expect(board.writes).toBe(1);
	});

	test('a branch change drops the index', async () => {
		fresh();
		track(ROOT);
		await observeEnvelope(ok(OLD), ROOT, behindBy4().run, publish);
		expect(lineText()).toBeDefined();
		await recheck(fakeRun({ head: onBranch('other'), count: { exitCode: 0, stdout: '4\n' } }).run, publish);
		expect(lineText()).toBeUndefined();
		expect(board.writes).toBe(2);
	});

	test('a superseded recheck does not apply', async () => {
		fresh();
		track(ROOT);
		await observeEnvelope(ok(OLD), ROOT, behindBy4().run, publish);
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const slow = async () => {
			await gate;
			return { exitCode: 0, stdout: `${COMMIT}\nrefs/heads/other\n` };
		};
		const before = board.writes;
		const stale = recheck(slow, publish);
		await recheck(behindBy4().run, publish);
		release();
		await stale;
		expect(lineText()).toMatch(/behind/);
		expect(board.writes).toBe(before);
	});

	test('recheck is a no-op without a root and an index', async () => {
		fresh();
		const { run, calls } = behindBy4();
		await recheck(run, publish);
		track(ROOT);
		await recheck(run, publish);
		expect(calls).toEqual([]);
	});

	test('track reports a root change and clears what was known', async () => {
		fresh();
		expect(track(ROOT)).toBe(true);
		expect(track(ROOT)).toBe(false);
		await observeEnvelope(ok(OLD), ROOT, behindBy4().run, publish);
		expect(track('/other')).toBe(true);
		// Nothing is known of the new root, so a failure there shows: it would not, with an index known.
		await observeEnvelope({ success: false, error: { code: 'WEIRD', message: 'It broke' } }, '/other', behindBy4().run, publish);
		expect(lineText()).toMatch(/✗ WEIRD/);
	});

	test('logs the first line once per conversation', async () => {
		fresh();
		track(ROOT);
		const lines: string[] = [];
		const log = (text: string) => void lines.push(text);
		await observeEnvelope(ok(OLD), ROOT, behindBy4().run, publish, log);
		await observeEnvelope(ok(OLD.replace(/^f/, 'e')), ROOT, fakeRun({ head: onBranch('main'), count: { exitCode: 0, stdout: '2\n' } }).run, publish, log);
		expect(lines).toHaveLength(1);
		resetFreshness();
		await observeEnvelope(ok(OLD), ROOT, behindBy4().run, publish, log);
		expect(lines).toHaveLength(2);
	});

	test('a mismatch is not logged', async () => {
		fresh();
		track(ROOT);
		const lines: string[] = [];
		await observeEnvelope(ok(OLD), ROOT, fakeRun({ head: onBranch('main'), count: { exitCode: 0, stdout: '0\n' } }).run, publish, (t) => void lines.push(t));
		expect(board.view?.kind).toBe('mismatch');
		expect(lines).toEqual([]);
	});
});

describe('freshnessBand', () => {
	const el = {
		Text: (props: Record<string, unknown>) => ({ type: 'Text', props }),
	} as unknown as Parameters<typeof freshnessBand>[0];
	/** The row's children: an element as its props, a bare string as `{ children }`. */
	const pieces = (tint: Parameters<typeof freshnessBand>[2], view: Parameters<typeof freshnessBand>[1]) => {
		const row = freshnessBand(el, view, tint, NOW);
		return (Reflect.get(Reflect.get(row, 'props'), 'children') as unknown[]).map((c) =>
			typeof c === 'string' ? { children: c } : (c as { props: Record<string, unknown> }).props,
		);
	};

	test('opens with the brand mark in nebula blue, the state words plain and the age dim', () => {
		const [mark, head, since] = pieces('brand', { kind: 'behind', behind: 4, lastIndexedAt: TWO_HOURS_AGO });
		expect(mark).toEqual({ color: palette.nebula, children: BRAND });
		expect(head).toEqual({ children: ' · index 4 commits behind' });
		expect(since).toEqual({ dimColor: true, children: ' · indexed 2h ago' });
	});

	test('the theme scheme draws the mark in the theme blue', () => {
		const [mark] = pieces('theme', { kind: 'behind', behind: 4 });
		expect(mark?.['color']).toBe('suggestion');
	});

	test('a mismatch names the indexed commit', () => {
		const [, head] = pieces('brand', { kind: 'mismatch', asOfCommit: OLD });
		expect(head?.['children']).toBe(' · index at fedcba9');
	});

	test('an error draws the code as a red ✗ badge and the next step dim', () => {
		const row = pieces('brand', { kind: 'error', failure: { code: 'WEIRD', message: '[WEIRD] The graph melted', guidance: ['Run `constellation index`'] } });
		const [mark, sep, code, step] = row;
		expect(row).toHaveLength(4);
		expect(mark).toEqual({ color: palette.nebula, children: BRAND });
		expect(sep).toEqual({ children: ' · ' });
		expect(code).toEqual({ children: [{ type: 'Text', props: { color: palette.stellar, children: '✗ WEIRD' } }] });
		expect(step).toEqual({ dimColor: true, children: ' · const index' });
	});

	test('an error with no next step keeps the headline plain', () => {
		const row = pieces('brand', { kind: 'error', failure: { code: 'WEIRD', message: '[WEIRD] The graph melted' } });
		expect(row).toHaveLength(4);
		expect(row[3]).toEqual({ children: ' · The graph melted' });
	});

});

describe('startTicks', () => {
	test('cancels the previous timer, and registerFreshness cancels the stored one', () => {
		const cancelled: number[] = [];
		const timer = (id: number) => ({ cancel: () => void cancelled.push(id) });
		startTicks(() => timer(1));
		startTicks(() => timer(2));
		expect(cancelled).toEqual([1]);
		fresh();
		expect(cancelled).toEqual([1, 2]);
	});
});

describe('resetFreshness', () => {
	test('lets the line log again and keeps what is known', async () => {
		fresh();
		track(ROOT);
		const lines: string[] = [];
		await observeEnvelope({ success: true, asOfCommit: OLD }, ROOT, fakeRun({ head: onBranch('main'), count: { exitCode: 0, stdout: '4\n' } }).run, publish, (t) => void lines.push(t));
		const before = lineText(NOW);
		resetFreshness();
		await recheck(fakeRun({ head: onBranch('main'), count: { exitCode: 0, stdout: '4\n' } }).run, publish);
		expect(lineText(NOW)).toBe(before);
		expect(before).toMatch(/behind/);
		expect(track(ROOT)).toBe(false);
	});
});

type BashAnswer = { deny?: string; isError?: boolean; text?: string };
type BashHandler = ($: object, e: object, next: (e: object) => Promise<BashAnswer>) => Promise<BashAnswer>;

/** The Bash handler `registerFreshness` registers, raised directly with a stand-in `$`. */
function bashHook(key: string | undefined = 'ak:test-key') {
	let handler: BashHandler | undefined;
	let matcher: unknown;
	registerFreshness(((event: string, ...rest: unknown[]) => {
		if (event !== 'tool.call') return;
		matcher = rest[0];
		handler = rest[rest.length - 1] as BashHandler;
	}) as unknown as On, {} as PluginOptions);
	track(ROOT);
	const git = fakeRun({ head: onBranch('main'), count: { exitCode: 0, stdout: '4\n' } });
	const $ = {
		env: { get: async () => key },
		process: { run: git.run },
		state: { get: async () => ({ value: undefined, version: 0 }), set: async () => ({ isSet: true, version: 1 }) },
		ui: { log: () => undefined },
		session: { surfaces: async () => ['terminal'] },
	};
	const bash = async (command: string, answer: BashAnswer = {}) => {
		if (handler === undefined) throw new Error('no Bash hook');
		const r = await handler($, { tool: 'Bash', tool_use_id: 'u', command }, async () => answer);
		for (let i = 0; i < 50; i++) await Promise.resolve();
		return r;
	};
	const revParses = () => git.calls.filter((c) => c.argv.includes('rev-parse')).length;
	return { matcher, bash, git, revParses };
}

describe('the Bash git observer', () => {
	test('matches only the Bash tool', () => {
		expect(bashHook().matcher).toEqual({ tool: /^Bash$/ });
	});

	test('a git command that moves HEAD compares the checkout again', async () => {
		for (const command of ['git pull', 'cd x && git -C . commit -m y', 'git checkout main', 'git merge topic', 'git rebase main']) {
			const hook = bashHook();
			await observeEnvelope({ success: true, asOfCommit: OLD }, ROOT, hook.git.run, publish);
			const before = hook.revParses();
			await hook.bash(command);
			expect(hook.revParses()).toBe(before + 1);
		}
	});

	test('other commands, a denied or errored call, and an unset key compare nothing', async () => {
		const cases: [string | undefined, string, BashAnswer][] = [
			[undefined, 'ls', {}],
			[undefined, 'echo git; commit', {}],
			[undefined, 'git status', {}],
			[undefined, 'git pull', { deny: 'no' }],
			[undefined, 'git pull', { isError: true, text: 'fatal' }],
			['sk:other', 'git pull', {}],
		];
		for (const [key, command, answer] of cases) {
			const hook = bashHook(key);
			await observeEnvelope({ success: true, asOfCommit: OLD }, ROOT, hook.git.run, publish);
			const before = hook.revParses();
			await hook.bash(command, answer);
			expect(hook.revParses()).toBe(before);
		}
	});

	test('the result goes back unchanged', async () => {
		const answer = { text: 'Already up to date.' };
		expect(await bashHook().bash('git pull', answer)).toBe(answer);
	});
});
