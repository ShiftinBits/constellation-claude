import type { McpToolResult, On, PluginOptions, ProcessRunInit } from 'claude-code';
import { describe, expect, mock, test } from 'claude-code/testing';
import {
	KEY_PATTERN,
	NOT_REGISTERED_OUTPUT,
	band,
	checkConnection,
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
	startTask,
	storedKey,
} from './onboarding';
import type { BandView, OnboardingPorts, OnboardingState, Run } from './onboarding';
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
function loadBand(options: PluginOptions = {}, store = new Map<string, unknown>()) {
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
		observeCodeIntel(failed('AUTH_ERROR'), () => undefined);
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
		const { text, invalidations } = await observed(failed('AUTH_ERROR'));
		expect(text).toContain('Constellation sign-in failed');
		expect(invalidations).toBe(1);
	});

	test('PROJECT_NOT_INDEXED puts up not indexed', async () => {
		expect((await observed(failed('PROJECT_NOT_INDEXED'))).text).toContain("This project isn't indexed yet");
	});

	test('PROJECT_NOT_REGISTERED puts up not registered', async () => {
		expect((await observed(failed('PROJECT_NOT_REGISTERED'))).text).toContain("This project isn't registered with Constellation");
	});

	test('CWD_NOT_INDEXED with no candidates puts up no project', async () => {
		expect((await observed(failed('CWD_NOT_INDEXED', []))).text).toContain('Not set up for this project');
	});

	test('CWD_NOT_INDEXED with candidates is a monorepo and changes nothing', async () => {
		const { tree, invalidations } = await observed(failed('CWD_NOT_INDEXED', ['/work/app/api']));
		expect(tree).toBe(FALLTHROUGH);
		expect(invalidations).toBe(0);
	});

	test('MCP_UNAVAILABLE, other codes and a denied call change nothing', async () => {
		expect((await observed(failed('MCP_UNAVAILABLE'))).tree).toBe(FALLTHROUGH);
		expect((await observed(failed('API_UNREACHABLE'))).tree).toBe(FALLTHROUGH);
		expect((await observed({ deny: 'refused', text: failed('AUTH_ERROR').text })).tree).toBe(FALLTHROUGH);
	});

	test('a success takes down the states an error put up', async () => {
		for (const code of ['AUTH_ERROR', 'PROJECT_NOT_INDEXED', 'PROJECT_NOT_REGISTERED', 'CWD_NOT_INDEXED']) {
			const band = loadBand();
			observeCodeIntel(failed(code, []), () => undefined);
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
		observeCodeIntel(failed('AUTH_ERROR'), () => undefined);
		expect(shown(await band.draw())).toContain("Constellation isn't signed in");
	});

	test('a CLI run holds the band: nothing is written while it is live', async () => {
		const band = loadBand();
		let invalidations = 0;
		expect(startTask('auth', { invalidate: () => undefined })).toBeDefined();
		observeCodeIntel(failed('PROJECT_NOT_INDEXED'), () => {
			invalidations += 1;
		});
		expect(invalidations).toBe(0);
		expect(shown(await band.draw())).toContain('Signing in to Constellation');
		endTask();
		observeCodeIntel(failed('PROJECT_NOT_INDEXED'), () => undefined);
		expect(shown(await band.draw())).toContain("This project isn't indexed yet");
	});

	test("called directly, since the kit skips a plugin's own calls in its tool.call hooks, it maps whatever it is given", async () => {
		const { text } = await observed(failed('AUTH_ERROR'));
		expect(text).toContain('Constellation sign-in failed');
	});

	test('logs one line per session where nothing draws, and again after a reset', async () => {
		loadBand();
		const logs: string[] = [];
		const log = async (text: string) => {
			logs.push(text);
		};
		observeCodeIntel(failed('AUTH_ERROR'), () => undefined, log);
		observeCodeIntel(failed('PROJECT_NOT_INDEXED'), () => undefined, log);
		resetOnboarding();
		observeCodeIntel(failed('CWD_NOT_INDEXED'), () => undefined, log);
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
		observeCodeIntel(failed('AUTH_ERROR'), () => undefined);
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
			[() => observeCodeIntel(failed('AUTH_ERROR'), () => undefined), 'Constellation sign-in failed', ['onboarding-dismiss', 'onboarding-sign-in']],
			[() => checkConnection(null, fakePorts().ports), 'Not set up for this project', ['onboarding-dismiss']],
			[
				() => observeCodeIntel(failed('PROJECT_NOT_REGISTERED'), () => undefined),
				"This project isn't registered with Constellation",
				['onboarding-dismiss'],
			],
			[() => observeCodeIntel(failed('PROJECT_NOT_INDEXED'), () => undefined), "This project isn't indexed yet", ['onboarding-dismiss', 'onboarding-index']],
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
		observeCodeIntel(failed('AUTH_ERROR'), () => undefined);
		expect(nodes(await light.draw()).every((n) => n.props['color'] === undefined)).toBe(true);
	});

	test('Dismiss hides the band for the repository until a different state comes', async () => {
		const band = loadBand();
		observeCodeIntel(failed('AUTH_ERROR'), () => undefined);
		await band.press(await band.draw(), 'onboarding-dismiss');
		expect(band.store.get(`onboarding-dismissed:${REPO}`)).toBe('sign-in-again');
		expect(band.seen.invalidations).toBe(1);
		expect(await band.draw()).toBe(FALLTHROUGH);
		observeCodeIntel(failed('PROJECT_NOT_INDEXED'), () => undefined);
		expect(shown(await band.draw())).toContain("This project isn't indexed yet");
	});

	test('an unavailable store shows the band', async () => {
		const band = loadBand();
		observeCodeIntel(failed('AUTH_ERROR'), () => undefined);
		band.flags.storeDown = true;
		expect(shown(await band.draw())).toContain('Constellation sign-in failed');
	});
});

describe('the band as a loaded plugin', () => {
	const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 80, scroll: { offset: 0, bodyRows: 11 }, view: {} };

	/** Answers what the plugin reads beneath it: the git walk, surfaces, the theme, and code_intel by `answer.next`. */
	function world(on: On) {
		const answer = { next: failed('AUTH_ERROR') };
		const logs: string[] = [];
		const toasts: string[] = [];
		mock.env(on, { CONSTELLATION_ACCESS_KEY: KEY });
		mock.store(on);
		on('fs.exists', (_$, e) => ({ value: e.path === `${REPO}/.git` || e.path === '/work/other/.git' }));
		on('session.surfaces', () => ({ value: ['terminal'] }));
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
		on('tool.call', () => ({ result: answer.next.text, text: answer.next.text }));
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

		answer.next = failed('CWD_NOT_INDEXED', []);
		await $.tool.call({ tool: CODE_INTEL, tool_use_id: 'u2' });
		const again = await $.ui.mount({ plugin: 'constellation', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS });
		expect(await again.find({ type: 'Text', text: 'Not set up for this project' })).toBeDefined();
		expect(await again.find({ type: 'Link' })).toBeDefined();
		const drawn = (await again.findAll({ type: 'Text' })).map((t) => t.text).join('\n');
		await again.unmount();

		// Another repository does not share the first one's dismissal.
		await $.session.start({ cwd: '/work/other', surface: 'terminal', isInteractive: true });
		answer.next = failed('AUTH_ERROR');
		await $.tool.call({ tool: CODE_INTEL, tool_use_id: 'u3' });
		const other = await $.ui.mount({ plugin: 'constellation', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS });
		expect(await other.find({ type: 'Text', text: 'Constellation sign-in failed' })).toBeDefined();
		await other.unmount();

		expect([...logs, ...toasts, drawn].some((line) => line.includes(KEY))).toBe(false);
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
			observeCodeIntel(failed(code, []), () => undefined, ports.log);
			drawn.push(shown(await band.draw()));
		}
		const everything = [...seen.logs, ...seen.toasts, ...band.seen.logs, ...band.seen.toasts, ...drawn];
		expect(everything.length > 0).toBe(true);
		expect(everything.some((line) => line.includes(KEY) || line.includes(KEY.slice(3)))).toBe(false);
	});
});
