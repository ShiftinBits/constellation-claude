import { describe, expect, test } from 'claude-code/testing';
import { blastRadius, isTestFile, probe } from './blast';
import type { McpPort } from './lib';

describe('isTestFile', () => {
	const tests = [
		'src/a.test.ts',
		'src/a.spec.js',
		'src/__tests__/a.ts',
		'test/a.ts',
		'pkg/tests/a.py',
		'pkg/a_test.go',
		'pkg/test_a.py',
		'pkg/a_test.py',
		'src/Tests/a.cs',
		'MyApp.Tests/OrderService.cs',
		'src/OrderServiceTests.cs',
		'src/main/java/OrderServiceTest.java',
	];
	const others = ['src/a.ts', 'src/latest/a.ts', 'src/contest.ts', 'pkg/mytest_a.py', 'src/attest/a.ts', 'src/Contest.cs', 'src/Latest.java'];
	for (const p of tests) {
		test(`${p} is a test`, () => {
			expect(isTestFile(p)).toBe(true);
		});
	}
	for (const p of others) {
		test(`${p} is not a test`, () => {
			expect(isTestFile(p)).toBe(false);
		});
	}
});

type Api = Parameters<typeof probe>[0];

/** A stub api: dependents per file (each importing `symbols`), or an error to throw. */
function stub(deps: Record<string, Array<{ filePath: string; usedSymbols?: string[] }> | Error>) {
	const asked: Array<{ filePath: string; limit: number; includeSymbols: boolean }> = [];
	const api: Api = {
		getDependents: async (p) => {
			asked.push(p);
			const d = deps[p.filePath] ?? [];
			if (d instanceof Error) throw d;
			return { directDependents: d };
		},
	};
	return { api, asked };
}

const notFound = (path: string) =>
	new Error(`API call failed: api.getDependents()\n  Parameters: {}\n  Duration: 5ms\n  Error: File not found: ${path}`);

describe('probe', () => {
	test('returns every dependent with the symbols it imports, one getDependents per file', async () => {
		const { api, asked } = stub({ 'a.ts': [{ filePath: 'z.ts', usedSymbols: ['A'] }], 'b.ts': [{ filePath: 'z.ts' }] });
		expect(await probe(api, ['a.ts', 'b.ts'], true, 100)).toEqual({
			dependents: [
				{ filePath: 'z.ts', symbols: ['A'] },
				{ filePath: 'z.ts', symbols: [] },
			],
			atLimit: false,
		});
		expect(asked).toEqual([
			{ filePath: 'a.ts', limit: 100, includeSymbols: true },
			{ filePath: 'b.ts', limit: 100, includeSymbols: true },
		]);
	});
	test('a file the graph does not know has no dependents', async () => {
		const { api } = stub({ 'new.ts': notFound('new.ts'), 'b.ts': [{ filePath: 'y.ts' }] });
		expect((await probe(api, ['new.ts', 'b.ts'], false, 100)).dependents).toEqual([{ filePath: 'y.ts', symbols: [] }]);
	});
	test('any other failure fails the lookup instead of reading as zero', async () => {
		const { api } = stub({ 'a.ts': new Error('API call limit exceeded: maximum 50 api.* calls per execution') });
		await expect(probe(api, ['a.ts'], false, 100)).rejects.toThrow('API call limit');
	});
	test('a full page marks the count as a floor', async () => {
		const { api } = stub({ 'a.ts': [{ filePath: 'x.ts' }, { filePath: 'y.ts' }] });
		expect((await probe(api, ['a.ts'], false, 2)).atLimit).toBe(true);
	});
});

function port(reply: { text?: string; isError?: boolean } | Error, programs: string[] = []): McpPort {
	return {
		connect: async () => ({ isConnected: true, server: 'plugin:constellation:constellation' }),
		call: async (_s, _t, args) => {
			programs.push(String(args?.code));
			if (reply instanceof Error) throw reply;
			return { content: [{ type: 'text', text: reply.text ?? '' }], isError: reply.isError ?? false };
		},
	};
}

const ok = (result: unknown, asOfCommit?: string) => ({ text: JSON.stringify({ success: true, result, asOfCommit }) });

const edge = (filePath: string, symbols: string[] = []) => ({ filePath, symbols });

describe('blastRadius', () => {
	test('ranks dependents by how many inspected files they import, counts tests and trims the commit', async () => {
		const blast = await blastRadius(
			port(ok({ dependents: [edge('b.ts', ['f']), edge('a.test.ts'), edge('z.ts', ['g']), edge('z.ts', ['f'])], atLimit: false }, 'abcdef1234567')),
			'/r',
			['x.ts', 'y.ts'],
			{ exports: true },
		);
		expect(blast).toEqual({ dependents: ['z.ts', 'a.test.ts', 'b.ts'], tests: 1, exports: ['f', 'g'], asOfCommit: 'abcdef1' });
	});
	test('omits asOfCommit when absent', async () => {
		const blast = await blastRadius(port(ok({ dependents: [], atLimit: false })), '/r', ['x.ts'], { exports: false });
		expect(blast).toEqual({ dependents: [], tests: 0, exports: [] });
	});
	test('a full page marks the result as a floor', async () => {
		const blast = await blastRadius(port(ok({ dependents: [edge('a.ts')], atLimit: true })), '/r', ['x.ts'], { exports: false });
		expect(blast?.atLimit).toBe(true);
	});
	test('failure gives undefined', async () => {
		const failed = { text: JSON.stringify({ success: false, error: { code: 'X' } }) };
		expect(await blastRadius(port(failed), '/r', ['x.ts'], { exports: false })).toBeUndefined();
		expect(await blastRadius(port(new Error('down')), '/r', ['x.ts'], { exports: false })).toBeUndefined();
	});
	test('malformed result gives undefined', async () => {
		for (const result of [null, 'x', { dependents: 'a' }, { dependents: [1] }, { dependents: [{ filePath: 'a' }] }, { dependents: [{ filePath: 1, symbols: [] }] }]) {
			expect(await blastRadius(port(ok(result)), '/r', ['x.ts'], { exports: false })).toBeUndefined();
		}
	});
	test('caps files at 50 and embeds arguments', async () => {
		const programs: string[] = [];
		const files = Array.from({ length: 80 }, (_, i) => `f${i}.ts`);
		await blastRadius(port(ok({ dependents: [], atLimit: false }), programs), '/r', files, { exports: true });
		expect(programs[0]).toContain(JSON.stringify(files.slice(0, 50)));
		expect(programs[0]).not.toContain('"f50.ts"');
		expect(programs[0]).toMatch(/, true, 100\);$/);
	});
	test('a changed file past the cap is not a dependent, and the skipped count is reported', async () => {
		const files = Array.from({ length: 51 }, (_, i) => `f${i}.ts`);
		const blast = await blastRadius(port(ok({ dependents: [edge('f50.ts'), edge('x.test.ts')], atLimit: false })), '/r', files, { exports: false });
		expect(blast).toEqual({ dependents: ['x.test.ts'], tests: 1, exports: [], skipped: 1 });
	});
});
