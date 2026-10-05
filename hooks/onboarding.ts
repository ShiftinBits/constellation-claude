import type {
	ElementTable,
	EngineInterface,
	On,
	PluginOptions,
	ProcessRunInit,
	ProcessRunResult,
	ProcessSpawnChunk,
	ProcessSpawnRequest,
	RenderElement,
} from 'claude-code';
import { canDraw, codeIntel, gitRoot, parseToolText, projectRoot } from './lib';
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

/** How the CLI is installed, and where the docs say so. */
const INSTALL_COMMAND = 'npm i -g @constellationdev/cli';
const INSTALL_DOCS = 'https://docs.constellationdev.io/cli/#installation';

/** A failed sign-in's line where the CLI said nothing, or where no login `sh` reads its key back. */
const AUTH_IN_TERMINAL = 'Run `constellation auth` in a terminal';

/** An index press where no `constellation.json` sits at or above the session's directory. */
const INDEX_IN_PROJECT = 'Run `constellation index` in a terminal, in the project directory';

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
/** The line under the state's headline once a CLI run has ended, such as its last output line. */
let detail: string | undefined;
/** The last button press found no CLI: the band says how to install it. */
let cliMissing = false;
/** A session that cannot draw gets one line. */
let logged = false;
/** The git root (else the working directory) the session started in: dismissals are kept per repository. */
let repoRoot: string | undefined;

/** Draws the band again. */
function redraw(notify: Pick<OnboardingPorts, 'invalidate'>): void {
	try {
		notify.invalidate();
	} catch {
		// Refused while a band draws: the next draw reads the new state.
	}
}

/** Puts up `next`, with `line` under its headline, and tells the band, unless a CLI run holds the band. */
function apply(next: OnboardingState | undefined, notify: Notify, line?: string): void {
	if (running !== undefined || next === state) return;
	state = next;
	detail = line;
	redraw(notify);
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

/** Where the CLI is (undefined when not found), and whether a login `sh` could run to look. */
export type CliLookup = { path: string | undefined; shell: boolean };

/**
 * Finds the CLI the way a terminal would: a login `/bin/sh` runs
 * `command -v`, so a PATH the profile sets counts. Where `sh` cannot start
 * (Windows), `where` names it, its first line taken. Never rejects.
 */
export async function cliPath(run: Run): Promise<CliLookup> {
	try {
		const r = await run(['/bin/sh', '-lc', 'command -v constellation'], { timeoutMs: READ_BACK_MS });
		return { path: r.exitCode === 0 ? parseCliPath(r.stdout) : undefined, shell: true };
	} catch {
		// sh could not start or ran past the timeout: ask where.
	}
	try {
		const r = await run(['where', 'constellation'], { timeoutMs: READ_BACK_MS });
		const first = r.stdout
			.split('\n')
			.map((line) => line.trim())
			.find((line) => line !== '');
		return { path: r.exitCode === 0 ? first : undefined, shell: false };
	} catch {
		return { path: undefined, shell: false };
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

/** Takes the band down and reloads the plugins on a timer, then says so unless `announce` is false. */
function reloadPlugins(ports: OnboardingPorts, announce = true): void {
	state = undefined;
	detail = undefined;
	buffer = '';
	ports.invalidate();
	// `$.command.run` is refused inside a hook the turn waits on, so it always goes through the timer.
	ports.after(0, () => {
		ports
			.reload()
			.then(() => {
				if (announce) ports.toast('✦ Constellation connected');
			})
			.catch(() => undefined);
	});
}

/**
 * Sets `key` for the session, then reloads the plugins so the MCP server
 * starts with it, and says so after unless `announce` is false. A reload
 * unloads the module and kills a running child, so call it once a CLI run has
 * ended (`endTask`).
 */
export async function connect(key: string, ports: OnboardingPorts, announce = true): Promise<void> {
	await ports.envSet(key);
	reloadPlugins(ports, announce);
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
			// A sign-in already running connects when it ends; a reload now would kill its child.
			if (running === undefined) reloadPlugins(ports);
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
 * `configured` is whether the session's key starts with `ak:`; with none,
 * `AUTH_ERROR` says "not signed in": the server then got no key.
 */
export function observeCodeIntel(
	r: { deny?: string; text?: string; isError?: boolean },
	configured: boolean,
	invalidate: () => void,
	log?: (text: string) => Promise<void>,
): void {
	if (r.deny !== undefined || running !== undefined) return;
	const notify: Notify = log === undefined ? { invalidate } : { invalidate, log };
	const envelope = parseToolText(r.text, r.isError === true);
	if (envelope.success) {
		if (state !== undefined && ERROR_STATES.has(state)) apply(undefined, notify);
		return;
	}
	const error = envelope.error;
	if (error === undefined || error.code === 'MCP_UNAVAILABLE') return;
	const next = onboardingState({ configured, code: error.code, candidates: error.candidates });
	if (next !== undefined) apply(next, notify);
}

/** What the band's buttons call beyond the session start's ports. */
export type ButtonPorts = OnboardingPorts & {
	/** Starts a child, as `$.process.spawn`: the loop over its pieces is its life. */
	spawn: (request: ProcessSpawnRequest) => AsyncIterable<ProcessSpawnChunk>;
	/** The session's working directory. */
	cwd: () => Promise<string>;
};

/** A claimed CLI run: the generation it started in and the CLI it runs. */
type Claim = { gen: number; cli: string; shell: boolean };

/**
 * Claims the band for `task` before anything is awaited, so a second press
 * is refused at once, then finds the CLI. Undefined when a run is live, or
 * when no CLI is found: the band then goes back to what it showed and says
 * how to install it, and nothing is spawned.
 */
async function claim(task: Task, ports: ButtonPorts): Promise<Claim | undefined> {
	const prior = state;
	const gen = startTask(task, ports);
	if (gen === undefined) return undefined;
	const { path, shell } = await cliPath(ports.run);
	if (path !== undefined) {
		cliMissing = false;
		return { gen, cli: path, shell };
	}
	endTask();
	if (generation === gen) {
		cliMissing = true;
		apply(prior, ports);
	}
	return undefined;
}

/**
 * Reads a CLI run's child to its end, both streams into `buffer`, and draws
 * the band again when its latest line changes. False when the child could not
 * start. What it prints after a reset is not kept: the band it was for is gone.
 */
async function follow(start: () => AsyncIterable<ProcessSpawnChunk>, gen: number, notify: Pick<OnboardingPorts, 'invalidate'>): Promise<boolean> {
	try {
		for await (const { text } of start()) {
			if (generation !== gen) continue;
			const was = lastLine(buffer);
			buffer += text;
			if (lastLine(buffer) !== was) redraw(notify);
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * The Sign in button: runs `constellation auth` with the inherited key
 * emptied, so the CLI neither reuses nor asks to replace it, then reads the
 * stored key back. A new key connects; anything else (the exit code is not
 * read) says the sign-in failed. The run holds the band until that is
 * decided, and the plugins reload only after the child has exited, since a
 * reload kills it. A run that outlives a reset acts on nothing.
 */
export async function startSignIn(ports: ButtonPorts): Promise<void> {
	const claimed = await claim('auth', ports);
	if (claimed === undefined) return;
	const { gen, cli, shell } = claimed;
	const before = await storedKey(ports.run);
	void (async () => {
		let after: string | undefined;
		let root: string | null | undefined;
		try {
			const started = await follow(
				() => ports.spawn({ argv: [cli, 'auth'], env: { CONSTELLATION_ACCESS_KEY: '', NO_COLOR: '1' } }),
				gen,
				ports,
			);
			if (started && generation === gen) after = await storedKey(ports.run);
			if (after !== undefined && after !== before) {
				root = await ports
					.cwd()
					.then((cwd) => projectRoot(cwd, ports.exists))
					.catch(() => undefined);
			}
		} finally {
			endTask();
		}
		if (generation !== gen) return;
		if (after !== undefined && after !== before) {
			try {
				// The reload wipes module state, so the init hint goes out before it.
				if (root === null) ports.toast('✦ Constellation connected. Run constellation init in this repo to set it up');
				await connect(after, ports, root !== null);
				return;
			} catch {
				// The key could not be set: the sign-in failed.
			}
		}
		apply('sign-in-again', ports, (shell ? lastLine(buffer) : undefined) ?? AUTH_IN_TERMINAL);
	})();
}

/**
 * The Index button: runs `constellation index --wait` in the project root,
 * then a ping decides (the exit code is not read). Indexed takes the band
 * down; still not indexed stays, or says not registered when the CLI said
 * so. The run holds the band until the ping answers. A run that outlives a
 * reset acts on nothing.
 */
export async function startIndex(ports: ButtonPorts): Promise<void> {
	const prior = state;
	const claimed = await claim('index', ports);
	if (claimed === undefined) return;
	const { gen, cli } = claimed;
	const root = await ports
		.cwd()
		.then((cwd) => projectRoot(cwd, ports.exists))
		.catch(() => null);
	if (root === null) {
		endTask();
		if (generation === gen) apply(prior, ports, INDEX_IN_PROJECT);
		return;
	}
	void (async () => {
		let code: string | undefined;
		try {
			await follow(() => ports.spawn({ argv: [cli, 'index', '--wait'], cwd: root, env: { NO_COLOR: '1' } }), gen, ports);
			if (generation === gen) code = (await codeIntel(ports.mcp, 'return await api.ping()', { cwd: root })).error?.code;
		} finally {
			endTask();
		}
		if (generation !== gen) return;
		if (code !== 'PROJECT_NOT_INDEXED') {
			buffer = '';
			apply(undefined, ports);
			ports.toast('✦ Constellation indexed this project');
			return;
		}
		apply(NOT_REGISTERED_OUTPUT.test(buffer) ? 'not-registered' : 'not-indexed', ports, lastLine(buffer));
	})();
}

/** The second spelling of the ports, for the band's buttons; the first is the session start's in `command.ts`. */
function portsOf($: EngineInterface): ButtonPorts {
	return {
		spawn: (request) => $.process.spawn(request),
		cwd: () => $.session.cwd(),
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
	/** The CLI's latest output line, or what to do next. */
	detail?: string;
	/** The CLI run behind `working`. */
	task?: Task;
	/** The address a sign-in asks to be opened when no browser opened. */
	url?: string;
	/** The last press found no CLI: how to install it shows above the buttons. */
	cliMissing?: boolean;
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
	if (view.url !== undefined) rows.push(el.Link({ href: view.url, label: view.url }));
	const dismiss = { key: 'onboarding-dismiss', label: 'Dismiss', onPress: view.dismiss };
	const action =
		view.state === 'not-set-up' || view.state === 'sign-in-again'
			? { key: 'onboarding-sign-in', label: 'Sign in', onPress: view.signIn }
			: view.state === 'not-indexed'
				? { key: 'onboarding-index', label: 'Index this project', onPress: view.index }
				: undefined;
	if (action !== undefined && view.cliMissing === true) {
		rows.push(el.Text({ children: `Install the Constellation CLI, then press ${action.label} again: ${INSTALL_COMMAND}` }), el.Link({ href: INSTALL_DOCS }));
	}
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
	detail = undefined;
	cliMissing = false;
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
		// While a run goes, its latest line; then the line it ended on.
		const line = running === undefined ? detail : lastLine(buffer);
		// Only complete lines: a URL still being written is not offered.
		const url = running === 'auth' ? manualUrl(buffer.slice(0, buffer.lastIndexOf('\n') + 1)) : undefined;
		return band($.ui.resolve(e), {
			state: shown,
			tint,
			...(line === undefined ? {} : { detail: line }),
			...(running === undefined ? {} : { task: running }),
			...(url === undefined ? {} : { url }),
			...(cliMissing ? { cliMissing } : {}),
			dismiss: async () => {
				try {
					await $.store.set(key, shown);
				} catch {
					// Not kept: the band shows again on the next draw.
				}
				portsOf($).invalidate();
			},
			signIn: () => startSignIn(portsOf($)),
			index: () => startIndex(portsOf($)),
		});
	});
}

/**
 * Starts the band over for a new conversation (`/clear`, `/resume`, `/branch`).
 * Not set up and no project stay: they describe the process and the
 * repository, not the conversation. A CLI run still going keeps `running`: its
 * loop clears it when the child exits, so sign-in and indexing never overlap,
 * and the changed generation tells it not to act on what it finds.
 */
export function resetOnboarding(): void {
	generation += 1;
	if (state !== 'not-set-up' && state !== 'no-project') {
		state = undefined;
		detail = undefined;
	}
	buffer = '';
	cliMissing = false;
	logged = false;
}
