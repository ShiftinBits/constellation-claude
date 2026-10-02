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
