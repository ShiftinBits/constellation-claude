import type { On, PluginOptions } from 'claude-code';
import { describe, expect, test } from 'claude-code/testing';
import { compareLocal, freshnessLine, freshnessText, freshnessView, observeEnvelope, recheck, registerFreshness, resetFreshness, startTicks, track } from './freshness';
import { GIT, GIT_ENV, GIT_TIMEOUT_MS } from './lib';

const ROOT = '/work/app';
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const OLD = 'fedcba9876543210fedcba9876543210fedcba98';
const NOW = Date.parse('2026-05-01T12:00:00Z');
const TWO_HOURS_AGO = '2026-05-01T10:00:00Z';

type Answer = { exitCode: number; stdout: string } | Error;
type Call = { argv: readonly string[]; init: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } };

/** A `run` that records argv and answers per git subcommand. */
function fakeRun(answers: { head?: Answer; count?: Answer; status?: Answer }) {
	const calls: Call[] = [];
	const run = async (argv: readonly string[], init: Call['init']) => {
		calls.push({ argv, init });
		const sub = argv[GIT.length];
		const answer = (sub === 'rev-parse' ? answers.head : sub === 'rev-list' ? answers.count : answers.status) ?? { exitCode: 0, stdout: '' };
		if (answer instanceof Error) throw answer;
		return answer;
	};
	return { run, calls };
}

const onBranch = (name: string, sha = COMMIT): Answer => ({ exitCode: 0, stdout: `${sha}\nrefs/heads/${name}\n` });
const options = (colors?: unknown) => ({ colors }) as unknown as PluginOptions;
const fresh = () => registerFreshness((() => undefined) as unknown as On, options());

describe('freshnessView and freshnessText', () => {
	const index = { asOfCommit: OLD, lastIndexedAt: TWO_HOURS_AGO };
	const local = (over: Partial<{ head: string; behind: number | undefined; dirty: boolean }> = {}) => ({ head: COMMIT, branch: 'main', behind: 4, dirty: false, ...over });

	test('draws nothing when HEAD is the indexed commit, clean or dirty', () => {
		expect(freshnessView({ asOfCommit: COMMIT }, local({ behind: 0 }), undefined)).toBeUndefined();
		expect(freshnessView({ asOfCommit: COMMIT.slice(0, 7) }, local({ behind: 0, dirty: true }), undefined)).toBeUndefined();
	});

	test('draws nothing without an index or a checkout', () => {
		expect(freshnessView(undefined, local(), undefined)).toBeUndefined();
		expect(freshnessView(index, undefined, undefined)).toBeUndefined();
	});

	test('says how many commits the index is behind', () => {
		const view = freshnessView(index, local(), undefined);
		expect(view && freshnessText(view, NOW)).toBe('✦ index 4 commits behind · indexed 2h ago');
	});

	test('uses the singular for one commit', () => {
		const view = freshnessView(index, local({ behind: 1 }), undefined);
		expect(view && freshnessText(view, NOW)).toBe('✦ index 1 commit behind · indexed 2h ago');
	});

	test('appends local changes when dirty', () => {
		const view = freshnessView(index, local({ dirty: true }), undefined);
		expect(view && freshnessText(view, NOW)).toBe('✦ index 4 commits behind · indexed 2h ago + local changes');
	});

	test('a zero or unknown count is a mismatch with the short commit', () => {
		for (const behind of [0, undefined]) {
			const view = freshnessView(index, local({ behind }), undefined);
			expect(view && freshnessText(view, NOW)).toBe('✦ index at fedcba9 · indexed 2h ago');
		}
	});

	test('leaves the age out when absent or unparseable', () => {
		const view = freshnessView({ asOfCommit: OLD, lastIndexedAt: 'soon' }, local(), undefined);
		expect(view && freshnessText(view, NOW)).toBe('✦ index 4 commits behind');
		const none = freshnessView({ asOfCommit: OLD }, local(), undefined);
		expect(none && freshnessText(none, NOW)).toBe('✦ index 4 commits behind');
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
		expect(view && freshnessText(view, NOW)).toBe('✦ WEIRD · The graph melted · constellation index');
	});
});

describe('compareLocal', () => {
	test('reads commit, branch, count and dirtiness with the guarded git', async () => {
		const { run, calls } = fakeRun({ head: onBranch('feat/x'), count: { exitCode: 0, stdout: '4\n' }, status: { exitCode: 0, stdout: ' M a.ts\n' } });
		expect(await compareLocal(run, ROOT, OLD)).toEqual({ head: COMMIT, branch: 'feat/x', behind: 4, dirty: true });
		expect(calls.map((c) => c.argv.slice(GIT.length))).toEqual([
			['rev-parse', 'HEAD', '--symbolic-full-name', 'HEAD'],
			['rev-list', '--count', `${OLD}..HEAD`, '--'],
			['status', '--porcelain'],
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
		expect(await compareLocal(run, ROOT, COMMIT.slice(0, 7))).toMatchObject({ behind: 0, dirty: false });
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
		expect(await compareLocal(fakeRun({ head: onBranch('main'), status: new Error('timeout') }).run, ROOT, OLD)).toBeUndefined();
	});
});

describe('observeEnvelope and recheck', () => {
	const ok = (asOfCommit?: string, lastIndexedAt: string | undefined = TWO_HOURS_AGO) => ({
		success: true,
		...(asOfCommit === undefined ? {} : { asOfCommit }),
		...(lastIndexedAt === undefined ? {} : { lastIndexedAt }),
	});
	const behindBy4 = () => fakeRun({ head: onBranch('main'), count: { exitCode: 0, stdout: '4\n' } });
	const lineText = () => freshnessLine(Date.now())?.text;

	test('a newer commit shows the line and a repeat of it does not redraw', async () => {
		fresh();
		track(ROOT);
		let draws = 0;
		const invalidate = () => void (draws += 1);
		const { run } = behindBy4();
		await observeEnvelope(ok(OLD), ROOT, run, invalidate);
		expect(lineText()).toMatch(/^✦ index 4 commits behind · indexed /);
		expect(draws).toBe(1);
		await observeEnvelope(ok(OLD), ROOT, run, invalidate);
		expect(draws).toBe(1);
		const newer = fakeRun({ head: onBranch('main'), count: { exitCode: 0, stdout: '2\n' } });
		await observeEnvelope(ok(OLD.replace(/^f/, 'e')), ROOT, newer.run, invalidate);
		expect(lineText()).toMatch(/^✦ index 2 commits behind/);
		expect(draws).toBe(2);
	});

	test('ignores an asOfCommit that is not hex and runs no git', async () => {
		fresh();
		track(ROOT);
		const { run, calls } = behindBy4();
		for (const bad of ['--output=x', 'zzz', 'abc', `${OLD}; rm`]) {
			await observeEnvelope(ok(bad), ROOT, run, () => undefined);
		}
		expect(calls).toEqual([]);
		expect(lineText()).toBeUndefined();
	});

	test('ignores an envelope for another root', async () => {
		fresh();
		track(ROOT);
		const { run, calls } = behindBy4();
		await observeEnvelope(ok(OLD), '/elsewhere', run, () => undefined);
		expect(calls).toEqual([]);
	});

	test('AUTH_ERROR and PROJECT_NOT_INDEXED set no failure; another code does until a success', async () => {
		fresh();
		track(ROOT);
		const { run } = behindBy4();
		for (const code of ['AUTH_ERROR', 'PROJECT_NOT_INDEXED', 'NOT_CONFIGURED', 'MCP_UNAVAILABLE']) {
			await observeEnvelope({ success: false, error: { code } }, ROOT, run, () => undefined);
			expect(lineText()).toBeUndefined();
		}
		let draws = 0;
		await observeEnvelope({ success: false, error: { code: 'WEIRD', message: 'It broke' } }, ROOT, run, () => void (draws += 1));
		expect(lineText()).toMatch(/^✦ WEIRD · It broke/);
		expect(draws).toBe(1);
		await observeEnvelope({ success: true }, ROOT, run, () => void (draws += 1));
		expect(lineText()).toBeUndefined();
		expect(draws).toBe(2);
	});

	test('a failure does not show once an index is known', async () => {
		fresh();
		track(ROOT);
		const { run } = behindBy4();
		await observeEnvelope(ok(OLD), ROOT, run, () => undefined);
		await observeEnvelope({ success: false, error: { code: 'WEIRD' } }, ROOT, run, () => undefined);
		expect(lineText()).toMatch(/behind/);
	});

	test('a run rejection leaves the state unchanged', async () => {
		fresh();
		track(ROOT);
		let draws = 0;
		await observeEnvelope(ok(OLD), ROOT, behindBy4().run, () => void (draws += 1));
		const before = lineText();
		await recheck(fakeRun({ head: new Error('boom') }).run, () => void (draws += 1));
		expect(lineText()).toBe(before);
		expect(draws).toBe(1);
	});

	test('a branch change drops the index', async () => {
		fresh();
		track(ROOT);
		await observeEnvelope(ok(OLD), ROOT, behindBy4().run, () => undefined);
		expect(lineText()).toBeDefined();
		let draws = 0;
		await recheck(fakeRun({ head: onBranch('other'), count: { exitCode: 0, stdout: '4\n' } }).run, () => void (draws += 1));
		expect(lineText()).toBeUndefined();
		expect(draws).toBe(1);
	});

	test('a superseded recheck does not apply', async () => {
		fresh();
		track(ROOT);
		await observeEnvelope(ok(OLD), ROOT, behindBy4().run, () => undefined);
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const slow = async () => {
			await gate;
			return { exitCode: 0, stdout: `${COMMIT}\nrefs/heads/other\n` };
		};
		let draws = 0;
		const stale = recheck(slow, () => void (draws += 1));
		await recheck(behindBy4().run, () => void (draws += 1));
		release();
		await stale;
		expect(lineText()).toMatch(/behind/);
		expect(draws).toBe(0);
	});

	test('recheck is a no-op without a root and an index', async () => {
		fresh();
		const { run, calls } = behindBy4();
		await recheck(run, () => undefined);
		track(ROOT);
		await recheck(run, () => undefined);
		expect(calls).toEqual([]);
	});

	test('track reports a root change and clears what was known', async () => {
		fresh();
		expect(track(ROOT)).toBe(true);
		expect(track(ROOT)).toBe(false);
		await observeEnvelope(ok(OLD), ROOT, behindBy4().run, () => undefined);
		expect(track('/other')).toBe(true);
		expect(lineText()).toBeUndefined();
	});

	test('logs the first line once per conversation', async () => {
		fresh();
		track(ROOT);
		const lines: string[] = [];
		const log = (text: string) => void lines.push(text);
		await observeEnvelope(ok(OLD), ROOT, behindBy4().run, () => undefined, log);
		await observeEnvelope(ok(OLD.replace(/^f/, 'e')), ROOT, fakeRun({ head: onBranch('main'), count: { exitCode: 0, stdout: '2\n' } }).run, () => undefined, log);
		expect(lines).toHaveLength(1);
		resetFreshness();
		await observeEnvelope(ok(OLD), ROOT, behindBy4().run, () => undefined, log);
		expect(lines).toHaveLength(2);
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
