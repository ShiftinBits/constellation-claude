import { describe, expect, test } from 'claude-code/testing';
import type { McpPort } from './lib';
import { atLeast, fileRisk, forgetAgentEvidence, hasEvidence, noteCodeIntel, resetRiskCache } from './risk';

const ROOT = '/work/app';

type Canned = { dependents: number; exported?: string[]; commit?: string; success?: boolean; text?: string };

/** A host whose code_intel answers with `answer(code)`, recording each program it ran. Starts from an empty cache. */
function host(answer: (code: string) => Canned) {
	resetRiskCache();
	const programs: string[] = [];
	const port: McpPort = {
		connect: async () => ({ isConnected: true, server: 'plugin:constellation:constellation' }),
		call: async (_server, _tool, args) => {
			const code = String(args?.code);
			programs.push(code);
			const canned = answer(code);
			const body =
				canned.text ??
				JSON.stringify({
					success: canned.success ?? true,
					result: {
						dependents: Array.from({ length: canned.dependents }, (_, i) => `src/dep${i}.ts`),
						exported: canned.exported ?? [],
					},
					asOfCommit: canned.commit,
				});
			return { content: [{ type: 'text', text: body }], isError: false };
		},
	};
	return { port, programs };
}

describe('fileRisk levels', () => {
	const cases: Array<[number, string]> = [
		[4, 'low'],
		[5, 'medium'],
		[19, 'medium'],
		[20, 'high'],
		[49, 'high'],
		[50, 'critical'],
	];
	for (const [count, level] of cases) {
		test(`${count} dependents is ${level}`, async () => {
			const { port } = host(() => ({ dependents: count }));
			const risk = await fileRisk(port, ROOT, `${ROOT}/src/a.ts`);
			expect(risk?.level).toBe(level);
			expect(risk?.dependents).toBe(count);
		});
	}
});

describe('atLeast', () => {
	test('orders low < medium < high < critical', () => {
		expect(atLeast('high', 'high')).toBe(true);
		expect(atLeast('critical', 'high')).toBe(true);
		expect(atLeast('medium', 'high')).toBe(false);
		expect(atLeast('high', 'critical')).toBe(false);
		expect(atLeast('low', 'low')).toBe(true);
	});
});

describe('fileRisk', () => {
	test('sends the project-relative path in the program', async () => {
		const { port, programs } = host(() => ({ dependents: 1 }));
		const risk = await fileRisk(port, ROOT, `${ROOT}/src/a.ts`);
		expect(risk?.path).toBe('src/a.ts');
		expect(programs.length).toBe(1);
		expect(programs[0]).toContain('"src/a.ts"');
		expect(programs[0]).not.toContain(ROOT);
	});

	test('a path outside the root is undefined and makes no call', async () => {
		const { port, programs } = host(() => ({ dependents: 1 }));
		expect(await fileRisk(port, ROOT, '/elsewhere/a.ts')).toBeUndefined();
		expect(await fileRisk(port, ROOT, `${ROOT}/../other/a.ts`)).toBeUndefined();
		expect(programs.length).toBe(0);
	});

	test('maps an envelope to a FileRisk with three dependents and a short commit', async () => {
		const { port } = host(() => ({ dependents: 6, exported: ['A', 'B'], commit: '0123456789abcdef' }));
		expect(await fileRisk(port, ROOT, `${ROOT}/src/a.ts`)).toEqual({
			path: 'src/a.ts',
			dependents: 6,
			topDependents: ['src/dep0.ts', 'src/dep1.ts', 'src/dep2.ts'],
			exportedSymbols: ['A', 'B'],
			level: 'medium',
			asOfCommit: '0123456',
		});
	});

	test('concurrent requests share one call', async () => {
		const { port, programs } = host(() => ({ dependents: 1 }));
		const [a, b] = await Promise.all([fileRisk(port, ROOT, `${ROOT}/src/a.ts`), fileRisk(port, ROOT, `${ROOT}/src/a.ts`)]);
		expect(a).toEqual(b);
		expect(programs.length).toBe(1);
	});

	test('a failure is not cached', async () => {
		let fail = true;
		const { port, programs } = host(() => (fail ? { dependents: 0, success: false } : { dependents: 2 }));
		expect(await fileRisk(port, ROOT, `${ROOT}/src/a.ts`)).toBeUndefined();
		fail = false;
		expect((await fileRisk(port, ROOT, `${ROOT}/src/a.ts`))?.dependents).toBe(2);
		expect(programs.length).toBe(2);
	});

	test('an unparseable result is not cached', async () => {
		const { port, programs } = host(() => ({ dependents: 0, text: 'not json' }));
		expect(await fileRisk(port, ROOT, `${ROOT}/src/a.ts`)).toBeUndefined();
		await fileRisk(port, ROOT, `${ROOT}/src/a.ts`);
		expect(programs.length).toBe(2);
	});

	test('a changed asOfCommit drops the other cached paths for that root', async () => {
		let commit = 'aaaaaaa1';
		const { port, programs } = host(() => ({ dependents: 1, commit }));
		await fileRisk(port, ROOT, `${ROOT}/src/a.ts`);
		await fileRisk(port, ROOT, `${ROOT}/src/b.ts`);
		await fileRisk(port, ROOT, `${ROOT}/src/b.ts`);
		expect(programs.length).toBe(2);
		commit = 'bbbbbbb2';
		await fileRisk(port, ROOT, `${ROOT}/src/c.ts`);
		await fileRisk(port, ROOT, `${ROOT}/src/a.ts`);
		await fileRisk(port, ROOT, `${ROOT}/src/b.ts`);
		expect(programs.length).toBe(5);
	});

	test('resetRiskCache empties the cache', async () => {
		const { port, programs } = host(() => ({ dependents: 1 }));
		await fileRisk(port, ROOT, `${ROOT}/src/a.ts`);
		resetRiskCache();
		await fileRisk(port, ROOT, `${ROOT}/src/a.ts`);
		expect(programs.length).toBe(2);
	});
});

describe('code_intel evidence', () => {
	const call = (code: string) => ({ tool: 'code_intel', code });

	test('a path in the code counts', () => {
		resetRiskCache();
		noteCodeIntel('a', call('api.getDependents({ filePath: "src/core.ts" })'), { result: {} });
		expect(hasEvidence('a', ['src/core.ts'])).toBe(true);
		expect(hasEvidence('a', ['src/other.ts'])).toBe(false);
	});

	test('a symbol in the result text counts', () => {
		resetRiskCache();
		noteCodeIntel('a', call('api.searchSymbols({})'), { result: {}, text: '{"symbols":[{"name":"Core"}]}' });
		expect(hasEvidence('a', ['src/core.ts', 'Core'])).toBe(true);
	});

	test('missing input and text record nothing and do not throw', () => {
		resetRiskCache();
		noteCodeIntel('a', { tool: 'code_intel' }, { result: {} });
		expect(hasEvidence('a', ['x'])).toBe(false);
	});

	test('empty needles never match', () => {
		resetRiskCache();
		noteCodeIntel('a', call('code'), { result: {}, text: 'text' });
		expect(hasEvidence('a', [''])).toBe(false);
		expect(hasEvidence('a', [])).toBe(false);
	});

	test('a deny result is ignored', () => {
		resetRiskCache();
		noteCodeIntel('a', call('src/core.ts'), { deny: 'no' });
		expect(hasEvidence('a', ['src/core.ts'])).toBe(false);
	});

	test('evidence is per agent and forgetAgentEvidence drops it', () => {
		resetRiskCache();
		noteCodeIntel('a', call('src/core.ts'), { result: {} });
		expect(hasEvidence('b', ['src/core.ts'])).toBe(false);
		forgetAgentEvidence('a');
		expect(hasEvidence('a', ['src/core.ts'])).toBe(false);
	});

	test('resetRiskCache clears evidence', () => {
		noteCodeIntel('a', call('src/core.ts'), { result: {} });
		resetRiskCache();
		expect(hasEvidence('a', ['src/core.ts'])).toBe(false);
	});
});
