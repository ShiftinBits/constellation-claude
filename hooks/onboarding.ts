import type { ElementTable, EngineInterface, On, PluginOptions, ProcessRunInit, ProcessRunResult, RenderElement } from 'claude-code';
import { canDraw, codeIntel, gitRoot, parseEnvelope, projectRoot } from './lib';
import type { McpPort } from './lib';
import { PROMPT, badge, buttonRow, forTheme, onboarding, scheme } from './theme';
import type { Scheme, Tone } from './theme';

/** The access key format the CLI writes: `ak:` and 32 hex digits. */
export const KEY_PATTERN = /^ak:[0-9a-f]{32}$/i;

/** What `constellation index` prints when the project ID is unknown to Constellation. */
export const NOT_REGISTERED_OUTPUT = /Project not registered|PROJECT_NOT_REGISTERED/;

/** Where a project is created and its ID found. */
const WEB_APP = 'https://app.constellationdev.io';

/** How long the stored key read-back may take: a profile that prompts must not hold up the session. */
const READ_BACK_MS = 5000;

/** The band's states. The first that holds wins, in this order. */
export type OnboardingState = 'not-set-up' | 'sign-in-again' | 'no-project' | 'not-registered' | 'not-indexed' | 'working';

/** The CLI run in progress. */
export type Task = 'auth' | 'index';

/** What the band's state is decided from. */
export type OnboardingFacts = {
	/** The session's `CONSTELLATION_ACCESS_KEY` starts with `ak:`. */
	configured: boolean;
	/** A key the CLI stored was read back. */
	stored?: boolean;
	/** The error code of the latest code_intel answer. */
	code?: string;
	/** The project roots `CWD_NOT_INDEXED` found under the git root. */
	candidates?: readonly string[];
	/** False when no `constellation.json` sits at or above the working directory. */
	hasProject?: boolean;
	/** The CLI's own output said the project is not registered. */
	notRegistered?: boolean;
	/** `constellation auth` or `constellation index` is running. */
	running?: boolean;
};

/** The band's state for `facts`: the first row that holds, else undefined (nothing to show). */
export function onboardingState(facts: OnboardingFacts): OnboardingState | undefined {
	if (!facts.configured && facts.stored !== true) return 'not-set-up';
	if (facts.code === 'AUTH_ERROR') return 'sign-in-again';
	if (facts.hasProject === false || (facts.code === 'CWD_NOT_INDEXED' && (facts.candidates ?? []).length === 0)) return 'no-project';
	if (facts.code === 'PROJECT_NOT_REGISTERED' || facts.notRegistered === true) return 'not-registered';
	if (facts.code === 'PROJECT_NOT_INDEXED') return 'not-indexed';
	if (facts.running === true) return 'working';
	return undefined;
}

/**
 * The last key in `output` that matches `KEY_PATTERN`, else undefined. Each
 * line's last word counts, which covers `printenv` (the value alone, between
 * whatever a profile prints) and `reg query`
 * (`CONSTELLATION_ACCESS_KEY    REG_SZ    ak:...`).
 */
export function parseStoredKey(output: string): string | undefined {
	let found: string | undefined;
	for (const line of output.split('\n')) {
		const token = line.trim().split(/\s+/).pop() ?? '';
		if (KEY_PATTERN.test(token)) found = token;
	}
	return found;
}

/** The last line of `output` that is an absolute path (POSIX or a Windows drive), else undefined. */
export function parseCliPath(output: string): string | undefined {
	let found: string | undefined;
	for (const raw of output.split('\n')) {
		const line = raw.trim();
		if (/^(\/|[A-Za-z]:[\\/])/.test(line)) found = line;
	}
	return found;
}

/**
 * The last complete, non-empty line of `buffer`, else undefined. Text after
 * the last newline is still being written, so it waits. A carriage return
 * redraws a line in place, so what follows the last one in a line is kept.
 */
export function lastLine(buffer: string): string | undefined {
	const lines = buffer.split('\n').slice(0, -1);
	for (let i = lines.length - 1; i >= 0; i--) {
		const shown = (lines[i] ?? '')
			.split('\r')
			.map((part) => part.trim())
			.filter((part) => part !== '')
			.pop();
		if (shown !== undefined) return shown;
	}
	return undefined;
}

/** The http(s) URL on or after the line that says "open this URL manually", else undefined. */
export function manualUrl(buffer: string): string | undefined {
	const at = buffer.indexOf('open this URL manually');
	if (at < 0) return undefined;
	const from = buffer.lastIndexOf('\n', at) + 1;
	return /https?:\/\/[^\s'"<>]+/.exec(buffer.slice(from))?.[0];
}

/** Runs a command, as `$.process.run`. */
export type Run = (argv: readonly string[], init: ProcessRunInit) => Promise<Pick<ProcessRunResult, 'exitCode' | 'stdout'>>;

/**
 * What the onboarding calls. `claude plugin validate` follows `$` only into
 * functions of the same file, so a handler spells each call in a closure.
 */
export type OnboardingPorts = {
	run: Run;
	exists: (path: string) => Promise<boolean>;
	/** Sets `CONSTELLATION_ACCESS_KEY` for the session and what it starts. */
	envSet: (key: string) => Promise<void>;
	after: (ms: number, fn: () => void) => void;
	mcp: McpPort;
	/** Runs `/reload-plugins`, which restarts the MCP server with the session's environment. */
	reload: () => Promise<unknown>;
	toast: (text: string) => void;
	/** Draws the band again. */
	invalidate: () => void;
	/** Writes `text` as a transcript line when no surface of the session draws the band. */
	log: (text: string) => Promise<void>;
};

/** How a state change is told: a redraw, and a line where nothing draws. */
type Notify = Pick<OnboardingPorts, 'invalidate'> & Partial<Pick<OnboardingPorts, 'log'>>;

/** The one line a session that cannot draw the band gets, with the command to run. */
const LOG_LINE: Readonly<Record<Exclude<OnboardingState, 'working'>, string>> = {
	'not-set-up': `${PROMPT} not signed in: run constellation auth`,
	'sign-in-again': `${PROMPT} sign-in failed: run constellation auth`,
	'no-project': `${PROMPT} not set up for this project: run constellation init`,
	'not-registered': `${PROMPT} project not registered: check projectId in constellation.json`,
	'not-indexed': `${PROMPT} project not indexed: run constellation index`,
};

/** The states an error put up, which a later success takes down. */
const ERROR_STATES: ReadonlySet<OnboardingState> = new Set(['sign-in-again', 'not-indexed', 'not-registered', 'no-project']);

/**
 * Module state, cleared by `registerOnboarding` and `resetOnboarding`.
 * `generation` changes with each, so work started before a reset can tell.
 */
let generation = 0;
let state: OnboardingState | undefined;
/** The CLI run in progress; it ends with its child, whatever resets meanwhile. */
let running: Task | undefined;
/** What the running or last CLI run printed. */
let buffer = '';
/** A session that cannot draw gets one line. */
let logged = false;
/** The git root (else the working directory) the session started in: dismissals are kept per repository. */
let repoRoot: string | undefined;

/** Puts up `next` and tells the band, unless a CLI run holds the band. */
function apply(next: OnboardingState | undefined, notify: Notify): void {
	if (running !== undefined || next === state) return;
	state = next;
	try {
		notify.invalidate();
	} catch {
		// Refused while a band draws: the next draw reads the new state.
	}
	if (next === undefined || next === 'working' || logged || notify.log === undefined) return;
	logged = true;
	notify.log(LOG_LINE[next]).catch(() => undefined);
}

/**
 * Starts a CLI run: the band shows it as working, and nothing else writes the
 * band until `endTask`. Returns the generation, which a run compares once its
 * child exits to tell whether a reset came meanwhile, or undefined (refused)
 * while another run is live, so sign-in and indexing never overlap.
 */
export function startTask(task: Task, notify: Pick<OnboardingPorts, 'invalidate'>): number | undefined {
	if (running !== undefined) return undefined;
	buffer = '';
	apply(onboardingState({ configured: true, running: true }), notify);
	running = task;
	return generation;
}

/** Ends the CLI run, whatever reset came meanwhile. */
export function endTask(): void {
	running = undefined;
}

/**
 * Records the git root of `cwd` (else `cwd` itself) as the repository whose
 * dismissal the band reads, and returns the git root, or null outside one.
 */
export async function rememberRepo(cwd: string, exists: (path: string) => Promise<boolean>): Promise<string | null> {
	const root = await gitRoot(cwd, exists);
	repoRoot = root ?? cwd;
	return root;
}

/**
 * Reads back the key the CLI stored, or undefined: never logged or shown.
 * A login `/bin/sh` reads `~/.profile`, where the CLI writes the key, whatever
 * the person's shell; the empty override keeps an inherited key from masking
 * it. A run that fails or runs past the timeout counts as no key. Where `sh`
 * cannot run (Windows: the engine exposes no OS), the registry is read.
 */
export async function storedKey(run: Run): Promise<string | undefined> {
	try {
		const r = await run(['/bin/sh', '-lc', 'printenv CONSTELLATION_ACCESS_KEY'], {
			env: { CONSTELLATION_ACCESS_KEY: '' },
			timeoutMs: READ_BACK_MS,
		});
		return r.exitCode === 0 ? parseStoredKey(r.stdout) : undefined;
	} catch {
		// sh could not start or ran past the timeout: try the registry.
	}
	try {
		const r = await run(['reg', 'query', 'HKCU\\Environment', '/v', 'CONSTELLATION_ACCESS_KEY'], { timeoutMs: READ_BACK_MS });
		return r.exitCode === 0 ? parseStoredKey(r.stdout) : undefined;
	} catch {
		return undefined;
	}
}

/** A stored key found at session start, for the caller to set before the session goes on. */
export type FoundKey = { key: string; projectRoot: string | null };

/**
 * At session start with no key set: outside a git repository nothing runs. In
 * one, the stored key is read back; with none the band says not set up, else
 * the key and the project root (null without a `constellation.json`) return.
 */
export async function readStoredKeyAtStart(
	cwd: string,
	ports: Pick<OnboardingPorts, 'run' | 'exists'> & Notify,
): Promise<FoundKey | undefined> {
	if ((await rememberRepo(cwd, ports.exists)) === null) return undefined;
	const key = await storedKey(ports.run);
	if (key === undefined) {
		apply(onboardingState({ configured: false, stored: false }), ports);
		return undefined;
	}
	return { key, projectRoot: await projectRoot(cwd, ports.exists) };
}

/** Takes the band down and reloads the plugins on a timer, then says so. */
function reloadPlugins(ports: OnboardingPorts): void {
	state = undefined;
	buffer = '';
	ports.invalidate();
	// `$.command.run` is refused inside a hook the turn waits on, so it always goes through the timer.
	ports.after(0, () => {
		ports
			.reload()
			.then(() => ports.toast('✦ Constellation connected'))
			.catch(() => undefined);
	});
}

/** Sets `key` for the session, then reloads the plugins so the MCP server starts with it. */
export async function connect(key: string, ports: OnboardingPorts): Promise<void> {
	await ports.envSet(key);
	reloadPlugins(ports);
}

/**
 * After a stored key was set at session start: with no project the band says
 * so; else a ping decides. `AUTH_ERROR` means the server started before the
 * key was set, so the plugins reload; `PROJECT_NOT_INDEXED` (also sent for an
 * unregistered project) puts up the index button. Never rejects.
 */
export async function checkConnection(root: string | null, ports: OnboardingPorts): Promise<void> {
	try {
		if (root === null) {
			apply(onboardingState({ configured: true, hasProject: false }), ports);
			return;
		}
		const envelope = await codeIntel(ports.mcp, 'return await api.ping()', { cwd: root });
		const code = envelope.error?.code;
		if (code === 'AUTH_ERROR') {
			reloadPlugins(ports);
			return;
		}
		const next = onboardingState({ configured: true, code });
		if (next !== undefined) apply(next, ports);
	} catch {
		// The band stays as it was.
	}
}

/**
 * Reads the agent's own code_intel answer `r`: an error that has a fix puts up
 * its state, and a success takes down a state an error put up. A run of the
 * CLI holds the band, and `MCP_UNAVAILABLE` (the server is not connected) and
 * a `CWD_NOT_INDEXED` that lists project roots (a monorepo) change nothing.
 * With no key set, `AUTH_ERROR` keeps "not signed in": the server then got no key.
 */
export function observeCodeIntel(r: { deny?: string; text?: string }, invalidate: () => void, log?: (text: string) => Promise<void>): void {
	if (r.deny !== undefined || running !== undefined) return;
	const notify: Notify = log === undefined ? { invalidate } : { invalidate, log };
	const envelope = parseEnvelope(r.text);
	if (envelope.success) {
		if (state !== undefined && ERROR_STATES.has(state)) apply(undefined, notify);
		return;
	}
	const error = envelope.error;
	if (error === undefined || error.code === 'MCP_UNAVAILABLE') return;
	const next = onboardingState({ configured: state !== 'not-set-up', code: error.code, candidates: error.candidates });
	if (next !== undefined) apply(next, notify);
}

/** The second spelling of the ports, for the band's buttons; the first is the session start's in `command.ts`. */
function portsOf($: EngineInterface): OnboardingPorts {
	return {
		run: (argv, init) => $.process.run(argv, init),
		exists: (p) => $.fs.exists(p),
		envSet: (key) => $.env.set('CONSTELLATION_ACCESS_KEY', key),
		after: (ms, fn) => {
			$.clock.after(ms, fn);
		},
		mcp: { connect: (s) => $.mcp.connect(s), call: (s, t, a) => $.mcp.call(s, t, a) },
		reload: () => $.command.run({ command: 'reload-plugins' }),
		toast: (text) => $.ui.toast(text),
		invalidate: () => $.ui.invalidate('ui.render'),
		log: async (text) => {
			if (!canDraw(await $.session.surfaces())) $.ui.log(text);
		},
	};
}

/** The store key of a repository's dismissed state. */
function dismissalKey(repo: string): string {
	return `onboarding-dismissed:${repo}`;
}

const TONE: Readonly<Record<OnboardingState, Tone>> = {
	'not-set-up': onboarding.notSetUp,
	'sign-in-again': onboarding.failed,
	'no-project': onboarding.notSetUp,
	'not-registered': onboarding.failed,
	'not-indexed': onboarding.notSetUp,
	working: onboarding.pending,
};

const HEADLINE: Readonly<Record<Exclude<OnboardingState, 'working'>, string>> = {
	'not-set-up': "Constellation isn't signed in",
	'sign-in-again': 'Constellation sign-in failed',
	'no-project': 'Not set up for this project',
	'not-registered': "This project isn't registered with Constellation",
	'not-indexed': "This project isn't indexed yet",
};

/** What the band draws and what its buttons do. */
export type BandView = {
	state: OnboardingState;
	tint: Scheme;
	/** The CLI's latest output line. */
	detail?: string;
	/** The CLI run behind `working`. */
	task?: Task;
	dismiss: () => void;
	signIn: () => void;
	index: () => void;
};

/**
 * The band for a state: a badge and headline, the steps for states a button
 * cannot fix (a command to run in a terminal and a link), the CLI's latest
 * line, then the buttons, Dismiss left and the fix rightmost.
 */
export function band(el: ElementTable, view: BandView): RenderElement {
	const tone = forTheme(TONE[view.state], view.tint);
	const headline =
		view.state === 'working' ? (view.task === 'index' ? 'Indexing this project' : 'Signing in to Constellation') : HEADLINE[view.state];
	const rows: RenderElement[] = [
		el.Box({ flexDirection: 'row', columnGap: 1, children: [badge(el, '', tone), el.Text({ bold: true, children: headline })] }),
	];
	if (view.state === 'no-project') {
		rows.push(el.Text({ children: 'Run constellation init in a terminal, with the project ID from the web app:' }), el.Link({ href: WEB_APP }));
	}
	if (view.state === 'not-registered') {
		rows.push(el.Text({ children: 'Check projectId in constellation.json against the web app:' }), el.Link({ href: WEB_APP }));
	}
	if (view.detail !== undefined) rows.push(el.Text({ dimColor: true, wrap: 'truncate', children: view.detail }));
	const dismiss = { key: 'onboarding-dismiss', label: 'Dismiss', onPress: view.dismiss };
	const action =
		view.state === 'not-set-up' || view.state === 'sign-in-again'
			? { key: 'onboarding-sign-in', label: 'Sign in', onPress: view.signIn }
			: view.state === 'not-indexed'
				? { key: 'onboarding-index', label: 'Index this project', onPress: view.index }
				: undefined;
	rows.push(
		action === undefined
			? el.Box({ flexDirection: 'row', justifyContent: 'flex-end', children: [el.Button(dismiss)] })
			: buttonRow(el, dismiss, action),
	);
	return el.Box({ flexDirection: 'column', children: rows });
}

/**
 * The onboarding band above the prompt. Draws from module state only; a
 * repository whose stored dismissal equals the current state passes, so a
 * new, different error shows the band again.
 */
export function registerOnboarding(on: On, options: PluginOptions): void {
	generation += 1;
	state = undefined;
	running = undefined;
	buffer = '';
	logged = false;
	repoRoot = undefined;

	on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
		const shown = state;
		if (e.props.hasSurvey || shown === undefined) return next(e);
		const key = dismissalKey(repoRoot ?? (await $.session.cwd()));
		try {
			if ((await $.store.get(key)) === shown) return next(e);
		} catch {
			// The store is unavailable: the band shows.
		}
		let tint: Scheme;
		try {
			tint = scheme(options.colors, (await $.config.list()).find((r) => r.key === 'theme')?.value);
		} catch {
			tint = scheme(options.colors, undefined);
		}
		const detail = lastLine(buffer);
		return band($.ui.resolve(e), {
			state: shown,
			tint,
			...(detail === undefined ? {} : { detail }),
			...(running === undefined ? {} : { task: running }),
			dismiss: async () => {
				try {
					await $.store.set(key, shown);
				} catch {
					// Not kept: the band shows again on the next draw.
				}
				portsOf($).invalidate();
			},
			signIn: () => undefined,
			index: () => undefined,
		});
	});
}

/**
 * Starts the band over for a new conversation (`/clear`, `/resume`, `/branch`).
 * A CLI run still going keeps `running`: its loop clears it when the child
 * exits, so sign-in and indexing never overlap, and the changed generation
 * tells it not to act on what it finds.
 */
export function resetOnboarding(): void {
	generation += 1;
	state = undefined;
	buffer = '';
	logged = false;
}
