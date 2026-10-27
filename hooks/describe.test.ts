import { describe, expect, mock, test } from 'claude-code/testing';
import type { Engine } from 'claude-code/testing';
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

	test('the guidance is added at the first main-loop turn after a cd into a project, and then kept, so the prompt cache stays valid', async ($, on) => {
		mock.env(on, { CONSTELLATION_ACCESS_KEY: KEY });
		let cwd = '/elsewhere';
		on('session.cwd', () => ({ value: cwd }));
		on('fs.exists', (_, e) => ({ value: e.path === '/repo/constellation.json' }));
		on('tool.describe', (_, e) => ({ description: e.description }));
		on('turn.start', (_, e) => ({ turnId: e.turnId }));
		const invalidated: string[] = [];
		on('ui.invalidate', (_, e) => {
			invalidated.push(e.event);
			return { value: undefined };
		});
		let turns = 0;
		const turn = () => $.turn.start({ text: '', turnId: `t${(turns += 1)}` });

		expect((await $.tool.describe({ tool: 'Bash', description: BASE, provider: PROVIDER })).description).toBe(BASE);
		await turn();
		cwd = '/tmp';
		await turn();
		expect(invalidated).toEqual([]);

		cwd = '/repo/app';
		await turn();
		expect(invalidated).toEqual(['tool.describe']);
		expect((await $.tool.describe({ tool: 'Bash', description: BASE, provider: PROVIDER })).description).toBe(BASE + GUIDANCE);

		cwd = '/elsewhere';
		await turn();
		cwd = '/repo/app';
		await turn();
		expect(invalidated).toEqual(['tool.describe']);
		expect((await $.tool.describe({ tool: 'Bash', description: BASE, provider: PROVIDER })).description).toBe(BASE + GUIDANCE);
	});

	test('a lookup that fails at the turn after a cd is tried again at the next main-loop turn', async ($, on) => {
		mock.env(on, { CONSTELLATION_ACCESS_KEY: KEY });
		let cwd = '/elsewhere';
		let failing = false;
		on('session.cwd', () => ({ value: cwd }));
		on('fs.exists', (_, e) => {
			if (failing) throw new Error('busy');
			return { value: e.path === '/repo/constellation.json' };
		});
		on('tool.describe', (_, e) => ({ description: e.description }));
		on('turn.start', (_, e) => ({ turnId: e.turnId }));
		const invalidated: string[] = [];
		on('ui.invalidate', (_, e) => {
			invalidated.push(e.event);
			return { value: undefined };
		});

		await $.tool.describe({ tool: 'Bash', description: BASE, provider: PROVIDER });
		await $.turn.start({ text: '', turnId: 't1' });
		cwd = '/repo/app';
		failing = true;
		await $.turn.start({ text: '', turnId: 't2' });
		expect(invalidated).toEqual([]);

		failing = false;
		await $.turn.start({ text: '', turnId: 't3' });
		expect(invalidated).toEqual(['tool.describe']);
	});

	test('a cd into a project before the first main-loop turn opens the gate at that turn', async ($, on) => {
		mock.env(on, { CONSTELLATION_ACCESS_KEY: KEY });
		let cwd = '/elsewhere';
		on('session.cwd', () => ({ value: cwd }));
		on('fs.exists', (_, e) => ({ value: e.path === '/repo/constellation.json' }));
		on('tool.describe', (_, e) => ({ description: e.description }));
		on('turn.start', (_, e) => ({ turnId: e.turnId }));
		const invalidated: string[] = [];
		on('ui.invalidate', (_, e) => {
			invalidated.push(e.event);
			return { value: undefined };
		});

		expect((await $.tool.describe({ tool: 'Bash', description: BASE, provider: PROVIDER })).description).toBe(BASE);
		cwd = '/repo/app';
		await $.turn.start({ text: '', turnId: 't1' });
		expect(invalidated).toEqual(['tool.describe']);
	});
});

describe('the freshness indicator follows the working directory', () => {
	const SERVER = 'plugin:constellation:constellation';
	const INDEXED = 'fedcba9876543210fedcba9876543210fedcba98';

	/**
	 * Two projects, /repo and /other, on the default API, with HEAD two commits
	 * past the index: records the pings, the git runs, the describe rebuilds
	 * and, in `timeline`, the pings and the freshness line's writes to `$.state`
	 * (each one redraws the band) in the order they happened. `at(dir)` starts a main-loop turn with the working directory at
	 * `dir`; `subagentAt(dir)` starts a subagent's.
	 */
	function projects($: Engine, on: On, signedIn = true) {
		mock.env(on, signedIn ? { CONSTELLATION_ACCESS_KEY: KEY } : {});
		const clock = mock.clock(on);
		let cwd = '/tmp';
		let turns = 0;
		const pings: string[] = [];
		const runs: string[] = [];
		const timeline: string[] = [];
		const described: string[] = [];
		on('session.cwd', () => ({ value: cwd }));
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
		on('turn.start', (_, e) => ({ turnId: e.turnId }));
		on('tool.describe', (_, e) => ({ description: e.description }));
		on('ui.invalidate', (_, e) => {
			if (e.event === 'tool.describe') described.push(cwd);
			return { value: undefined };
		});
		on('state.set', (_, e, next) => {
			if (e.plugin === 'constellation' && e.key === 'freshness') timeline.push('redraw');
			return next(e);
		});
		const at = async (dir: string, agentId?: string) => {
			cwd = dir;
			await $.turn.start({ text: '', turnId: `t${(turns += 1)}`, agentId });
			await clock.settle();
		};
		const revParses = () => runs.filter((r) => r.includes('rev-parse')).length;
		const redraws = () => timeline.filter((t) => t === 'redraw').length;
		return { at, subagentAt: (dir: string) => at(dir, 'agent-1'), pings, revParses, timeline, redraws, described };
	}

	test('the first main-loop turn seeds the working directory without a ping', async ($, on) => {
		const { at, pings, revParses } = projects($, on);
		await at('/repo/app');
		expect(pings).toEqual([]);
		expect(revParses()).toBe(0);
	});

	test('a cd into a project between two main-loop turns pings it once and compares the checkout', async ($, on) => {
		const { at, pings, revParses } = projects($, on);
		await at('/tmp');
		await at('/repo/app');
		expect(pings).toEqual(['/repo']);
		expect(revParses() > 0).toBe(true);
	});

	test('a turn in the same working directory pings nothing and compares nothing', async ($, on) => {
		const { at, pings, revParses } = projects($, on);
		await at('/tmp');
		await at('/repo/app');
		const before = revParses();
		await at('/repo/app');
		expect(pings).toEqual(['/repo']);
		expect(revParses()).toBe(before);
	});

	test('with the gate closed, the first main-loop turn after a cd into a project re-describes the search tools', async ($, on) => {
		const { at, described } = projects($, on);
		await at('/tmp');
		expect((await $.tool.describe({ tool: 'Bash', description: BASE, provider: PROVIDER })).description).toBe(BASE);
		await at('/repo/app');
		expect(described).toEqual(['/repo/app']);
	});

	test('a subagent turn neither pings nor re-describes, and leaves the main loop its working directory', async ($, on) => {
		const { at, subagentAt, pings, revParses, described } = projects($, on);
		await at('/tmp');
		expect((await $.tool.describe({ tool: 'Bash', description: BASE, provider: PROVIDER })).description).toBe(BASE);
		await subagentAt('/repo/app');
		expect(pings).toEqual([]);
		expect(revParses()).toBe(0);
		expect(described).toEqual([]);
		// The main loop's last directory is still /tmp, so its next turn in /repo/app is the move.
		await at('/repo/app');
		expect(pings).toEqual(['/repo']);
		expect(described).toEqual(['/repo/app']);
	});

	test('a move within the project compares again, with the gate already open, pings nothing and redraws nothing for the same line', async ($, on) => {
		const { at, pings, revParses, redraws } = projects($, on);
		expect((await $.tool.describe({ tool: 'Bash', description: BASE, provider: PROVIDER })).description).toBe(BASE);
		await at('/tmp');
		await at('/repo/app');
		const before = revParses();
		const drawn = redraws();
		expect(drawn > 0).toBe(true);
		await at('/repo/lib');
		expect(pings).toEqual(['/repo']);
		expect(revParses()).toBe(before + 1);
		expect(redraws()).toBe(drawn);
	});

	test('a move into another project takes the last line down before it pings that one', async ($, on) => {
		const { at, pings, timeline } = projects($, on);
		await at('/tmp');
		await at('/repo/app');
		expect(timeline).toEqual(['ping /repo', 'redraw']);
		await at('/other/src');
		expect(pings).toEqual(['/repo', '/other']);
		expect(timeline.slice(2, 4)).toEqual(['redraw', 'ping /other']);
	});

	test('without a key nothing is pinged or compared', async ($, on) => {
		const { at, pings, revParses } = projects($, on, false);
		await at('/tmp');
		await at('/repo/app');
		expect(pings).toEqual([]);
		expect(revParses()).toBe(0);
	});

	test('outside a project nothing is pinged or compared', async ($, on) => {
		const { at, pings, revParses } = projects($, on);
		await at('/repo');
		await at('/elsewhere');
		expect(pings).toEqual([]);
		expect(revParses()).toBe(0);
	});
});
