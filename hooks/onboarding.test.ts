import type {
	McpToolResult,
	On,
	PluginOptions,
	ProcessRunInit,
	ProcessSpawnChunk,
	ProcessSpawnRequest,
	ProcessSpawnResult,
	RenderSurface,
} from 'claude-code';
import { describe, expect, mock, test } from 'claude-code/testing';
import {
	KEY_PATTERN,
	NOT_REGISTERED_OUTPUT,
	band,
	checkConnection,
	cliPath,
	connect,
	endTask,
	lastLine,
	manualUrl,
	observeCodeIntel,
	onboardingState,
	parseCliPath,
	parseStoredKey,
	readStoredKeyAtStart,
	registerOnboarding,
	resetOnboarding,
	startIndex,
	startSignIn,
	startTask,
	storedKey,
} from './onboarding';
import type { BandView, ButtonPorts, OnboardingPorts, OnboardingState, Run } from './onboarding';
import { onboarding, palette } from './theme';

/** A key in the CLI's format. Compared, never printed: a failing check shows a boolean, not the key. */
const KEY = 'ak:0123456789abcdef0123456789abcdef';
const OTHER_KEY = 'ak:fedcba9876543210fedcba9876543210';
const REPO = '/work/app';
const CODE_INTEL = 'mcp__plugin_constellation_constellation__code_intel';

const isKey = (value: unknown): boolean => value === KEY;

/** A code_intel answer as the tool call returns it. */
function envelope(body: object): { text: string } {
	return { text: JSON.stringify(body) };
}
const failed = (code: string, candidates?: string[]) =>
	envelope({ success: false, error: { code, message: code, ...(candidates === undefined ? {} : { context: { candidates } }) } });
const OK = envelope({ success: true, result: { pong: true } });
/** A failed code_intel call as the agent's tool call returns it: errored, and `Error: ` before the envelope. */
const errored = (code: string, candidates?: string[]) => ({ isError: true as const, text: `Error: ${failed(code, candidates).text}` });

/** A plain element as the fake table builds it. */
type Node = { type: string; props: Record<string, unknown> };
const make =
	(type: string) =>
	(props: Record<string, unknown>): Node => ({ type, props });
const EL = { Box: make('Box'), Text: make('Text'), Button: make('Button'), Link: make('Link') };

function isNode(value: unknown): value is Node {
	return typeof value === 'object' && value !== null && 'type' in value && 'props' in value;
}

/** Every element of a tree, depth first. */
function nodes(tree: unknown): Node[] {
	if (Array.isArray(tree)) return tree.flatMap(nodes);
	if (!isNode(tree)) return [];
	return [tree, ...nodes(tree.props['children'])];
}

/** All the text a tree shows: string children, Button labels and Link targets. */
function shown(tree: unknown): string {
	if (typeof tree === 'string') return tree;
	if (Array.isArray(tree)) return tree.map(shown).join('');
	if (!isNode(tree)) return '';
	const own = [tree.props['label'], tree.props['href']].filter((v): v is string => typeof v === 'string').join(' ');
	return `${own}${shown(tree.props['children'])}\n`;
}

const buttons = (tree: unknown) => nodes(tree).filter((n) => n.type === 'Button');
const keys = (tree: unknown) => buttons(tree).map((b) => b.props['key']);

/** Records what the ports were asked to do. */
function fakePorts(world: { answer?: McpToolResult; run?: Run; exists?: (p: string) => boolean } = {}) {
	const seen = { envSet: [] as string[], reloads: 0, toasts: [] as string[], logs: [] as string[], invalidations: 0, pings: [] as string[] };
	const timers: (() => void)[] = [];
	const ports: OnboardingPorts = {
		run: world.run ?? (async () => ({ exitCode: 0, stdout: '' })),
		exists: async (p) => (world.exists ?? ((path: string) => path === `${REPO}/.git` || path === `${REPO}/constellation.json`))(p),
		envSet: async (key) => {
			seen.envSet.push(key);
		},
		after: (_ms, fn) => {
			timers.push(fn);
		},
		mcp: {
			connect: async () => ({ isConnected: true, server: 's' }),
			call: async (_s, _t, args) => {
				seen.pings.push(String(args?.['code']));
				return world.answer ?? { content: [{ type: 'text', text: OK.text }], isError: false };
			},
		},
		reload: async () => {
			seen.reloads += 1;
		},
		toast: (text) => {
			seen.toasts.push(text);
		},
		invalidate: () => {
			seen.invalidations += 1;
		},
		log: async (text) => {
			seen.logs.push(text);
		},
	};
	/** Runs the timers due, as the clock reaching them. */
	const fire = async () => {
		for (const fn of timers.splice(0)) fn();
		for (let i = 0; i < 20; i++) await Promise.resolve();
	};
	return { ports, seen, timers, fire };
}

const mcpText = (body: { text: string }): McpToolResult => ({ content: [{ type: 'text', text: body.text }], isError: false });

type RenderHandler = ($: object, e: object, next: (e: object) => Promise<unknown>) => Promise<unknown>;
const FALLTHROUGH = { type: 'fallthrough', props: {} };

/**
 * The band's render hook as `registerOnboarding` registers it, raised through
 * a stand-in `on` with a fake `$`: the store, theme row and element table.
 */
function loadBand(options: PluginOptions = {}, store = new Map<string, unknown>(), world: Record<string, unknown> = {}) {
	let handler: RenderHandler | undefined;
	let matcher: unknown;
	const capture = (event: string, ...rest: unknown[]) => {
		if (event !== 'ui.render') return;
		matcher = rest[0];
		handler = rest[rest.length - 1] as RenderHandler;
	};
	registerOnboarding(capture as unknown as On, options);
	const seen = { invalidations: 0, logs: [] as string[], toasts: [] as string[] };
	const flags = { storeDown: false };
	const $ = {
		...world,
		ui: {
			resolve: () => EL,
			invalidate: () => {
				seen.invalidations += 1;
			},
			log: (text: string) => seen.logs.push(text),
			toast: (text: string) => seen.toasts.push(text),
		},
		store: {
			get: async (key: string) => {
				if (flags.storeDown) throw new Error('store unavailable');
				return store.get(key);
			},
			set: async (key: string, value: unknown) => {
				store.set(key, value);
			},
		},
		config: { list: async () => [{ key: 'theme', value: 'dark' }] },
		session: { cwd: async () => REPO, surfaces: async () => ['terminal'] },
	};
	const draw = async (props: Record<string, unknown> = {}) => {
		if (handler === undefined) throw new Error('no render hook');
		return handler($, { component: 'AbovePrompt', surface: 'terminal', props: { hasSurvey: false, isWorking: false, ...props } }, async () => FALLTHROUGH);
	};
	/** Presses the drawn Button `key` and lets its work settle. */
	const press = async (tree: unknown, key: string) => {
		const button = buttons(tree).find((b) => b.props['key'] === key);
		const onPress = button?.props['onPress'];
		if (typeof onPress !== 'function') throw new Error(`no button ${key}`);
		await onPress();
	};
	return { draw, press, matcher, seen, store, flags };
}

describe('parseStoredKey', () => {
	test('finds the key among the lines a profile prints before and after it', () => {
		expect(isKey(parseStoredKey(`Welcome back\nnvm: using node 20\n${KEY}\nlast login: today\n`))).toBe(true);
	});

	test('takes the last key when there are two', () => {
		expect(parseStoredKey(`${OTHER_KEY}\n${KEY}\n`) === KEY).toBe(true);
	});

	test('reads the reg query line', () => {
		const reg = `\r\nHKEY_CURRENT_USER\\Environment\r\n    CONSTELLATION_ACCESS_KEY    REG_SZ    ${KEY}\r\n\r\n`;
		expect(isKey(parseStoredKey(reg))).toBe(true);
	});

	test('rejects malformed and wrong-length keys', () => {
		expect(parseStoredKey('ak:0123')).toBeUndefined();
		expect(parseStoredKey(`${KEY}0`)).toBeUndefined();
		expect(parseStoredKey('ak:0123456789abcdef0123456789abcdeg')).toBeUndefined();
		expect(parseStoredKey('sk:0123456789abcdef0123456789abcdef')).toBeUndefined();
		expect(parseStoredKey(`export CONSTELLATION_ACCESS_KEY="${KEY}"`)).toBeUndefined();
		expect(parseStoredKey('')).toBeUndefined();
	});

	test('accepts upper-case hex, as the CLI does', () => {
		expect(KEY_PATTERN.test(KEY.toUpperCase().replace('AK:', 'ak:'))).toBe(true);
	});
});

describe('output helpers', () => {
	test('parseCliPath takes the last absolute path', () => {
		expect(parseCliPath('profile noise\n/usr/local/bin/constellation\n')).toBe('/usr/local/bin/constellation');
		expect(parseCliPath('/old/constellation\n/new/constellation\nbye\n')).toBe('/new/constellation');
		expect(parseCliPath('C:\\Users\\me\\AppData\\Roaming\\npm\\constellation.cmd\r\n')).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\constellation.cmd');
		expect(parseCliPath('constellation not found\n')).toBeUndefined();
	});

	test('lastLine keeps only complete lines across split chunks', () => {
		let buffer = 'Opening browser for auth';
		expect(lastLine(buffer)).toBeUndefined();
		buffer += 'entication...\nWaiting for the brow';
		expect(lastLine(buffer)).toBe('Opening browser for authentication...');
		buffer += 'ser\n\n';
		expect(lastLine(buffer)).toBe('Waiting for the browser');
	});

	test('lastLine strips carriage returns and keeps what a progress line last drew', () => {
		expect(lastLine('Indexing...\r\n')).toBe('Indexing...');
		expect(lastLine('Uploading 10%\rUploading 55%\rUploading 100%\n')).toBe('Uploading 100%');
		expect(lastLine('\r\n  \n')).toBeUndefined();
	});

	test('manualUrl finds the URL on or after the line that offers it', () => {
		expect(manualUrl('If the browser does not open, open this URL manually:\nhttp://localhost:4321/callback?state=abc\n')).toBe(
			'http://localhost:4321/callback?state=abc',
		);
		expect(manualUrl('Or open this URL manually: https://app.constellationdev.io/cli?port=5555 now')).toBe(
			'https://app.constellationdev.io/cli?port=5555',
		);
		expect(manualUrl('see https://earlier.example\nopen this URL manually:\n')).toBeUndefined();
		expect(manualUrl('Opening browser...\n')).toBeUndefined();
	});

	test('NOT_REGISTERED_OUTPUT matches the CLI line and the code', () => {
		expect(NOT_REGISTERED_OUTPUT.test('✗ Project not registered')).toBe(true);
		expect(NOT_REGISTERED_OUTPUT.test('error: PROJECT_NOT_REGISTERED')).toBe(true);
		expect(NOT_REGISTERED_OUTPUT.test('Project not indexed')).toBe(false);
	});
});

describe('onboardingState', () => {
	test('each row on its own', () => {
		expect(onboardingState({ configured: false })).toBe('not-set-up');
		expect(onboardingState({ configured: true, code: 'AUTH_ERROR' })).toBe('sign-in-again');
		expect(onboardingState({ configured: true, hasProject: false })).toBe('no-project');
		expect(onboardingState({ configured: true, code: 'CWD_NOT_INDEXED' })).toBe('no-project');
		expect(onboardingState({ configured: true, code: 'CWD_NOT_INDEXED', candidates: [] })).toBe('no-project');
		expect(onboardingState({ configured: true, code: 'PROJECT_NOT_REGISTERED' })).toBe('not-registered');
		expect(onboardingState({ configured: true, code: 'PROJECT_NOT_INDEXED', notRegistered: true })).toBe('not-registered');
		expect(onboardingState({ configured: true, code: 'PROJECT_NOT_INDEXED' })).toBe('not-indexed');
		expect(onboardingState({ configured: true, running: true })).toBe('working');
		expect(onboardingState({ configured: true })).toBeUndefined();
	});

	test('the first row that holds wins', () => {
		const all = { code: 'AUTH_ERROR', hasProject: false, notRegistered: true, running: true } as const;
		expect(onboardingState({ configured: false, ...all })).toBe('not-set-up');
		expect(onboardingState({ configured: true, ...all })).toBe('sign-in-again');
		expect(onboardingState({ configured: true, ...all, code: 'PROJECT_NOT_INDEXED' })).toBe('no-project');
		expect(onboardingState({ configured: true, ...all, code: 'PROJECT_NOT_INDEXED', hasProject: true })).toBe('not-registered');
		expect(onboardingState({ configured: true, code: 'PROJECT_NOT_INDEXED', running: true })).toBe('not-indexed');
	});

	test('a stored key found keeps an unset key from reading as not set up', () => {
		expect(onboardingState({ configured: false, stored: true })).toBeUndefined();
	});

	test('a CWD_NOT_INDEXED that lists project roots is a monorepo, not a missing project', () => {
		expect(onboardingState({ configured: true, code: 'CWD_NOT_INDEXED', candidates: ['/repo/a'] })).toBeUndefined();
	});

	test('other codes leave the band empty', () => {
		expect(onboardingState({ configured: true, code: 'API_UNREACHABLE' })).toBeUndefined();
		expect(onboardingState({ configured: true, code: 'MCP_UNAVAILABLE' })).toBeUndefined();
	});
});

describe('storedKey', () => {
	test('runs a login sh with the key emptied and a timeout', async () => {
		const calls: { argv: readonly string[]; init: ProcessRunInit }[] = [];
		const key = await storedKey(async (argv, init) => {
			calls.push({ argv, init });
			return { exitCode: 0, stdout: `${KEY}\n` };
		});
		expect(isKey(key)).toBe(true);
		expect(calls).toEqual([
			{ argv: ['/bin/sh', '-lc', 'printenv CONSTELLATION_ACCESS_KEY'], init: { env: { CONSTELLATION_ACCESS_KEY: '' }, timeoutMs: 5000 } },
		]);
	});

	test('a non-zero exit counts as no key', async () => {
		expect(await storedKey(async () => ({ exitCode: 1, stdout: '' }))).toBeUndefined();
	});

	test('reads the registry when sh cannot start', async () => {
		const argvs: (readonly string[])[] = [];
		const key = await storedKey(async (argv) => {
			argvs.push(argv);
			if (argv[0] === '/bin/sh') throw new Error('cannot start /bin/sh');
			return { exitCode: 0, stdout: `    CONSTELLATION_ACCESS_KEY    REG_SZ    ${KEY}\r\n` };
		});
		expect(isKey(key)).toBe(true);
		expect(argvs[1]).toEqual(['reg', 'query', 'HKCU\\Environment', '/v', 'CONSTELLATION_ACCESS_KEY']);
	});

	test('a timeout counts as no key, with the registry missing too', async () => {
		const key = await storedKey(async (argv) => {
			throw new Error(argv[0] === '/bin/sh' ? 'still running after 5000 ms' : 'cannot start reg');
		});
		expect(key).toBeUndefined();
	});
});

describe('readStoredKeyAtStart', () => {
	test('returns a stored key and the project root for the caller to set before next', async () => {
		resetOnboarding();
		const { ports, seen } = fakePorts({ run: async () => ({ exitCode: 0, stdout: `${KEY}\n` }) });
		const found = await readStoredKeyAtStart(`${REPO}/src`, ports);
		expect(isKey(found?.key)).toBe(true);
		expect(found?.projectRoot).toBe(REPO);
		expect(seen.invalidations).toBe(0);
	});

	test('a project root is null without a constellation.json', async () => {
		resetOnboarding();
		const { ports } = fakePorts({ run: async () => ({ exitCode: 0, stdout: `${KEY}\n` }), exists: (p) => p === `${REPO}/.git` });
		expect((await readStoredKeyAtStart(REPO, ports))?.projectRoot).toBeNull();
	});

	test('no stored key in a git repository puts up not set up and logs one line', async () => {
		const band = loadBand();
		const { ports, seen } = fakePorts({ run: async () => ({ exitCode: 0, stdout: '\n' }) });
		expect(await readStoredKeyAtStart(REPO, ports)).toBeUndefined();
		expect(seen.invalidations).toBe(1);
		expect(seen.logs).toEqual(['>_CONSTELLATION:// not signed in: run constellation auth']);
		expect(shown(await band.draw())).toContain("Constellation isn't signed in");
	});

	test('outside a git repository nothing runs', async () => {
		resetOnboarding();
		let runs = 0;
		const { ports, seen } = fakePorts({
			run: async () => {
				runs += 1;
				return { exitCode: 0, stdout: `${KEY}\n` };
			},
			exists: () => false,
		});
		expect(await readStoredKeyAtStart('/tmp/scratch', ports)).toBeUndefined();
		expect(runs).toBe(0);
		expect(seen.invalidations).toBe(0);
	});

	test('a read-back that times out counts as no key', async () => {
		const band = loadBand();
		const { ports } = fakePorts({
			run: async () => {
				throw new Error('timed out');
			},
		});
		expect(await readStoredKeyAtStart(REPO, ports)).toBeUndefined();
		expect(shown(await band.draw())).toContain("Constellation isn't signed in");
	});
});

describe('checkConnection', () => {
	test('a null project root puts up no project, with no ping', async () => {
		const band = loadBand();
		const { ports, seen } = fakePorts();
		await checkConnection(null, ports);
		expect(seen.pings).toEqual([]);
		expect(seen.invalidations).toBe(1);
		const tree = await band.draw();
		expect(shown(tree)).toContain('Not set up for this project');
	});

	test('an AUTH_ERROR ping reloads the plugins only through after(0)', async () => {
		const band = loadBand();
		const { ports, seen, timers, fire } = fakePorts({ answer: mcpText(failed('AUTH_ERROR')) });
		await checkConnection(REPO, ports);
		expect(seen.pings).toEqual(['return await api.ping()']);
		expect(seen.reloads).toBe(0);
		expect(timers).toHaveLength(1);
		await fire();
		expect(seen.reloads).toBe(1);
		expect(seen.toasts).toEqual(['✦ Constellation connected']);
		expect(await band.draw()).toBe(FALLTHROUGH);
	});

	test('an AUTH_ERROR ping while a sign-in runs leaves the run and its band alone', async () => {
		const band = loadBand();
		const { ports, seen, timers } = fakePorts({ answer: mcpText(failed('AUTH_ERROR')) });
		startTask('auth', ports);
		await checkConnection(REPO, ports);
		expect(timers).toHaveLength(0);
		expect(seen.reloads).toBe(0);
		expect(shown(await band.draw())).toContain('Signing in to Constellation');
		endTask();
	});

	test('a PROJECT_NOT_INDEXED ping puts up not indexed', async () => {
		const band = loadBand();
		const { ports, seen } = fakePorts({ answer: mcpText(failed('PROJECT_NOT_INDEXED')) });
		await checkConnection(REPO, ports);
		expect(seen.reloads).toBe(0);
		expect(keys(await band.draw())).toEqual(['onboarding-dismiss', 'onboarding-index']);
	});

	test('a successful ping leaves the band empty', async () => {
		const band = loadBand();
		const { ports, seen } = fakePorts();
		await checkConnection(REPO, ports);
		expect(seen.invalidations).toBe(0);
		expect(await band.draw()).toBe(FALLTHROUGH);
	});
});

describe('connect', () => {
	test('sets the key, takes the band down and reloads on a timer', async () => {
		const band = loadBand();
		observeCodeIntel(errored('AUTH_ERROR'), () => undefined);
		const { ports, seen, timers, fire } = fakePorts();
		await connect(KEY, ports);
		expect(seen.envSet.map(isKey)).toEqual([true]);
		expect(await band.draw()).toBe(FALLTHROUGH);
		expect(seen.reloads).toBe(0);
		expect(timers).toHaveLength(1);
		await fire();
		expect(seen.reloads).toBe(1);
		expect(seen.toasts).toEqual(['✦ Constellation connected']);
	});
});

describe('observeCodeIntel', () => {
	const observed = async (r: { deny?: string; text?: string }) => {
		const band = loadBand();
		let invalidations = 0;
		observeCodeIntel(r, () => {
			invalidations += 1;
		});
		const tree = await band.draw();
		return { tree, invalidations, text: shown(tree) };
	};

	test('AUTH_ERROR puts up sign in again', async () => {
		const { text, invalidations } = await observed(errored('AUTH_ERROR'));
		expect(text).toContain('Constellation sign-in failed');
		expect(invalidations).toBe(1);
	});

	test('PROJECT_NOT_INDEXED puts up not indexed', async () => {
		expect((await observed(errored('PROJECT_NOT_INDEXED'))).text).toContain("This project isn't indexed yet");
	});

	test('PROJECT_NOT_REGISTERED puts up not registered', async () => {
		expect((await observed(errored('PROJECT_NOT_REGISTERED'))).text).toContain("This project isn't registered with Constellation");
	});

	test('CWD_NOT_INDEXED with no candidates puts up no project', async () => {
		expect((await observed(errored('CWD_NOT_INDEXED', []))).text).toContain('Not set up for this project');
	});

	test('CWD_NOT_INDEXED with candidates is a monorepo and changes nothing', async () => {
		const { tree, invalidations } = await observed(errored('CWD_NOT_INDEXED', ['/work/app/api']));
		expect(tree).toBe(FALLTHROUGH);
		expect(invalidations).toBe(0);
	});

	test('MCP_UNAVAILABLE, other codes and a denied call change nothing', async () => {
		expect((await observed(errored('MCP_UNAVAILABLE'))).tree).toBe(FALLTHROUGH);
		expect((await observed(errored('API_UNREACHABLE'))).tree).toBe(FALLTHROUGH);
		expect((await observed({ deny: 'refused', text: failed('AUTH_ERROR').text })).tree).toBe(FALLTHROUGH);
	});

	test('a success takes down the states an error put up', async () => {
		for (const code of ['AUTH_ERROR', 'PROJECT_NOT_INDEXED', 'PROJECT_NOT_REGISTERED', 'CWD_NOT_INDEXED']) {
			const band = loadBand();
			observeCodeIntel(errored(code, []), () => undefined);
			expect(await band.draw()).not.toBe(FALLTHROUGH);
			observeCodeIntel(OK, () => undefined);
			expect(await band.draw()).toBe(FALLTHROUGH);
		}
	});

	test('a success leaves not set up and working alone', async () => {
		const band = loadBand();
		const { ports } = fakePorts({ run: async () => ({ exitCode: 0, stdout: '' }) });
		await readStoredKeyAtStart(REPO, ports);
		observeCodeIntel(OK, () => undefined);
		expect(shown(await band.draw())).toContain("Constellation isn't signed in");

		const again = loadBand();
		startTask('index', { invalidate: () => undefined });
		observeCodeIntel(OK, () => undefined);
		expect(shown(await again.draw())).toContain('Indexing this project');
		endTask();
	});

	test('with no key set, AUTH_ERROR keeps not set up', async () => {
		const band = loadBand();
		const { ports } = fakePorts({ run: async () => ({ exitCode: 0, stdout: '' }) });
		await readStoredKeyAtStart(REPO, ports);
		observeCodeIntel(errored('AUTH_ERROR'), () => undefined);
		expect(shown(await band.draw())).toContain("Constellation isn't signed in");
	});

	test('a CLI run holds the band: nothing is written while it is live', async () => {
		const band = loadBand();
		let invalidations = 0;
		expect(startTask('auth', { invalidate: () => undefined })).toBeDefined();
		observeCodeIntel(errored('PROJECT_NOT_INDEXED'), () => {
			invalidations += 1;
		});
		expect(invalidations).toBe(0);
		expect(shown(await band.draw())).toContain('Signing in to Constellation');
		endTask();
		observeCodeIntel(errored('PROJECT_NOT_INDEXED'), () => undefined);
		expect(shown(await band.draw())).toContain("This project isn't indexed yet");
	});

	test("called directly, since the kit skips a plugin's own calls in its tool.call hooks, it maps whatever it is given", async () => {
		const { text } = await observed(errored('AUTH_ERROR'));
		expect(text).toContain('Constellation sign-in failed');
	});

	test('logs one line per session where nothing draws, and again after a reset', async () => {
		loadBand();
		const logs: string[] = [];
		const log = async (text: string) => {
			logs.push(text);
		};
		observeCodeIntel(errored('AUTH_ERROR'), () => undefined, log);
		observeCodeIntel(errored('PROJECT_NOT_INDEXED'), () => undefined, log);
		resetOnboarding();
		observeCodeIntel(errored('CWD_NOT_INDEXED'), () => undefined, log);
		expect(logs).toEqual([
			'>_CONSTELLATION:// sign-in failed: run constellation auth',
			'>_CONSTELLATION:// not set up for this project: run constellation init',
		]);
	});
});

describe('startTask', () => {
	test('a second run is refused while the first is live, and a reset does not end it', () => {
		loadBand();
		const generation = startTask('auth', { invalidate: () => undefined });
		expect(generation).toBeDefined();
		expect(startTask('index', { invalidate: () => undefined })).toBeUndefined();
		resetOnboarding();
		expect(startTask('index', { invalidate: () => undefined })).toBeUndefined();
		endTask();
		const next = startTask('index', { invalidate: () => undefined });
		expect(next !== undefined && generation !== undefined && next > generation).toBe(true);
		endTask();
	});
});

describe('band', () => {
	const view = (state: OnboardingState, extra: Partial<BandView> = {}): BandView => ({
		state,
		tint: 'brand',
		dismiss: () => undefined,
		signIn: () => undefined,
		index: () => undefined,
		...extra,
	});
	const draw = (state: OnboardingState, extra: Partial<BandView> = {}) => band(EL as never, view(state, extra));

	test('not set up: gold badge, headline, Dismiss then Sign in', () => {
		const tree = draw('not-set-up');
		expect(shown(tree)).toContain('✦ setup');
		expect(shown(tree)).toContain("Constellation isn't signed in");
		expect(nodes(tree).find((n) => n.props['children'] === '✦ setup')?.props['color']).toBe(palette.solar);
		expect(keys(tree)).toEqual(['onboarding-dismiss', 'onboarding-sign-in']);
		expect(buttons(tree).map((b) => b.props['label'])).toEqual(['Dismiss', 'Sign in']);
	});

	test('sign in again: red badge and Sign in', () => {
		const tree = draw('sign-in-again');
		expect(shown(tree)).toContain('Constellation sign-in failed');
		expect(nodes(tree).find((n) => n.props['children'] === '✦ failed')?.props['color']).toBe(palette.stellar);
		expect(keys(tree)).toEqual(['onboarding-dismiss', 'onboarding-sign-in']);
	});

	test('no project: the init command and the web app link, Dismiss alone', () => {
		const tree = draw('no-project');
		const text = shown(tree);
		expect(text).toContain('Not set up for this project');
		expect(text).toContain('constellation init');
		expect(nodes(tree).find((n) => n.type === 'Link')?.props['href']).toBe('https://app.constellationdev.io');
		expect(keys(tree)).toEqual(['onboarding-dismiss']);
	});

	test('not registered: the projectId check and the web app link, Dismiss alone', () => {
		const tree = draw('not-registered');
		const text = shown(tree);
		expect(text).toContain("This project isn't registered with Constellation");
		expect(text).toContain('Check projectId in constellation.json');
		expect(nodes(tree).find((n) => n.type === 'Link')?.props['href']).toBe('https://app.constellationdev.io');
		expect(nodes(tree).find((n) => n.props['children'] === '✦ failed')?.props['color']).toBe(palette.stellar);
		expect(keys(tree)).toEqual(['onboarding-dismiss']);
	});

	test('not indexed: Dismiss then Index this project', () => {
		const tree = draw('not-indexed');
		expect(shown(tree)).toContain("This project isn't indexed yet");
		expect(buttons(tree).map((b) => b.props['label'])).toEqual(['Dismiss', 'Index this project']);
	});

	test('working: the pending badge and the latest output line, Dismiss alone', () => {
		const tree = draw('working', { task: 'index', detail: 'Uploading 55%' });
		const text = shown(tree);
		expect(text).toContain(`${onboarding.pending.glyph} ${onboarding.pending.word}`);
		expect(text).toContain('Indexing this project');
		expect(text).toContain('Uploading 55%');
		expect(keys(tree)).toEqual(['onboarding-dismiss']);
	});

	test('the none scheme drops every color and keeps the words', () => {
		const tree = draw('sign-in-again', { tint: 'none' });
		expect(nodes(tree).every((n) => n.props['color'] === undefined)).toBe(true);
		expect(shown(tree)).toContain('✦ failed');
	});

	test('buttons carry no color', () => {
		for (const state of ['not-set-up', 'sign-in-again', 'no-project', 'not-registered', 'not-indexed', 'working'] as const) {
			expect(buttons(draw(state)).every((b) => b.props['color'] === undefined)).toBe(true);
		}
	});
});

describe('the band above the prompt', () => {
	test('draws above the prompt only', () => {
		expect(loadBand().matcher).toEqual({ component: 'AbovePrompt' });
	});

	test('passes with no state, and while a survey holds the band', async () => {
		const band = loadBand();
		expect(await band.draw()).toBe(FALLTHROUGH);
		observeCodeIntel(errored('AUTH_ERROR'), () => undefined);
		expect(await band.draw({ hasSurvey: true })).toBe(FALLTHROUGH);
		expect(await band.draw()).not.toBe(FALLTHROUGH);
	});

	test('each state draws its message and actions', async () => {
		const cases: [() => void | Promise<void>, string, string[]][] = [
			[
				async () => {
					await readStoredKeyAtStart(REPO, fakePorts({ run: async () => ({ exitCode: 1, stdout: '' }) }).ports);
				},
				"Constellation isn't signed in",
				['onboarding-dismiss', 'onboarding-sign-in'],
			],
			[() => observeCodeIntel(errored('AUTH_ERROR'), () => undefined), 'Constellation sign-in failed', ['onboarding-dismiss', 'onboarding-sign-in']],
			[() => checkConnection(null, fakePorts().ports), 'Not set up for this project', ['onboarding-dismiss']],
			[
				() => observeCodeIntel(errored('PROJECT_NOT_REGISTERED'), () => undefined),
				"This project isn't registered with Constellation",
				['onboarding-dismiss'],
			],
			[() => observeCodeIntel(errored('PROJECT_NOT_INDEXED'), () => undefined), "This project isn't indexed yet", ['onboarding-dismiss', 'onboarding-index']],
			[
				() => {
					startTask('auth', { invalidate: () => undefined });
				},
				'Signing in to Constellation',
				['onboarding-dismiss'],
			],
		];
		for (const [put, message, actions] of cases) {
			const band = loadBand();
			await put();
			const tree = await band.draw();
			expect(shown(tree)).toContain(message);
			expect(keys(tree)).toEqual(actions);
			endTask();
		}
	});

	test('the theme row and the colors option pick the scheme', async () => {
		const light = loadBand({ colors: 'none' });
		observeCodeIntel(errored('AUTH_ERROR'), () => undefined);
		expect(nodes(await light.draw()).every((n) => n.props['color'] === undefined)).toBe(true);
	});

	test('Dismiss hides the band for the repository until a different state comes', async () => {
		const band = loadBand();
		observeCodeIntel(errored('AUTH_ERROR'), () => undefined);
		await band.press(await band.draw(), 'onboarding-dismiss');
		expect(band.store.get(`onboarding-dismissed:${REPO}`)).toBe('sign-in-again');
		expect(band.seen.invalidations).toBe(1);
		expect(await band.draw()).toBe(FALLTHROUGH);
		observeCodeIntel(errored('PROJECT_NOT_INDEXED'), () => undefined);
		expect(shown(await band.draw())).toContain("This project isn't indexed yet");
	});

	test('an unavailable store shows the band', async () => {
		const band = loadBand();
		observeCodeIntel(errored('AUTH_ERROR'), () => undefined);
		band.flags.storeDown = true;
		expect(shown(await band.draw())).toContain('Constellation sign-in failed');
	});
});

describe('the band as a loaded plugin', () => {
	const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 80, scroll: { offset: 0, bodyRows: 11 }, view: {} };

	/**
	 * Answers what the plugin reads beneath it: the git walk, `surfaces`, the
	 * theme, a stored key the CLI never wrote, and code_intel by `answer.next`.
	 * `signedIn: false` starts the session with no key set.
	 */
	function world(on: On, { surfaces = ['terminal'], signedIn = true }: { surfaces?: readonly RenderSurface[]; signedIn?: boolean } = {}) {
		const answer = { next: errored('AUTH_ERROR') };
		const logs: string[] = [];
		const toasts: string[] = [];
		mock.env(on, signedIn ? { CONSTELLATION_ACCESS_KEY: KEY } : {});
		mock.store(on);
		on('fs.exists', (_$, e) => ({ value: e.path === `${REPO}/.git` || e.path === '/work/other/.git' }));
		on('process.run', () => ({ value: { exitCode: 0, stdout: '\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }));
		on('session.surfaces', () => ({ value: surfaces }));
		on('session.start', (_$, e) => ({ cwd: e.cwd }));
		on('command.register', (_$, e) => ({ value: { command: e.name } }));
		on('ui.log', (_$, e) => {
			logs.push(e.text);
			return { value: undefined };
		});
		on('ui.toast', (_$, e) => {
			toasts.push(e.text);
			return { value: undefined };
		});
		on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'fallthrough' }));
		on('tool.call', () => ({ isError: true as const, result: answer.next.text, text: answer.next.text }));
		return { answer, logs, toasts };
	}

	test('a dismissal persists per repository and a new error shows the band again', async ($, on) => {
		const { answer, logs, toasts } = world(on);
		await $.session.start({ cwd: REPO, surface: 'terminal', isInteractive: true });
		await $.tool.call({ tool: CODE_INTEL, tool_use_id: 'u1' });

		for (const surface of ['terminal', 'desktop'] as const) {
			const ui = await $.ui.mount({ plugin: 'constellation', surface, component: 'AbovePrompt', props: BAND_PROPS });
			expect(await ui.find({ type: 'Text', text: 'Constellation sign-in failed' })).toBeDefined();
			expect(await ui.find({ type: 'Button', key: 'onboarding-sign-in' })).toBeDefined();
			await ui.unmount();
		}

		const ui = await $.ui.mount({ plugin: 'constellation', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS });
		await ui.press({ key: 'onboarding-dismiss' });
		await ui.unmount();
		const hidden = await $.ui.mount({ plugin: 'constellation', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS });
		expect(await hidden.find({ type: 'Text', text: 'fallthrough' })).toBeDefined();
		await hidden.unmount();

		answer.next = errored('CWD_NOT_INDEXED', []);
		await $.tool.call({ tool: CODE_INTEL, tool_use_id: 'u2' });
		const again = await $.ui.mount({ plugin: 'constellation', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS });
		expect(await again.find({ type: 'Text', text: 'Not set up for this project' })).toBeDefined();
		expect(await again.find({ type: 'Link' })).toBeDefined();
		const drawn = (await again.findAll({ type: 'Text' })).map((t) => t.text).join('\n');
		await again.unmount();

		// Another repository does not share the first one's dismissal.
		await $.session.start({ cwd: '/work/other', surface: 'terminal', isInteractive: true });
		answer.next = errored('AUTH_ERROR');
		await $.tool.call({ tool: CODE_INTEL, tool_use_id: 'u3' });
		const other = await $.ui.mount({ plugin: 'constellation', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS });
		expect(await other.find({ type: 'Text', text: 'Constellation sign-in failed' })).toBeDefined();
		await other.unmount();

		expect([...logs, ...toasts, drawn].some((line) => line.includes(KEY))).toBe(false);
	});

	for (const surfaces of [[], ['vscode']] as const) {
		test(`on ${surfaces.join() || 'no surface'} the agent's code_intel errors log one line`, async ($, on) => {
			const { answer, logs } = world(on, { surfaces });
			await $.session.start({ cwd: REPO, surface: null, isInteractive: false });
			await $.tool.call({ tool: CODE_INTEL, tool_use_id: 'u1' });
			answer.next = errored('PROJECT_NOT_INDEXED');
			await $.tool.call({ tool: CODE_INTEL, tool_use_id: 'u2' });
			await settle();
			expect(logs).toEqual(['>_CONSTELLATION:// sign-in failed: run constellation auth']);
		});

		test(`on ${surfaces.join() || 'no surface'} a session start with no key logs one line`, async ($, on) => {
			const { logs } = world(on, { surfaces, signedIn: false });
			await $.session.start({ cwd: REPO, surface: null, isInteractive: false });
			await settle();
			expect(logs).toEqual(['>_CONSTELLATION:// not signed in: run constellation auth']);
		});
	}

	test("on the terminal the agent's code_intel errors draw the band and log nothing", async ($, on) => {
		const { answer, logs } = world(on);
		await $.session.start({ cwd: REPO, surface: 'terminal', isInteractive: true });
		await $.tool.call({ tool: CODE_INTEL, tool_use_id: 'u1' });
		answer.next = errored('PROJECT_NOT_INDEXED');
		await $.tool.call({ tool: CODE_INTEL, tool_use_id: 'u2' });
		await settle();
		expect(logs).toEqual([]);
		const ui = await $.ui.mount({ plugin: 'constellation', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS });
		expect(await ui.find({ type: 'Text', text: "This project isn't indexed yet" })).toBeDefined();
		await ui.unmount();
	});

	test('on the terminal a session start with no key draws the band and logs nothing', async ($, on) => {
		const { logs } = world(on, { signedIn: false });
		await $.session.start({ cwd: REPO, surface: 'terminal', isInteractive: true });
		await settle();
		expect(logs).toEqual([]);
		const ui = await $.ui.mount({ plugin: 'constellation', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS });
		expect(await ui.find({ type: 'Text', text: "Constellation isn't signed in" })).toBeDefined();
		await ui.unmount();
	});
});

const CLI = '/usr/local/bin/constellation';
const INIT_HINT = '✦ Constellation connected. Run constellation init in this repo to set it up';
const MANUAL = 'https://app.constellationdev.io/auth/cli?callback_port=5555&state=abc';

/** Lets every chain of resolved promises a press started run to its end. */
async function settle(): Promise<void> {
	for (let i = 0; i < 200; i++) await Promise.resolve();
}

/** A promise the test resolves: a child held open until then. */
function gate() {
	let open: () => void = () => undefined;
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

/**
 * The host a button's run reads: each `printenv` read-back answers the next of
 * `keys` (none when it is undefined or used up), `command -v` and `where` name
 * `cli` (null: not installed), and `sh: false` is a host with no `/bin/sh`.
 */
function host(world: { keys?: (string | undefined)[]; cli?: string | null; sh?: boolean } = {}) {
	const keys = [...(world.keys ?? [])];
	const cli = world.cli === undefined ? CLI : world.cli;
	const argvs: (readonly string[])[] = [];
	const run: Run = async (argv) => {
		argvs.push(argv);
		if (argv[0] === '/bin/sh' && world.sh === false) throw new Error('cannot start /bin/sh');
		if (argv[2] === 'printenv CONSTELLATION_ACCESS_KEY') return { exitCode: 0, stdout: `${keys.shift() ?? ''}\n` };
		if (argv[2] === 'command -v constellation') return cli === null ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: `${cli}\n` };
		if (argv[0] === 'where') return cli === null ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: `${cli}\r\n` };
		if (argv[0] === 'reg') {
			const key = keys.shift();
			return key === undefined ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: `    CONSTELLATION_ACCESS_KEY    REG_SZ    ${key}\r\n` };
		}
		throw new Error(`unexpected command ${argv[0]}`);
	};
	const readBacks = () => argvs.filter((argv) => argv[2] === 'printenv CONSTELLATION_ACCESS_KEY' || argv[0] === 'reg').length;
	return { run, argvs, readBacks };
}

/** A spawned child: what it prints, its exit code, a failure to start, and a gate that holds it open. */
type Child = { chunks?: ProcessSpawnChunk[]; code?: number; fail?: boolean; hold?: Promise<void> };
const out = (text: string): ProcessSpawnChunk => ({ stream: 'stdout', text });
const err = (text: string): ProcessSpawnChunk => ({ stream: 'stderr', text });

async function* child(c: Child): AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult> {
	if (c.fail === true) throw new Error('cannot start');
	for (const chunk of c.chunks ?? []) yield chunk;
	await c.hold;
	return { code: c.code ?? 0, signal: null };
}

/** The fake ports with a spawn that records each request and runs `world.child`. */
function buttonPorts(world: { answer?: McpToolResult; run?: Run; exists?: (p: string) => boolean; child?: Child } = {}) {
	const base = fakePorts(world);
	const spawns: ProcessSpawnRequest[] = [];
	const ports: ButtonPorts = {
		...base.ports,
		spawn: (request) => {
			spawns.push(request);
			return child(world.child ?? {});
		},
		cwd: async () => REPO,
	};
	return { ...base, ports, spawns };
}

/** The `$` members a pressed button reaches through the render hook, for `loadBand`. */
function buttonWorld(run: Run, c: Child = {}) {
	const spawns: ProcessSpawnRequest[] = [];
	const world = {
		process: {
			run: (argv: readonly string[], init?: ProcessRunInit) => run(argv, init ?? {}),
			spawn: (request: ProcessSpawnRequest) => {
				spawns.push(request);
				return child(c);
			},
		},
		fs: { exists: async (p: string) => p === `${REPO}/.git` || p === `${REPO}/constellation.json` },
		env: { set: async () => undefined },
		clock: { after: () => undefined },
		mcp: { connect: async () => ({ isConnected: true, server: 's' }), call: async () => mcpText(OK) },
		command: { run: async () => ({}) },
	};
	return { world, spawns };
}

const stellarBadge = (tree: unknown) => nodes(tree).find((n) => n.props['children'] === '✦ failed')?.props['color'];

describe('cliPath', () => {
	test('a login sh finds the CLI on the PATH its profile sets, with a timeout', async () => {
		const calls: { argv: readonly string[]; init: ProcessRunInit }[] = [];
		const found = await cliPath(async (argv, init) => {
			calls.push({ argv, init });
			return { exitCode: 0, stdout: `Welcome back\n${CLI}\n` };
		});
		expect(found).toEqual({ path: CLI, shell: true });
		expect(calls).toEqual([{ argv: ['/bin/sh', '-lc', 'command -v constellation'], init: { timeoutMs: 5000 } }]);
	});

	test('not found by sh is missing, and where is not asked', async () => {
		const { run, argvs } = host({ cli: null });
		expect(await cliPath(run)).toEqual({ path: undefined, shell: true });
		expect(argvs).toHaveLength(1);
	});

	test('where names it when sh cannot start, its first line taken', async () => {
		const found = await cliPath(async (argv) => {
			if (argv[0] === '/bin/sh') throw new Error('cannot start /bin/sh');
			return { exitCode: 0, stdout: '\r\nC:\\npm\\constellation.cmd\r\nC:\\npm\\constellation\r\n' };
		});
		expect(found).toEqual({ path: 'C:\\npm\\constellation.cmd', shell: false });
	});

	test('nothing that can look counts as missing', async () => {
		const found = await cliPath(async () => {
			throw new Error('cannot start');
		});
		expect(found).toEqual({ path: undefined, shell: false });
	});
});

describe('the Sign in button', () => {
	test('spawns constellation auth with the inherited key emptied and no color', async () => {
		const { world, spawns } = buttonWorld(host().run, { chunks: [out('Opening browser for authentication...\n')] });
		const band = loadBand({}, new Map(), world);
		observeCodeIntel(errored('AUTH_ERROR'), () => undefined);
		await band.press(await band.draw(), 'onboarding-sign-in');
		await settle();
		expect(spawns).toEqual([{ argv: [CLI, 'auth'], env: { CONSTELLATION_ACCESS_KEY: '', NO_COLOR: '1' } }]);
	});

	test('an exit 0 with the stored key unchanged shows the stellar error and the last line', async () => {
		const band = loadBand();
		const { ports, seen, timers } = buttonPorts({
			run: host({ keys: [KEY, KEY] }).run,
			child: { chunks: [out('Opening browser for authentication...\n'), err('Waiting for authentication...\n')], code: 0 },
		});
		await startSignIn(ports);
		await settle();
		const tree = await band.draw();
		expect(shown(tree)).toContain('Constellation sign-in failed');
		expect(shown(tree)).toContain('Waiting for authentication...');
		expect(stellarBadge(tree)).toBe(palette.stellar);
		expect(keys(tree)).toEqual(['onboarding-dismiss', 'onboarding-sign-in']);
		expect(seen.envSet).toEqual([]);
		expect(timers).toHaveLength(0);
	});

	test('a spawn that cannot start is a failure, with no read-back after it', async () => {
		const band = loadBand();
		const { run, readBacks } = host({ keys: [undefined, KEY] });
		const { ports, seen } = buttonPorts({ run, child: { fail: true } });
		await startSignIn(ports);
		await settle();
		expect(readBacks()).toBe(1);
		expect(seen.envSet).toEqual([]);
		const text = shown(await band.draw());
		expect(text).toContain('Constellation sign-in failed');
		expect(text).toContain('Run `constellation auth` in a terminal');
	});

	test('a new stored key sets the env, takes the band down and reloads only through after(0)', async () => {
		const band = loadBand();
		observeCodeIntel(errored('AUTH_ERROR'), () => undefined);
		const { ports, seen, timers, fire } = buttonPorts({ run: host({ keys: [undefined, KEY] }).run, child: { code: 1 } });
		await startSignIn(ports);
		await settle();
		expect(seen.envSet.map(isKey)).toEqual([true]);
		expect(seen.reloads).toBe(0);
		expect(timers).toHaveLength(1);
		expect(await band.draw()).toBe(FALLTHROUGH);
		await fire();
		expect(seen.reloads).toBe(1);
		expect(seen.toasts).toEqual(['✦ Constellation connected']);
	});

	test('a new key with no project toasts the init hint before the reload, and only that', async () => {
		loadBand();
		const { ports, seen, timers, fire } = buttonPorts({
			run: host({ keys: [undefined, KEY] }).run,
			exists: (p) => p === `${REPO}/.git`,
		});
		await startSignIn(ports);
		await settle();
		expect(seen.toasts).toEqual([INIT_HINT]);
		expect(seen.reloads).toBe(0);
		expect(timers).toHaveLength(1);
		await fire();
		expect(seen.reloads).toBe(1);
		expect(seen.toasts).toEqual([INIT_HINT]);
	});

	test('while it runs the band says so with no Sign in, and the manual URL is a Link', async () => {
		const band = loadBand();
		observeCodeIntel(errored('AUTH_ERROR'), () => undefined);
		const held = gate();
		const printed = `Could not open browser automatically.\n  Please open this URL manually:\n\n    ${MANUAL}\n`;
		const { ports } = buttonPorts({ run: host().run, child: { chunks: [err(printed)], hold: held.promise } });
		await startSignIn(ports);
		await settle();
		const tree = await band.draw();
		expect(shown(tree)).toContain('Signing in to Constellation');
		expect(keys(tree)).toEqual(['onboarding-dismiss']);
		const link = nodes(tree).find((n) => n.type === 'Link');
		expect(link?.props).toEqual({ href: MANUAL, label: MANUAL });
		held.open();
		await settle();
		expect(nodes(await band.draw()).some((n) => n.type === 'Link')).toBe(false);
	});

	test('a URL still being written is not offered', async () => {
		const band = loadBand();
		observeCodeIntel(errored('AUTH_ERROR'), () => undefined);
		const held = gate();
		const { ports } = buttonPorts({
			run: host().run,
			child: { chunks: [err('Please open this URL manually:\n\n    https://app.constellationdev.io/auth/cli?callback_po')], hold: held.promise },
		});
		await startSignIn(ports);
		await settle();
		expect(nodes(await band.draw()).some((n) => n.type === 'Link')).toBe(false);
		held.open();
		await settle();
	});

	test('where no login sh runs, a failure says to run constellation auth in a terminal', async () => {
		const band = loadBand();
		const { ports, spawns } = buttonPorts({
			run: host({ sh: false, keys: [undefined, undefined], cli: 'C:\\npm\\constellation.cmd' }).run,
			child: { chunks: [out('Opening browser for authentication...\n')] },
		});
		await startSignIn(ports);
		await settle();
		expect(spawns[0]?.argv).toEqual(['C:\\npm\\constellation.cmd', 'auth']);
		const text = shown(await band.draw());
		expect(text).toContain('Run `constellation auth` in a terminal');
		expect(text).not.toContain('Opening browser');
	});

	test('a second press is refused while the child is live, and a loop that ends after a reset does nothing', async () => {
		const band = loadBand();
		observeCodeIntel(errored('AUTH_ERROR'), () => undefined);
		const held = gate();
		const { run, readBacks } = host({ keys: [undefined, KEY, undefined, undefined] });
		const { ports, seen, timers, spawns } = buttonPorts({ run, child: { hold: held.promise } });
		await startSignIn(ports);
		await startSignIn(ports);
		await startIndex(ports);
		expect(spawns).toHaveLength(1);
		resetOnboarding();
		held.open();
		await settle();
		expect(readBacks()).toBe(1);
		expect(seen.envSet).toEqual([]);
		expect(timers).toHaveLength(0);
		expect(await band.draw()).toBe(FALLTHROUGH);
		observeCodeIntel(errored('AUTH_ERROR'), () => undefined);
		await startSignIn(ports);
		await settle();
		expect(spawns).toHaveLength(2);
	});

	test('a missing CLI shows the install hint and spawns nothing, and a press after installing runs', async () => {
		const band = loadBand();
		observeCodeIntel(errored('AUTH_ERROR'), () => undefined);
		const installed = { cli: null as string | null };
		const run: Run = (argv, init) => host({ cli: installed.cli }).run(argv, init);
		const { ports, spawns } = buttonPorts({ run });
		await startSignIn(ports);
		await settle();
		expect(spawns).toEqual([]);
		const tree = await band.draw();
		expect(shown(tree)).toContain('Constellation sign-in failed');
		expect(shown(tree)).toContain('npm i -g @constellationdev/cli');
		expect(nodes(tree).find((n) => n.type === 'Link')?.props['href']).toBe('https://docs.constellationdev.io/cli/#installation');
		expect(keys(tree)).toEqual(['onboarding-dismiss', 'onboarding-sign-in']);
		installed.cli = CLI;
		await startSignIn(ports);
		await settle();
		expect(spawns).toHaveLength(1);
		expect(shown(await band.draw())).not.toContain('npm i -g');
	});
});

describe('the Index button', () => {
	test('spawns constellation index --wait in the project root, with no --dirty', async () => {
		const { world, spawns } = buttonWorld(host().run, { chunks: [out('Indexing...\n')] });
		const band = loadBand({}, new Map(), world);
		observeCodeIntel(errored('PROJECT_NOT_INDEXED'), () => undefined);
		await band.press(await band.draw(), 'onboarding-index');
		await settle();
		expect(spawns).toEqual([{ argv: [CLI, 'index', '--wait'], cwd: REPO, env: { NO_COLOR: '1' } }]);
		expect(spawns[0]?.argv.includes('--dirty')).toBe(false);
	});

	test('an exit 1 with a successful ping takes the band down and says so', async () => {
		const band = loadBand();
		observeCodeIntel(errored('PROJECT_NOT_INDEXED'), () => undefined);
		const { ports, seen } = buttonPorts({ run: host().run, child: { chunks: [err('Upload failed\n')], code: 1 } });
		await startIndex(ports);
		await settle();
		expect(seen.pings).toEqual(['return await api.ping()']);
		expect(await band.draw()).toBe(FALLTHROUGH);
		expect(seen.toasts).toEqual(['✦ Constellation indexed this project']);
	});

	test('an exit 0 with PROJECT_NOT_INDEXED stays not indexed, with the last line', async () => {
		const band = loadBand();
		observeCodeIntel(errored('PROJECT_NOT_INDEXED'), () => undefined);
		const { ports, seen } = buttonPorts({
			run: host().run,
			answer: mcpText(failed('PROJECT_NOT_INDEXED')),
			child: { chunks: [out('Uploading 10%\rUploading 100%\n'), out('Waiting for indexing\n')], code: 0 },
		});
		await startIndex(ports);
		await settle();
		const tree = await band.draw();
		expect(shown(tree)).toContain("This project isn't indexed yet");
		expect(shown(tree)).toContain('Waiting for indexing');
		expect(keys(tree)).toEqual(['onboarding-dismiss', 'onboarding-index']);
		expect(seen.toasts).toEqual([]);
	});

	test('Project not registered in the output with PROJECT_NOT_INDEXED says not registered', async () => {
		const band = loadBand();
		observeCodeIntel(errored('PROJECT_NOT_INDEXED'), () => undefined);
		const { ports } = buttonPorts({
			run: host().run,
			answer: mcpText(failed('PROJECT_NOT_INDEXED')),
			child: { chunks: [err('✗ Project not registered\n'), out('  is not associated with your Constellation account.\n')], code: 1 },
		});
		await startIndex(ports);
		await settle();
		const tree = await band.draw();
		expect(shown(tree)).toContain("This project isn't registered with Constellation");
		expect(keys(tree)).toEqual(['onboarding-dismiss']);
	});

	test('a loop that ends after a reset neither pings nor writes the band', async () => {
		const band = loadBand();
		observeCodeIntel(errored('PROJECT_NOT_INDEXED'), () => undefined);
		const held = gate();
		const { ports, seen, spawns } = buttonPorts({ run: host().run, child: { chunks: [out('Indexing...\n')], hold: held.promise } });
		await startIndex(ports);
		await startIndex(ports);
		expect(spawns).toHaveLength(1);
		resetOnboarding();
		held.open();
		await settle();
		expect(seen.pings).toEqual([]);
		expect(seen.toasts).toEqual([]);
		expect(await band.draw()).toBe(FALLTHROUGH);
	});

	test('with no constellation.json above the session directory nothing spawns, and the band says where to run it', async () => {
		const band = loadBand();
		observeCodeIntel(errored('PROJECT_NOT_INDEXED'), () => undefined);
		const { ports, spawns } = buttonPorts({ run: host().run, exists: (p) => p === `${REPO}/.git` });
		await startIndex(ports);
		await settle();
		expect(spawns).toEqual([]);
		const text = shown(await band.draw());
		expect(text).toContain("This project isn't indexed yet");
		expect(text).toContain('Run `constellation index` in a terminal, in the project directory');
	});

	test('a missing CLI shows the install hint and spawns nothing', async () => {
		const band = loadBand();
		observeCodeIntel(errored('PROJECT_NOT_INDEXED'), () => undefined);
		const { ports, spawns } = buttonPorts({ run: host({ cli: null }).run });
		await startIndex(ports);
		await settle();
		expect(spawns).toEqual([]);
		const tree = await band.draw();
		expect(shown(tree)).toContain('npm i -g @constellationdev/cli');
		expect(keys(tree)).toEqual(['onboarding-dismiss', 'onboarding-index']);
	});
});

describe('states with no button', () => {
	test('no project and not registered offer only Dismiss, and nothing spawns', async () => {
		for (const put of [
			() => checkConnection(null, fakePorts().ports),
			async () => observeCodeIntel(errored('PROJECT_NOT_REGISTERED'), () => undefined),
		]) {
			const { world, spawns } = buttonWorld(host().run);
			const band = loadBand({}, new Map(), world);
			await put();
			const tree = await band.draw();
			expect(keys(tree)).toEqual(['onboarding-dismiss']);
			await band.press(tree, 'onboarding-dismiss');
			await settle();
			expect(spawns).toEqual([]);
		}
	});
});

describe('Sign in as a loaded plugin', () => {
	test('the press spawns the CLI, sets the new key and reloads on the clock', async ($, on) => {
		mock.env(on, {});
		mock.store(on);
		const clock = mock.clock(on);
		const keys: (string | undefined)[] = [undefined, undefined, KEY];
		const spawned: ProcessSpawnRequest[] = [];
		const commands: string[] = [];
		const toasts: string[] = [];
		let setKey: string | undefined;
		on('fs.exists', (_$, e) => ({ value: e.path === `${REPO}/.git` || e.path === `${REPO}/constellation.json` }));
		on('process.run', (_$, e) => {
			if (e.argv[2] === 'command -v constellation') {
				return { value: { exitCode: 0, stdout: `${CLI}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } };
			}
			return { value: { exitCode: 0, stdout: `${keys.shift() ?? ''}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } };
		});
		on('process.spawn', async function* (_$, e) {
			spawned.push(e);
			yield { stream: 'stdout' as const, text: 'Opening browser for authentication...\n' };
			return { value: { code: 0, signal: null } };
		});
		on('env.set', (_$, e) => {
			setKey = e.value;
			return { value: undefined };
		});
		on('command.run', (_$, e) => {
			commands.push(e.command);
			return {};
		});
		on('ui.toast', (_$, e) => {
			toasts.push(e.text);
			return { value: undefined };
		});
		on('session.start', (_$, e) => ({ cwd: e.cwd }));
		on('session.surfaces', () => ({ value: ['terminal'] }));
		on('command.register', (_$, e) => ({ value: { command: e.name } }));
		on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'fallthrough' }));
		await $.session.start({ cwd: REPO, surface: 'terminal', isInteractive: true });
		const props = { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 80, scroll: { offset: 0, bodyRows: 11 }, view: {} };
		const ui = await $.ui.mount({ plugin: 'constellation', surface: 'terminal', component: 'AbovePrompt', props });
		expect(await ui.find({ type: 'Text', text: "Constellation isn't signed in" })).toBeDefined();
		// The press settles with the child's loop; the reload waits on the clock.
		await ui.press({ key: 'onboarding-sign-in' });
		await ui.unmount();
		expect(spawned.map((e) => e.argv)).toEqual([[CLI, 'auth']]);
		expect(isKey(setKey)).toBe(true);
		expect(commands).toEqual([]);
		await clock.advance(0);
		expect(commands).toEqual(['reload-plugins']);
		expect(toasts.some((t) => t.includes(KEY))).toBe(false);
	});
});

describe('the key stays out of what is shown', () => {
	test('no log, toast or drawn text holds the key through start, ping, reload and every state', async () => {
		const band = loadBand();
		const { ports, seen, fire } = fakePorts({ run: async () => ({ exitCode: 0, stdout: `noise ${KEY}\n${KEY}\n` }), answer: mcpText(failed('AUTH_ERROR')) });
		const found = await readStoredKeyAtStart(REPO, ports);
		if (found === undefined) throw new Error('no key found');
		await ports.envSet(found.key);
		await checkConnection(found.projectRoot, ports);
		await fire();
		const drawn: string[] = [];
		for (const code of ['AUTH_ERROR', 'PROJECT_NOT_INDEXED', 'PROJECT_NOT_REGISTERED', 'CWD_NOT_INDEXED']) {
			observeCodeIntel(errored(code, []), () => undefined, ports.log);
			drawn.push(shown(await band.draw()));
		}
		const everything = [...seen.logs, ...seen.toasts, ...band.seen.logs, ...band.seen.toasts, ...drawn];
		expect(everything.length > 0).toBe(true);
		expect(everything.some((line) => line.includes(KEY) || line.includes(KEY.slice(3)))).toBe(false);
	});

	test('no toast, log or drawn text holds the key through a failed and a successful sign-in', async () => {
		const drawn: string[] = [];
		const band = loadBand();
		observeCodeIntel(errored('AUTH_ERROR'), () => undefined);
		const unchanged = buttonPorts({ run: host({ keys: [KEY, KEY] }).run, child: { chunks: [out('Waiting for authentication...\n')] } });
		await startSignIn(unchanged.ports);
		await settle();
		drawn.push(shown(await band.draw()));
		const again = loadBand();
		observeCodeIntel(errored('AUTH_ERROR'), () => undefined);
		const held = gate();
		const signedIn = buttonPorts({
			run: host({ keys: [undefined, KEY] }).run,
			exists: (p) => p === `${REPO}/.git`,
			child: { chunks: [out('Opening browser for authentication...\n')], hold: held.promise },
		});
		await startSignIn(signedIn.ports);
		await settle();
		drawn.push(shown(await again.draw()));
		held.open();
		await settle();
		await signedIn.fire();
		expect(isKey(signedIn.seen.envSet[0])).toBe(true);
		const everything = [
			...unchanged.seen.logs,
			...unchanged.seen.toasts,
			...signedIn.seen.logs,
			...signedIn.seen.toasts,
			...band.seen.logs,
			...band.seen.toasts,
			...again.seen.logs,
			...again.seen.toasts,
			...drawn,
		];
		expect(everything.length > 0).toBe(true);
		expect(everything.some((line) => line.includes(KEY) || line.includes(KEY.slice(3)))).toBe(false);
	});
});
