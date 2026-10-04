import { describe, expect, test } from 'claude-code/testing';
import { blastRadius, isTestFile, probe, relativeTo } from './blast';
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
	];
	const others = ['src/a.ts', 'src/latest/a.ts', 'src/contest.ts', 'pkg/a_test.py', 'pkg/mytest_a.py', 'src/attest/a.ts'];
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

function stub(deps: Record<string, string[] | Error>, syms: Record<string, Array<{ name: string; filePath: string }> | Error> = {}) {
	const searched: string[] = [];
	const api: Api = {
		getDependents: async ({ filePath }) => {
			const d = deps[filePath] ?? [];
			if (d instanceof Error) throw d;
			return { directDependents: d.map((f) => ({ filePath: f })) };
		},
		searchSymbols: async ({ filterByFile }) => {
			searched.push(filterByFile);
			const s = syms[filterByFile] ?? [];
			if (s instanceof Error) throw s;
			return { symbols: s };
		},
	};
	return { api, searched };
}

describe('probe', () => {
	test('unions dependents minus inputs, deduped and sorted', async () => {
		const { api } = stub({ 'a.ts': ['z.ts', 'b.ts', 'x.ts'], 'b.ts': ['z.ts', 'a.ts'] });
		expect(await probe(api, ['a.ts', 'b.ts'], false)).toEqual({ dependents: ['x.ts', 'z.ts'], exports: [] });
	});
	test('a throwing getDependents loses only that file', async () => {
		const { api } = stub({ 'a.ts': new Error('not indexed'), 'b.ts': ['y.ts'] });
		expect((await probe(api, ['a.ts', 'b.ts'], false)).dependents).toEqual(['y.ts']);
	});
	test('a throwing searchSymbols keeps dependents', async () => {
		const { api } = stub({ 'a.ts': ['y.ts'] }, { 'a.ts': new Error('boom') });
		expect(await probe(api, ['a.ts'], true)).toEqual({ dependents: ['y.ts'], exports: [] });
	});
	test('exports are filtered to the exact file and deduped', async () => {
		const { api } = stub(
			{},
			{
				'a.ts': [
					{ name: 'one', filePath: 'a.ts' },
					{ name: 'two', filePath: 'xa.ts' },
					{ name: 'one', filePath: 'a.ts' },
				],
			},
		);
		expect((await probe(api, ['a.ts'], true)).exports).toEqual(['one']);
	});
	test('withExports false never searches', async () => {
		const { api, searched } = stub({ 'a.ts': ['y.ts'] });
		await probe(api, ['a.ts'], false);
		expect(searched).toEqual([]);
	});
	test('a glob character skips searchSymbols', async () => {
		const { api, searched } = stub({});
		await probe(api, ['a*.ts', 'b?.ts', 'c.ts'], true);
		expect(searched).toEqual(['c.ts']);
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

describe('blastRadius', () => {
	test('succeeds with test count and trimmed commit', async () => {
		const blast = await blastRadius(
			port(ok({ dependents: ['a.ts', 'a.test.ts'], exports: ['f'] }, 'abcdef1234567')),
			'/r',
			['x.ts'],
			{ exports: true },
		);
		expect(blast).toEqual({ dependents: ['a.ts', 'a.test.ts'], tests: 1, exports: ['f'], asOfCommit: 'abcdef1' });
	});
	test('omits asOfCommit when absent', async () => {
		const blast = await blastRadius(port(ok({ dependents: [], exports: [] })), '/r', ['x.ts'], { exports: false });
		expect(blast).toEqual({ dependents: [], tests: 0, exports: [] });
	});
	test('failure gives undefined', async () => {
		const failed = { text: JSON.stringify({ success: false, error: { code: 'X' } }) };
		expect(await blastRadius(port(failed), '/r', ['x.ts'], { exports: false })).toBeUndefined();
		expect(await blastRadius(port(new Error('down')), '/r', ['x.ts'], { exports: false })).toBeUndefined();
	});
	test('malformed result gives undefined', async () => {
		for (const result of [null, 'x', { dependents: 'a', exports: [] }, { dependents: [1], exports: [] }, { dependents: [] }]) {
			expect(await blastRadius(port(ok(result)), '/r', ['x.ts'], { exports: false })).toBeUndefined();
		}
	});
	test('caps files at 50 and embeds arguments', async () => {
		const programs: string[] = [];
		const files = Array.from({ length: 80 }, (_, i) => `f${i}.ts`);
		await blastRadius(port(ok({ dependents: [], exports: [] }), programs), '/r', files, { exports: true });
		expect(programs[0]).toContain(JSON.stringify(files.slice(0, 50)));
		expect(programs[0]).not.toContain('"f50.ts"');
		expect(programs[0]).toMatch(/, true\);$/);
	});
});

describe('relativeTo', () => {
	test('inside and outside the root', () => {
		expect(relativeTo('/r', '/r/a/b.ts')).toBe('a/b.ts');
		expect(relativeTo('/r', '/other/b.ts')).toBeNull();
	});
});
