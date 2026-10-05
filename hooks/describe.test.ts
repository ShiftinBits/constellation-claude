import { describe, expect, mock, test } from 'claude-code/testing';
import type { On } from 'claude-code';
import { GUIDANCE } from './describe';

const KEY = 'ak:test-key';
const BASE = 'Runs a command.';
const PROVIDER = { plugin: 'engine', tier: 'core' } as const;

/** Answers the tool description, the session's cwd and the files that exist beneath the plugins. */
function project(on: On, cwd: string, files: readonly string[], isDeferred?: boolean): void {
	on('tool.describe', (_, e) => ({ description: e.description, isDeferred }));
	on('session.cwd', () => ({ value: cwd }));
	on('fs.exists', (_, e) => ({ value: files.includes(e.path) }));
}

describe('tool description guidance', () => {
	test('Bash ends with the guidance with an ak: key and a constellation.json above the cwd', async ($, on) => {
		mock.env(on, { CONSTELLATION_ACCESS_KEY: KEY });
		project(on, '/repo/packages/app', ['/repo/constellation.json']);
		const r = await $.tool.describe({ tool: 'Bash', description: BASE, provider: PROVIDER });
		expect(r.description).toBe(BASE + GUIDANCE);
	});

	test('Grep and Glob end with the guidance when the build raises them', async ($, on) => {
		mock.env(on, { CONSTELLATION_ACCESS_KEY: KEY });
		project(on, '/repo', ['/repo/constellation.json']);
		for (const tool of ['Grep', 'Glob']) {
			const r = await $.tool.describe({ tool, description: BASE, provider: PROVIDER });
			expect(r.description).toBe(BASE + GUIDANCE);
		}
	});

	test('the description is unchanged without a key', async ($, on) => {
		mock.env(on, {});
		project(on, '/repo', ['/repo/constellation.json']);
		const r = await $.tool.describe({ tool: 'Bash', description: BASE, provider: PROVIDER });
		expect(r.description).toBe(BASE);
	});

	test('the description is unchanged when the key does not start with ak:', async ($, on) => {
		mock.env(on, { CONSTELLATION_ACCESS_KEY: 'sk:other' });
		project(on, '/repo', ['/repo/constellation.json']);
		const r = await $.tool.describe({ tool: 'Bash', description: BASE, provider: PROVIDER });
		expect(r.description).toBe(BASE);
	});

	test('the description is unchanged without a constellation.json above the cwd', async ($, on) => {
		mock.env(on, { CONSTELLATION_ACCESS_KEY: KEY });
		project(on, '/elsewhere/app', ['/repo/constellation.json']);
		const r = await $.tool.describe({ tool: 'Bash', description: BASE, provider: PROVIDER });
		expect(r.description).toBe(BASE);
	});

	test('two calls return byte-identical text', async ($, on) => {
		mock.env(on, { CONSTELLATION_ACCESS_KEY: KEY });
		project(on, '/repo', ['/repo/constellation.json']);
		const first = await $.tool.describe({ tool: 'Bash', description: BASE, provider: PROVIDER });
		const second = await $.tool.describe({ tool: 'Bash', description: BASE, provider: PROVIDER });
		expect(second.description).toBe(first.description);
	});

	test('the placement chosen beneath stands', async ($, on) => {
		mock.env(on, { CONSTELLATION_ACCESS_KEY: KEY });
		project(on, '/repo', ['/repo/constellation.json'], true);
		const r = await $.tool.describe({ tool: 'Bash', description: BASE, provider: PROVIDER });
		expect(r).toEqual({ description: BASE + GUIDANCE, isDeferred: true });
	});

	test('other tools are left alone', async ($, on) => {
		mock.env(on, { CONSTELLATION_ACCESS_KEY: KEY });
		project(on, '/repo', ['/repo/constellation.json']);
		const r = await $.tool.describe({ tool: 'Read', description: BASE, provider: PROVIDER });
		expect(r.description).toBe(BASE);
	});

	test('the guidance is added once the gate opens and then kept, so the prompt cache stays valid', async ($, on) => {
		mock.env(on, { CONSTELLATION_ACCESS_KEY: KEY });
		let cwd = '/elsewhere';
		on('session.cwd', () => ({ value: cwd }));
		on('fs.exists', (_, e) => ({ value: e.path === '/repo/constellation.json' }));
		on('tool.describe', (_, e) => ({ description: e.description }));
		on('classic.CwdChanged', () => ({}));
		const invalidated: string[] = [];
		on('ui.invalidate', (_, e) => {
			invalidated.push(e.event);
			return { value: undefined };
		});

		expect((await $.tool.describe({ tool: 'Bash', description: BASE, provider: PROVIDER })).description).toBe(BASE);
		await $.classic.CwdChanged({ old_cwd: '/elsewhere', new_cwd: '/tmp' });
		expect(invalidated).toEqual([]);

		cwd = '/repo/app';
		await $.classic.CwdChanged({ old_cwd: '/tmp', new_cwd: '/repo/app' });
		expect(invalidated).toEqual(['tool.describe']);
		expect((await $.tool.describe({ tool: 'Bash', description: BASE, provider: PROVIDER })).description).toBe(BASE + GUIDANCE);

		cwd = '/elsewhere';
		await $.classic.CwdChanged({ old_cwd: '/repo/app', new_cwd: '/elsewhere' });
		await $.classic.CwdChanged({ old_cwd: '/elsewhere', new_cwd: '/repo/app' });
		expect(invalidated).toEqual(['tool.describe']);
		expect((await $.tool.describe({ tool: 'Bash', description: BASE, provider: PROVIDER })).description).toBe(BASE + GUIDANCE);
	});
});

describe('the freshness indicator follows the working directory', () => {
	const SERVER = 'plugin:constellation:constellation';
	const INDEXED = 'fedcba9876543210fedcba9876543210fedcba98';

	/**
	 * Two projects, /repo and /other, on the default API, with HEAD two commits
	 * past the index: records the pings, the git runs and, in `timeline`, the
	 * pings and band redraws in the order they happened.
	 */
	function projects(on: On, signedIn = true) {
		mock.env(on, signedIn ? { CONSTELLATION_ACCESS_KEY: KEY } : {});
		const clock = mock.clock(on);
		const pings: string[] = [];
		const runs: string[] = [];
		const timeline: string[] = [];
		on('session.cwd', () => ({ value: '/repo' }));
		on('session.surfaces', () => ({ value: ['terminal'] }));
		on('fs.exists', (_, e) => ({ value: e.path === '/repo/constellation.json' || e.path === '/other/constellation.json' }));
		on('fs.read', () => ({ value: JSON.stringify({ projectId: 'p' }) }));
		on('mcp.connect', () => ({ value: { isConnected: true, server: SERVER } }));
		on('mcp.call', (_, e) => {
			pings.push(String(e.args?.['cwd']));
			timeline.push(`ping ${String(e.args?.['cwd'])}`);
			return { value: { content: [{ type: 'text', text: JSON.stringify({ success: true, result: {}, asOfCommit: INDEXED }) }], isError: false } };
		});
		on('process.run', (_, e) => {
			runs.push(e.argv.join(' '));
			const stdout = e.argv.includes('rev-parse') ? '0123456789abcdef0123456789abcdef01234567\nrefs/heads/main\n' : e.argv.includes('rev-list') ? '2\n' : '';
			return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } };
		});
		on('classic.CwdChanged', () => ({}));
		on('tool.describe', (_, e) => ({ description: e.description }));
		on('ui.invalidate', (_, e) => {
			if (e.event === 'ui.render') timeline.push('redraw');
			return { value: undefined };
		});
		const revParses = () => runs.filter((r) => r.includes('rev-parse')).length;
		const redraws = () => timeline.filter((t) => t === 'redraw').length;
		return { clock, pings, revParses, timeline, redraws };
	}

	test('a move into a project pings it once and compares the checkout', async ($, on) => {
		const { clock, pings, revParses } = projects(on);
		await $.classic.CwdChanged({ old_cwd: '/tmp', new_cwd: '/repo/app' });
		await clock.settle();
		expect(pings).toEqual(['/repo']);
		expect(revParses() > 0).toBe(true);
	});

	test('a move within the project compares again, with the gate already open, pings nothing and redraws nothing for the same line', async ($, on) => {
		const { clock, pings, revParses, redraws } = projects(on);
		expect((await $.tool.describe({ tool: 'Bash', description: BASE, provider: PROVIDER })).description).toBe(BASE + GUIDANCE);
		await $.classic.CwdChanged({ old_cwd: '/tmp', new_cwd: '/repo/app' });
		await clock.settle();
		const before = revParses();
		const drawn = redraws();
		expect(drawn > 0).toBe(true);
		await $.classic.CwdChanged({ old_cwd: '/repo/app', new_cwd: '/repo/lib' });
		await clock.settle();
		expect(pings).toEqual(['/repo']);
		expect(revParses()).toBe(before + 1);
		expect(redraws()).toBe(drawn);
	});

	test('a move into another project takes the last line down before it pings that one', async ($, on) => {
		const { clock, pings, timeline } = projects(on);
		await $.classic.CwdChanged({ old_cwd: '/tmp', new_cwd: '/repo/app' });
		await clock.settle();
		expect(timeline).toEqual(['ping /repo', 'redraw']);
		await $.classic.CwdChanged({ old_cwd: '/repo/app', new_cwd: '/other/src' });
		await clock.settle();
		expect(pings).toEqual(['/repo', '/other']);
		expect(timeline.slice(2, 4)).toEqual(['redraw', 'ping /other']);
	});

	test('without a key nothing is pinged or compared', async ($, on) => {
		const { clock, pings, revParses } = projects(on, false);
		await $.classic.CwdChanged({ old_cwd: '/tmp', new_cwd: '/repo/app' });
		await clock.settle();
		expect(pings).toEqual([]);
		expect(revParses()).toBe(0);
	});

	test('outside a project nothing is pinged or compared', async ($, on) => {
		const { clock, pings, revParses } = projects(on);
		await $.classic.CwdChanged({ old_cwd: '/repo', new_cwd: '/elsewhere' });
		await clock.settle();
		expect(pings).toEqual([]);
		expect(revParses()).toBe(0);
	});
});
