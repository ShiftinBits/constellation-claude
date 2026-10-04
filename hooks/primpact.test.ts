import type { McpToolResult, On, PluginOptions } from 'claude-code';
import { describe, expect, test } from 'claude-code/testing';
import { type Blast, probe } from './blast';
import { ghPrCreate } from './classify';
import { buildImpactSection, PR_DEADLINE_MS, registerPrImpact, resetPrImpact } from './primpact';
import { registerSession } from './session';

const KEY = 'ak:test-key';
const PROJECT = '/work/app';
const COMMIT = '0123456789abcdef';
const INSTRUCTION = 'Add this Impact section to the PR body and run gh pr create again.';

type Answer = Record<string, unknown>;
type Bottom = (e: object) => Promise<Answer>;
type Next = Bottom & { origin: { plugin: string; tier: string }; signal: AbortSignal };
type Handler = ($: object, e: object, next: Next) => Promise<Answer>;
type Registered = { event: string; matcher: Record<string, unknown>; handler: Handler };

/** What a fake git command answers: its exit code and output, or an Error it rejects with. */
type GitAnswer = { exitCode: number; stdout: string } | Error;

/** True when the event `e` satisfies a matcher: a pattern, a list of values, or a value per field. */
function matches(matcher: Record<string, unknown>, e: object): boolean {
	return Object.entries(matcher).every(([field, want]) => {
		const got: unknown = Reflect.get(e, field);
		if (want instanceof RegExp) return want.test(String(got));
		if (Array.isArray(want)) return want.includes(got);
		return want === got;
	});
}

type World = {
	/** The access key; `KEY` when not given. */
	key?: string;
	/** Paths that exist; only `constellation.json` at the project root when not given. */
	exists?: (path: string) => boolean;
	/** The checked-out branch; `feat/x` when not given. */
	branch?: string;
	/** Answers per git argv (joined by spaces), over the defaults below. */
	git?: Record<string, GitAnswer>;
	/** File contents `$.fs.read` answers, by absolute path; any other path rejects. */
	files?: Record<string, string>;
	/** Direct dependents per project-relative file. */
	dependents?: Record<string, string[]>;
	/** Exported symbol names per project-relative file. */
	exports?: Record<string, string[]>;
	/** When set, code_intel answers this failure instead. */
	failure?: 'error' | 'unsuccessful';
	/** When true, code_intel never answers and the deadline passes at once. */
	slow?: boolean;
};

/** What the fake `$` recorded, in order. */
type Calls = {
	/** Every `$.process.run`: its argv joined by spaces, and its cwd. */
	runs: Array<{ argv: string; cwd: string | undefined }>;
	/** Every path `$.fs.read` was asked for. */
	reads: string[];
	/** Every path `$.fs.exists` was asked about. */
	exists: string[];
	/** Every `$.ui.log` line. */
	logs: string[];
	/** The deadlines `$.clock.sleep` was asked for. */
	sleeps: number[];
	/** The files each code_intel lookup asked about. */
	queried: string[][];
	/** `run` when the command itself ran, `git` per git command, `log` per log line: the order things happened in. */
	order: string[];
	envReads: number;
};

const GIT = 'git -c core.fsmonitor=false -c core.hooksPath=/dev/null -c protocol.allow=never';
const DIFF_MAIN = `${GIT} diff --no-ext-diff --no-renames --name-only --relative origin/main...HEAD`;
const DIFF_DEV = `${GIT} diff --no-ext-diff --no-renames --name-only --relative origin/dev...HEAD`;
const SYMBOLIC_REF = `${GIT} symbolic-ref refs/remotes/origin/HEAD`;
const REV_PARSE = `${GIT} rev-parse --abbrev-ref HEAD`;

/** Reads the files and the exports flag back out of a serialized `probe` program. */
function probeArgs(code: string): { files: string[]; exports: boolean } {
	const m = /\(api, (\[.*\]), (true|false)\);$/.exec(code);
	if (m === null) throw new Error(`not a probe program: ${code}`);
	return { files: JSON.parse(m[1] ?? '[]') as string[], exports: m[2] === 'true' };
}

/**
 * The PR impact handler (and the session handlers, for the reset) as one hooks
 * module registers them, raised directly with a fake `$`: the test kit has no
 * `$.mcp`, `$.fs`, `$.env.get` or `$.process`. code_intel runs the real
 * `probe` against the world's graph.
 */
function load(options: PluginOptions = {}, world: World = {}) {
	const registered: Registered[] = [];
	const capture = (event: string, ...rest: unknown[]) => {
		const handler = rest[rest.length - 1] as Handler;
		const matcher = rest.length > 1 ? (rest[0] as Record<string, unknown>) : {};
		registered.push({ event, matcher, handler });
	};
	registerPrImpact(capture as unknown as On, options);

	const calls: Calls = { runs: [], reads: [], exists: [], logs: [], sleeps: [], queried: [], order: [], envReads: 0 };
	const exists = world.exists ?? ((p: string) => p === `${PROJECT}/constellation.json`);
	const git = (): Record<string, GitAnswer> => ({
		[REV_PARSE]: { exitCode: 0, stdout: `${world.branch ?? 'feat/x'}\n` },
		[SYMBOLIC_REF]: { exitCode: 0, stdout: 'refs/remotes/origin/main\n' },
		[DIFF_MAIN]: { exitCode: 0, stdout: 'src/a.ts\nsrc/b.ts\n' },
		[DIFF_DEV]: { exitCode: 0, stdout: 'src/a.ts\n' },
		...world.git,
	});
	const $ = {
		env: {
			get: async () => {
				calls.envReads++;
				return world.key ?? KEY;
			},
		},
		session: { cwd: async () => PROJECT },
		fs: {
			exists: async (path: string) => {
				calls.exists.push(path);
				return exists(path);
			},
			read: async (path: string) => {
				calls.reads.push(path);
				const text = world.files?.[path];
				if (text === undefined) throw new Error(`ENOENT: ${path}`);
				return text;
			},
		},
		process: {
			run: async (argv: readonly string[], init?: { cwd?: string; env?: Record<string, string> }) => {
				const key = argv.join(' ');
				if (init?.env?.GIT_NO_LAZY_FETCH !== '1') throw new Error('git ran with lazy fetch on');
				calls.runs.push({ argv: key, cwd: init?.cwd });
				calls.order.push('git');
				const answer = git()[key] ?? { exitCode: 128, stdout: '' };
				if (answer instanceof Error) throw answer;
				return { ...answer, stderr: '', isStdoutTruncated: false, isStderrTruncated: false };
			},
		},
		mcp: {
			connect: async () => ({ isConnected: true, server: 'plugin:constellation:constellation' }),
			call: async (_server: string, _tool: string, args: { code: string; cwd: string }): Promise<McpToolResult> => {
				const { files, exports } = probeArgs(args.code);
				calls.queried.push(files);
				if (world.slow) return new Promise<McpToolResult>(() => {});
				if (world.failure === 'error') throw new Error('server down');
				if (world.failure === 'unsuccessful') {
					const body = { success: false, error: { code: 'PROJECT_NOT_INDEXED' } };
					return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false };
				}
				const result = await probe(
					{
						getDependents: async ({ filePath }) => ({
							directDependents: (world.dependents?.[filePath] ?? []).map((f) => ({ filePath: f })),
						}),
						searchSymbols: async ({ filterByFile }) => ({
							symbols: (world.exports?.[filterByFile] ?? []).map((name) => ({ name, filePath: filterByFile })),
						}),
					},
					files,
					exports,
				);
				const body = { success: true, result, asOfCommit: COMMIT };
				return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false };
			},
		},
		clock: {
			// The deadline passes at once in a slow world; otherwise it waits until the hook aborts it.
			sleep: (ms: number, opts?: { signal?: AbortSignal }) => {
				calls.sleeps.push(ms);
				return world.slow
					? Promise.resolve()
					: new Promise<void>((_, reject) => opts?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
			},
		},
		ui: {
			log: (text: string) => {
				calls.logs.push(text);
				calls.order.push('log');
			},
		},
	};

	/** Raises `event` through the handlers that match it, in registration order, over `bottom`. */
	const raise = (event: string, e: object, bottom: Bottom): Promise<Answer> => {
		const chain = registered.filter((r) => r.event === event && matches(r.matcher, e));
		const signal = new AbortController().signal;
		const step = (i: number): Next =>
			Object.assign(
				(input: object) => {
					const hook = chain[i];
					return hook === undefined ? bottom(input) : hook.handler($, input, step(i + 1));
				},
				{ origin: { plugin: 'engine', tier: 'core' }, signal },
			);
		return step(0)(e);
	};

	return {
		calls,
		registered,
		world,
		/** Runs `command` through Bash over a bottom that answers `answer` and records that it ran. */
		bash: async (command: string, answer: Answer = { result: 'ran' }) => {
			let ran = false;
			const r = await raise('tool.call', { tool: 'Bash', command, tool_use_id: 'u1' }, async () => {
				ran = true;
				calls.order.push('run');
				return answer;
			});
			return { r, ran };
		},
		/** Registers the session hooks on the same stand-in `on` and raises a `/clear`. */
		clear: () => {
			registerSession(capture as unknown as On);
			return raise('classic.SessionStart', { source: 'clear' }, async () => ({}));
		},
	};
}

const REQUIRE: PluginOptions = { prImpact: 'require' };
const PLAIN = 'gh pr create --title "Add x" --body "Adds x."';
const WITH_HEADING = 'gh pr create --title "Add x" --body "Adds x.\n\n## Impact\n- small"';

/** A world where `src/a.ts` has dependents (one a test) and exports. */
const GRAPH: World = {
	dependents: { 'src/a.ts': ['src/use.ts', 'src/a.test.ts'] },
	exports: { 'src/a.ts': ['makeA', 'A'] },
};

function denyOf(r: Answer): string {
	const deny = r['deny'];
	if (typeof deny !== 'string') throw new Error(`not a deny: ${JSON.stringify(r)}`);
	return deny;
}

describe('buildImpactSection', () => {
	const blast = (over: Partial<Blast> = {}): Blast => ({ dependents: [], tests: 0, exports: [], ...over });

	test('lists the counts, the most affected dependents, the exports and the indexed commit', () => {
		const section = buildImpactSection(['src/a.ts', 'src/b.ts'], blast({ dependents: ['src/use.ts', 'src/a.test.ts'], tests: 1, exports: ['makeA'], asOfCommit: '0123456' }));
		expect(section).toBe(
			[
				'## Impact',
				'',
				'- **Changed files:** 2',
				'- **Downstream dependents:** 2 (1 test file)',
				'- **Most affected:** `src/use.ts`, `src/a.test.ts`',
				'- **Exported symbols in changed files:** `makeA`',
				'',
				'_From the code graph as of 0123456; imports through tsconfig path aliases or export * barrels may be undercounted._',
			].join('\n'),
		);
	});

	test('caps the dependents at five and the exports at ten, with a count of the rest', () => {
		const dependents = Array.from({ length: 12 }, (_, i) => `src/d${i}.ts`);
		const exports = Array.from({ length: 13 }, (_, i) => `e${i}`);
		const section = buildImpactSection(['src/a.ts'], blast({ dependents, tests: 0, exports }));
		const lines = section.split('\n');
		expect(lines.length).toBeLessThanOrEqual(10);
		expect(section).toContain('- **Downstream dependents:** 12 (0 test files)');
		expect(section).toContain('- **Most affected:** `src/d0.ts`, `src/d1.ts`, `src/d2.ts`, `src/d3.ts`, `src/d4.ts`\n');
		expect(section).toContain('`e9`, +3 more');
		expect(section).not.toContain('`e10`');
	});

	test('omits the empty lists and the commit when unknown', () => {
		const section = buildImpactSection(['src/a.ts'], blast());
		expect(section).not.toContain('Most affected');
		expect(section).not.toContain('Exported symbols');
		expect(section).toContain('_From the code graph; imports through');
		expect(section).not.toContain('\u2014');
	});

	test('says which files the dependents came from when some were past the cap', () => {
		const changed = Array.from({ length: 60 }, (_, i) => `f${i}.ts`);
		const section = buildImpactSection(changed, blast({ skipped: 10 }));
		expect(section).toContain('- **Changed files:** 60');
		expect(section).toContain(', of the first 50 changed files');
	});
});

describe('PR impact in require mode', () => {
	test('denies gh pr create without an Impact heading, with the section and the instruction', async () => {
		const { bash, calls } = load(REQUIRE, GRAPH);
		const { r, ran } = await bash(PLAIN);
		expect(ran).toBe(false);
		const deny = denyOf(r);
		expect(deny).toStartWith('## Impact\n');
		expect(deny).toContain('- **Changed files:** 2');
		expect(deny).toContain('- **Downstream dependents:** 2 (1 test file)');
		expect(deny).toContain('`makeA`, `A`');
		expect(deny).toContain('as of 0123456');
		expect(deny).toEndWith(`\n\n${INSTRUCTION}`);
		expect(calls.queried).toEqual([['src/a.ts', 'src/b.ts']]);
		expect(calls.sleeps).toEqual([PR_DEADLINE_MS]);
		expect(calls.runs.every((run) => run.cwd === PROJECT)).toBe(true);
	});

	test('lets gh pr create run when the body has the heading', async () => {
		const { bash, calls } = load(REQUIRE, GRAPH);
		const { r, ran } = await bash(WITH_HEADING);
		expect(ran).toBe(true);
		expect(r).toEqual({ result: 'ran' });
		expect(calls.runs).toEqual([]);
	});

	const heredoc = (impact: boolean) =>
		[
			'gh pr create --title "Add x" --body "$(cat <<\'EOF\'',
			'## Summary',
			'It\'s done; the "fast" path stays.',
			...(impact ? ['', '## Impact', '- 2 files'] : []),
			'EOF',
			')"',
		].join('\n');

	test('lets a heredoc body with quotes, an apostrophe, a ; and the heading run', async () => {
		const line = heredoc(true);
		expect(ghPrCreate(line)).not.toBeNull();
		const { bash } = load(REQUIRE, GRAPH);
		expect((await bash(line)).ran).toBe(true);
	});

	test('denies the same heredoc body without the heading', async () => {
		const { bash } = load(REQUIRE, GRAPH);
		const { r, ran } = await bash(heredoc(false));
		expect(ran).toBe(false);
		expect(denyOf(r)).toContain(INSTRUCTION);
	});

	test('denies git push && gh pr create without the heading', async () => {
		const { bash } = load(REQUIRE, GRAPH);
		const { r, ran } = await bash(`git push -u origin HEAD && ${PLAIN}`);
		expect(ran).toBe(false);
		expect(denyOf(r)).toContain('## Impact');
	});

	test('reads --body-file through $.fs.read and lets it run when the file has the heading', async () => {
		const { bash, calls } = load(REQUIRE, { ...GRAPH, files: { [`${PROJECT}/notes.md`]: 'Adds x.\n\n## Impact\n- small\n' } });
		const { ran } = await bash('gh pr create --title t --body-file notes.md');
		expect(ran).toBe(true);
		expect(calls.reads).toEqual([`${PROJECT}/notes.md`]);
		expect(calls.runs).toEqual([]);
	});

	test('denies a --body-file without the heading', async () => {
		const { bash, calls } = load(REQUIRE, { ...GRAPH, files: { [`${PROJECT}/notes.md`]: 'Adds x.\n' } });
		const { r, ran } = await bash('gh pr create --title t -F notes.md');
		expect(ran).toBe(false);
		expect(calls.reads).toEqual([`${PROJECT}/notes.md`]);
		expect(denyOf(r)).toContain(INSTRUCTION);
	});

	test('lets a --body-file that cannot be read run', async () => {
		const { bash, calls } = load(REQUIRE, GRAPH);
		expect((await bash('gh pr create --title t --body-file missing.md')).ran).toBe(true);
		expect(calls.runs).toEqual([]);
	});

	test('lets --body-file - (standard input) run without reading or running git', async () => {
		const { bash, calls } = load(REQUIRE, GRAPH);
		expect((await bash('gh pr create --title t --body-file -')).ran).toBe(true);
		expect(calls.reads).toEqual([]);
		expect(calls.runs).toEqual([]);
	});

	test('refuses each branch once, and a different branch once again', async () => {
		const { bash, world } = load(REQUIRE, { ...GRAPH });
		expect((await bash(PLAIN)).ran).toBe(false);
		expect((await bash(PLAIN)).ran).toBe(true);
		world.branch = 'feat/y';
		expect((await bash(PLAIN)).ran).toBe(false);
		expect((await bash(PLAIN)).ran).toBe(true);
	});

	test('a refused branch skips the lookup on the retry', async () => {
		const { bash, calls } = load(REQUIRE, GRAPH);
		await bash(PLAIN);
		await bash(PLAIN);
		expect(calls.queried).toHaveLength(1);
		expect(calls.runs.filter((run) => run.argv === DIFF_MAIN)).toHaveLength(1);
	});

	test('--base dev diffs against origin/dev without asking for the default branch', async () => {
		const { bash, calls } = load(REQUIRE, GRAPH);
		const { r } = await bash(`${PLAIN} --base dev`);
		expect(calls.runs.map((run) => run.argv)).toEqual([REV_PARSE, DIFF_DEV]);
		expect(denyOf(r)).toContain('- **Changed files:** 1');
	});

	test('without --base the base is the remote default branch from symbolic-ref', async () => {
		const { bash, calls } = load(REQUIRE, GRAPH);
		await bash(PLAIN);
		expect(calls.runs.map((run) => run.argv)).toEqual([REV_PARSE, SYMBOLIC_REF, DIFF_MAIN]);
	});

	test('cd sub && gh pr create resolves the directory, the project root and the body file under it', async () => {
		const sub = `${PROJECT}/sub`;
		const { bash, calls } = load(REQUIRE, {
			...GRAPH,
			exists: (p) => p === `${sub}/constellation.json`,
			files: { [`${sub}/notes.md`]: 'Adds x.\n' },
		});
		const { ran } = await bash('cd sub && gh pr create --title t --body-file notes.md');
		expect(ran).toBe(false);
		expect(calls.exists[0]).toBe(`${sub}/constellation.json`);
		expect(calls.reads).toEqual([`${sub}/notes.md`]);
		expect(calls.runs.every((run) => run.cwd === sub)).toBe(true);
	});

	test('a cd out of the session directory passes untouched without running git', async () => {
		const { bash, calls } = load(REQUIRE, { ...GRAPH, exists: () => true });
		for (const line of ['cd .. && gh pr create --title t --body x', 'cd /tmp/other && gh pr create --title t --body x']) {
			const { ran } = await bash(line);
			expect(ran).toBe(true);
		}
		expect(calls.runs).toEqual([]);
	});

	test('passes other Bash commands untouched without running anything', async () => {
		const { bash, calls } = load(REQUIRE, GRAPH);
		for (const line of ['git status', 'gh pr view', 'echo gh pr create', 'ls | gh pr create']) {
			const { r, ran } = await bash(line);
			expect(ran).toBe(true);
			expect(r).toEqual({ result: 'ran' });
		}
		expect(calls.runs).toEqual([]);
		expect(calls.envReads).toBe(0);
	});

	const failOpen: Array<[string, World]> = [
		['no access key', { ...GRAPH, key: 'nope' }],
		['no constellation.json', { ...GRAPH, exists: () => false }],
		['git rev-parse exits nonzero', { ...GRAPH, git: { [REV_PARSE]: { exitCode: 128, stdout: '' } } }],
		['an empty branch', { ...GRAPH, git: { [REV_PARSE]: { exitCode: 0, stdout: '\n' } } }],
		['git symbolic-ref exits nonzero', { ...GRAPH, git: { [SYMBOLIC_REF]: { exitCode: 1, stdout: '' } } }],
		['git diff exits nonzero', { ...GRAPH, git: { [DIFF_MAIN]: { exitCode: 128, stdout: '' } } }],
		['git diff lists nothing', { ...GRAPH, git: { [DIFF_MAIN]: { exitCode: 0, stdout: '\n' } } }],
		['git cannot start', { ...GRAPH, git: { [REV_PARSE]: new Error('spawn git ENOENT') } }],
		['git times out', { ...GRAPH, git: { [DIFF_MAIN]: new Error('timed out') } }],
		['code_intel throws', { ...GRAPH, failure: 'error' }],
		['code_intel answers unsuccessfully', { ...GRAPH, failure: 'unsuccessful' }],
		['the lookup misses the deadline', { ...GRAPH, slow: true }],
	];
	for (const [name, world] of failOpen) {
		test(`lets gh pr create run when ${name}`, async () => {
			const { bash } = load(REQUIRE, world);
			const { r, ran } = await bash(PLAIN);
			expect(ran).toBe(true);
			expect(r).toEqual({ result: 'ran' });
		});
	}

	test('never guesses main when symbolic-ref fails', async () => {
		const { bash, calls } = load(REQUIRE, { ...GRAPH, git: { [SYMBOLIC_REF]: { exitCode: 1, stdout: '' } } });
		await bash(PLAIN);
		expect(calls.runs.map((run) => run.argv)).toEqual([REV_PARSE, SYMBOLIC_REF]);
	});

	test('a failed lookup leaves the branch unrefused, so the next attempt is still checked', async () => {
		const { bash, world } = load(REQUIRE, { ...GRAPH, failure: 'error' });
		expect((await bash(PLAIN)).ran).toBe(true);
		delete world.failure;
		expect((await bash(PLAIN)).ran).toBe(false);
	});

	test('resetPrImpact forgets the refused branches', async () => {
		const { bash } = load(REQUIRE, GRAPH);
		expect((await bash(PLAIN)).ran).toBe(false);
		resetPrImpact();
		expect((await bash(PLAIN)).ran).toBe(false);
	});

	test('/clear forgets the refused branches', async () => {
		const { bash, clear } = load(REQUIRE, GRAPH);
		expect((await bash(PLAIN)).ran).toBe(false);
		await clear();
		expect((await bash(PLAIN)).ran).toBe(false);
	});
});

describe('PR impact in inform mode', () => {
	test('runs the command first, then logs the section', async () => {
		const { bash, calls } = load({ prImpact: 'inform' }, GRAPH);
		const { r, ran } = await bash(PLAIN);
		expect(ran).toBe(true);
		expect(r).toEqual({ result: 'ran' });
		expect(calls.order[0]).toBe('run');
		expect(calls.order[calls.order.length - 1]).toBe('log');
		expect(calls.logs).toHaveLength(1);
		expect(calls.logs[0]).toStartWith('## Impact\n');
		expect(calls.logs[0]).toContain('- **Changed files:** 2');
	});

	test('logs nothing after a denied or failed command', async () => {
		for (const answer of [{ deny: 'no' }, { result: 'x', isError: true }]) {
			const { bash, calls } = load({ prImpact: 'inform' }, GRAPH);
			const { r } = await bash(PLAIN, answer);
			expect(r).toEqual(answer);
			expect(calls.runs).toEqual([]);
			expect(calls.logs).toEqual([]);
		}
	});

	test('logs nothing and keeps the result when the lookup fails', async () => {
		for (const world of [{ ...GRAPH, failure: 'error' as const }, { ...GRAPH, git: { [REV_PARSE]: new Error('spawn git ENOENT') } }]) {
			const { bash, calls } = load({ prImpact: 'inform' }, world);
			const { r, ran } = await bash(PLAIN);
			expect(ran).toBe(true);
			expect(r).toEqual({ result: 'ran' });
			expect(calls.logs).toEqual([]);
		}
	});

	const informs: Array<[string, PluginOptions]> = [
		['unset', {}],
		['unrecognized', { prImpact: 'always' }],
	];
	for (const [name, options] of informs) {
		test(`an ${name} prImpact behaves as inform and never denies`, async () => {
			const { bash, calls } = load(options, GRAPH);
			for (let i = 0; i < 2; i++) expect((await bash(PLAIN)).ran).toBe(true);
			expect(calls.logs).toHaveLength(2);
		});
	}
});

describe('PR impact off', () => {
	test('registers nothing', () => {
		const { registered } = load({ prImpact: 'off' }, GRAPH);
		expect(registered).toEqual([]);
	});
});
