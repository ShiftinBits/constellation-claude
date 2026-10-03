import { describe, expect, test } from 'claude-code/testing';
import {
	atLeast,
	collectEvidence,
	FRESH_MS,
	fileRisk,
	forgetAgentEvidence,
	hasEvidence,
	noteCodeIntel,
	RETRY_MS,
	resetRiskCache,
	type RiskPort,
} from './risk';

const ROOT = '/work/app';

type Canned = { dependents: number; used?: string[]; commit?: string; success?: boolean; text?: string };

/**
 * A host whose code_intel answers with `answer(code)`, recording each program it
 * ran and each timer set. Starts from an empty cache.
 */
function host(answer: (code: string) => Canned | Promise<Canned>) {
	resetRiskCache();
	const programs: string[] = [];
	const timers: Array<{ ms: number; fn: () => void }> = [];
	/** Fires every timer set for `ms`. */
	const fire = (ms: number) => {
		for (const t of timers.filter((t) => t.ms === ms)) t.fn();
	};
	const port: RiskPort = {
		after: (ms, fn) => {
			timers.push({ ms, fn });
		},
		connect: async () => ({ isConnected: true, server: 'plugin:constellation:constellation' }),
		call: async (_server, _tool, args) => {
			const code = String(args?.code);
			programs.push(code);
			const canned = await answer(code);
			const body =
				canned.text ??
				JSON.stringify({
					success: canned.success ?? true,
					result: {
						dependents: Array.from({ length: canned.dependents }, (_, i) => `src/dep${i}.ts`),
						used: canned.used ?? [],
					},
					asOfCommit: canned.commit,
				});
			return { content: [{ type: 'text', text: body }], isError: false };
		},
	};
	return { port, programs, fire };
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
		expect(programs[0]).toContain('includeSymbols: true');
		expect(programs[0]).not.toContain(ROOT);
	});

	test('a path with . or .. segments inside the root is looked up as the file it names', async () => {
		const { port, programs } = host(() => ({ dependents: 1 }));
		expect((await fileRisk(port, ROOT, `${ROOT}/src/./x/../a.ts`))?.path).toBe('src/a.ts');
		expect((await fileRisk(port, ROOT, `${ROOT}/src/a.ts`))?.path).toBe('src/a.ts');
		expect(programs.length).toBe(1);
	});

	test('a path outside the root is undefined and makes no call', async () => {
		const { port, programs } = host(() => ({ dependents: 1 }));
		expect(await fileRisk(port, ROOT, '/elsewhere/a.ts')).toBeUndefined();
		expect(await fileRisk(port, ROOT, `${ROOT}/../other/a.ts`)).toBeUndefined();
		expect(programs.length).toBe(0);
	});

	test('maps an envelope to a FileRisk with three dependents and a short commit', async () => {
		const { port } = host(() => ({ dependents: 6, used: ['A', 'B'], commit: '0123456789abcdef' }));
		expect(await fileRisk(port, ROOT, `${ROOT}/src/a.ts`)).toEqual({
			path: 'src/a.ts',
			dependents: 6,
			topDependents: ['src/dep0.ts', 'src/dep1.ts', 'src/dep2.ts'],
			usedSymbols: ['A', 'B'],
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

	test('a failure is kept until its retry timer fires', async () => {
		let fail = true;
		const { port, programs, fire } = host(() => (fail ? { dependents: 0, success: false } : { dependents: 2 }));
		expect(await fileRisk(port, ROOT, `${ROOT}/src/a.ts`)).toBeUndefined();
		fail = false;
		expect(await fileRisk(port, ROOT, `${ROOT}/src/a.ts`)).toBeUndefined();
		expect(programs.length).toBe(1);
		fire(RETRY_MS);
		expect((await fileRisk(port, ROOT, `${ROOT}/src/a.ts`))?.dependents).toBe(2);
		expect(programs.length).toBe(2);
	});

	test('an unparseable result is a failure', async () => {
		const { port, programs, fire } = host(() => ({ dependents: 0, text: 'not json' }));
		expect(await fileRisk(port, ROOT, `${ROOT}/src/a.ts`)).toBeUndefined();
		fire(RETRY_MS);
		await fileRisk(port, ROOT, `${ROOT}/src/a.ts`);
		expect(programs.length).toBe(2);
	});

	test('a cached risk is read again once its freshness timer fires', async () => {
		let count = 1;
		const { port, programs, fire } = host(() => ({ dependents: count }));
		await fileRisk(port, ROOT, `${ROOT}/src/a.ts`);
		count = 60;
		expect((await fileRisk(port, ROOT, `${ROOT}/src/a.ts`))?.dependents).toBe(1);
		fire(FRESH_MS);
		expect((await fileRisk(port, ROOT, `${ROOT}/src/a.ts`))?.level).toBe('critical');
		expect(programs.length).toBe(2);
	});

	test('a lookup started before a reset leaves the newer entry alone', async () => {
		let release: (c: Canned) => void = () => {};
		let first = true;
		const { port, programs, fire } = host(() => {
			if (!first) return { dependents: 3 };
			first = false;
			return new Promise<Canned>((resolve) => {
				release = resolve;
			});
		});
		const stale = fileRisk(port, ROOT, `${ROOT}/src/a.ts`);
		resetRiskCache();
		expect((await fileRisk(port, ROOT, `${ROOT}/src/a.ts`))?.dependents).toBe(3);
		release({ dependents: 0, success: false });
		await stale;
		fire(RETRY_MS);
		expect((await fileRisk(port, ROOT, `${ROOT}/src/a.ts`))?.dependents).toBe(3);
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

	test('a lookup swept by a newer commit leaves the newer entries and commit alone', async () => {
		let commit = 'aaaaaaa1';
		let release: (c: Canned) => void = () => {};
		let hold = false;
		const { port, programs } = host(() => {
			if (!hold) return { dependents: 1, commit };
			hold = false;
			return new Promise<Canned>((resolve) => {
				release = resolve;
			});
		});
		await fileRisk(port, ROOT, `${ROOT}/src/c.ts`);
		hold = true;
		const stale = fileRisk(port, ROOT, `${ROOT}/src/a.ts`);
		commit = 'bbbbbbb2';
		await fileRisk(port, ROOT, `${ROOT}/src/b.ts`);
		expect((await fileRisk(port, ROOT, `${ROOT}/src/a.ts`))?.asOfCommit).toBe('bbbbbbb');
		release({ dependents: 9, commit: 'aaaaaaa1' });
		await stale;
		expect((await fileRisk(port, ROOT, `${ROOT}/src/a.ts`))?.asOfCommit).toBe('bbbbbbb');
		await fileRisk(port, ROOT, `${ROOT}/src/b.ts`);
		expect(programs.length).toBe(4);
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
	const DEPS = "api.getDependents({ filePath: 'src/core.ts' })";
	const OK = { text: '{"success":true}' };

	/** An empty cache with evidence recorded, as require-analysis mode runs. */
	function collecting() {
		resetRiskCache();
		collectEvidence(true);
	}

	test('a path an impact method was asked about counts, exactly', () => {
		collecting();
		noteCodeIntel('a', call(DEPS), OK);
		expect(hasEvidence('a', ['src/core.ts'], [])).toBe(true);
		expect(hasEvidence('a', ['core.ts'], [])).toBe(false);
		expect(hasEvidence('a', ['src/other.ts'], [])).toBe(false);
	});

	test('a symbol counts as a whole identifier in a literal of the same program', () => {
		collecting();
		noteCodeIntel('a', call("const s = await api.searchSymbols({ query: 'AuthService.login' }); return api.impactAnalysis({ symbolId: s.symbols[0].id });"), OK);
		expect(hasEvidence('a', [], ['AuthService'])).toBe(true);
		expect(hasEvidence('a', [], ['login'])).toBe(true);
		expect(hasEvidence('a', [], ['Auth'])).toBe(false);
	});

	test('a program with no impact method records nothing', () => {
		collecting();
		noteCodeIntel('a', call("api.searchSymbols({ query: 'api' })"), { text: '{"success":true,"result":"api src/core.ts"}' });
		expect(hasEvidence('a', ['src/core.ts'], ['api', 'success'])).toBe(false);
	});

	test('the result text is not evidence', () => {
		collecting();
		noteCodeIntel('a', call("api.getDependents({ filePath: 'src/other.ts' })"), { text: '{"success":true,"result":"src/core.ts Core"}' });
		expect(hasEvidence('a', ['src/core.ts'], ['Core'])).toBe(false);
	});

	test('a path in a literal does not name the symbols its words spell', () => {
		collecting();
		noteCodeIntel('a', call("api.getDependents({ filePath: 'src/config/index.ts' })"), OK);
		expect(hasEvidence('a', ['src/other.ts'], ['config', 'index', 'src'])).toBe(false);
	});

	test('a failed call records nothing: an error result, success false, or no text', () => {
		collecting();
		noteCodeIntel('a', call(DEPS), { isError: true, text: '{"success":true}' });
		noteCodeIntel('a', call(DEPS), { text: '{"success":false,"error":{"code":"CWD_NOT_INDEXED"}}' });
		noteCodeIntel('a', call(DEPS), {});
		expect(hasEvidence('a', ['src/core.ts'], [])).toBe(false);
	});

	test('nothing is recorded while collection is off', () => {
		resetRiskCache();
		collectEvidence(false);
		noteCodeIntel('a', call(DEPS), OK);
		expect(hasEvidence('a', ['src/core.ts'], [])).toBe(false);
	});

	test('missing code records nothing and does not throw', () => {
		collecting();
		noteCodeIntel('a', { tool: 'code_intel' }, OK);
		expect(hasEvidence('a', ['x'], ['x'])).toBe(false);
	});

	test('empty needles never match', () => {
		collecting();
		noteCodeIntel('a', call(DEPS), OK);
		expect(hasEvidence('a', [''], [''])).toBe(false);
		expect(hasEvidence('a', [], [])).toBe(false);
	});

	test('a deny result is ignored, an undefined deny is not', () => {
		collecting();
		noteCodeIntel('a', call(DEPS), { deny: 'no' });
		expect(hasEvidence('a', ['src/core.ts'], [])).toBe(false);
		noteCodeIntel('a', call(DEPS), { deny: undefined, ...OK });
		expect(hasEvidence('a', ['src/core.ts'], [])).toBe(true);
	});

	test('evidence is per agent and forgetAgentEvidence drops it', () => {
		collecting();
		noteCodeIntel('a', call(DEPS), OK);
		expect(hasEvidence('b', ['src/core.ts'], [])).toBe(false);
		forgetAgentEvidence('a');
		expect(hasEvidence('a', ['src/core.ts'], [])).toBe(false);
	});

	test('resetRiskCache clears evidence', () => {
		collecting();
		noteCodeIntel('a', call(DEPS), OK);
		resetRiskCache();
		expect(hasEvidence('a', ['src/core.ts'], [])).toBe(false);
	});
});
