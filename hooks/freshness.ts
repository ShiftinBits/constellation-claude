import type { On, PluginOptions, ProcessRunInit, ProcessRunResult, Timer } from 'claude-code';
import { explain } from './explain';
import { canDraw, type CodeIntelEnvelope, type CodeIntelError, GIT, GIT_ENV, GIT_TIMEOUT_MS, isConfigured, plural, stringArg } from './lib';

/** Runs a command, as `$.process.run`. */
export type Run = (argv: readonly string[], init: ProcessRunInit) => Promise<Pick<ProcessRunResult, 'exitCode' | 'stdout'>>;

/** Writes the line where nothing draws it. A promise it returns may reject; that is ignored. */
export type Log = (text: string) => Promise<void> | void;

/** What the graph was indexed at, from a code_intel envelope. */
type Index = { asOfCommit: string; lastIndexedAt?: string; branch?: string };

/** What the working tree is at. `behind` is undefined when the count could not be taken. */
type Local = { head: string; branch: string; behind: number | undefined; dirty: boolean };

/** What the indicator shows, or nothing when the graph matches the checkout. */
export type FreshnessView =
	| { kind: 'behind'; behind: number; dirty: boolean; lastIndexedAt?: string }
	| { kind: 'mismatch'; asOfCommit: string; dirty: boolean; lastIndexedAt?: string }
	| { kind: 'error'; failure: CodeIntelError; dirty: boolean; lastIndexedAt?: string };

/** Error codes the onboarding band already shows, so the indicator stays quiet. */
const ONBOARDING_CODES: ReadonlySet<string> = new Set(['AUTH_ERROR', 'PROJECT_NOT_INDEXED', 'NOT_CONFIGURED', 'MCP_UNAVAILABLE']);

/** A commit id as git prints it. Anything else from the server never reaches a git argument. */
const COMMIT = /^[0-9a-f]{7,64}$/i;

const SEP = ' · ';

/**
 * A git command that moves HEAD or changes the tree: `git`, then options such
 * as `-C dir`, then the subcommand, with no `;`, `&`, `|` or line break
 * between them, so `cd x && git commit` counts and `echo git; commit` does not.
 */
const GIT_MOVES = /\bgit\s[^;&|\n]*\b(?:commit|pull|checkout|merge|rebase)\b/;

/**
 * Module state, cleared by `registerFreshness`. The index, the local checkout
 * and the root describe the repository, so `resetFreshness` keeps them.
 */
let index: Index | undefined;
let local: Local | undefined;
let failure: CodeIntelError | undefined;
let root: string | undefined;
let logged = false;
/** The latest recheck; an older one that finishes after a newer started drops its result. */
let seq = 0;
let timer: Timer | undefined;
let colors: unknown;

/** How long ago `iso` was: "just now", "5m ago", "2h ago" or "3d ago". Undefined when `iso` is not a date. */
function age(iso: string, now: number): string | undefined {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return undefined;
	const minutes = Math.floor(Math.max(0, now - then) / 60000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/**
 * What to draw for the graph's commit against the checkout, or undefined for
 * nothing. A failure with no index is an error. A HEAD that starts with the
 * indexed commit (the envelope may carry a short id) is fresh even when dirty.
 * Otherwise HEAD is behind when the index commit has newer commits, and a
 * mismatch when it has none or the count is unknown.
 */
export function freshnessView(
	known: Index | undefined,
	checkout: Local | undefined,
	error: CodeIntelError | undefined,
): FreshnessView | undefined {
	if (known === undefined) {
		return error === undefined ? undefined : { kind: 'error', failure: error, dirty: false };
	}
	if (checkout === undefined) return undefined;
	if (checkout.head.startsWith(known.asOfCommit)) return undefined;
	const shared = { dirty: checkout.dirty, ...(known.lastIndexedAt === undefined ? {} : { lastIndexedAt: known.lastIndexedAt }) };
	if (checkout.behind !== undefined && checkout.behind > 0) return { kind: 'behind', behind: checkout.behind, ...shared };
	return { kind: 'mismatch', asOfCommit: known.asOfCommit, ...shared };
}

/** The indicator as one plain line, for the band and for sessions that cannot draw. */
export function freshnessText(view: FreshnessView, now: number): string {
	if (view.kind === 'error') {
		const ex = explain(view.failure);
		return ['✦ ' + view.failure.code, ex.title, ...(ex.steps[0] === undefined ? [] : [ex.steps[0]])].join(SEP);
	}
	const since = view.lastIndexedAt === undefined ? undefined : age(view.lastIndexedAt, now);
	const head = view.kind === 'behind' ? `index ${plural(view.behind, 'commit')} behind` : `index at ${view.asOfCommit.slice(0, 7)}`;
	return `✦ ${[head, ...(since === undefined ? [] : [`indexed ${since}`])].join(SEP)}${view.dirty ? ' + local changes' : ''}`;
}

/**
 * Where HEAD is against `asOfCommit`, in the project at `root`: its commit and
 * branch (`HEAD` when detached), how many commits it is past `asOfCommit`, and
 * whether the tree has changes. Undefined when git fails, so the indicator
 * stays as it was.
 */
export async function compareLocal(run: Run, root: string, asOfCommit: string): Promise<Local | undefined> {
	const git = (args: string[]): Promise<Pick<ProcessRunResult, 'exitCode' | 'stdout'>> =>
		run([...GIT, ...args], { cwd: root, env: GIT_ENV, timeoutMs: GIT_TIMEOUT_MS });
	try {
		const parsed = await git(['rev-parse', 'HEAD', '--symbolic-full-name', 'HEAD']);
		if (parsed.exitCode !== 0) return undefined;
		const [head = '', ref = ''] = parsed.stdout.split('\n').map((l) => l.trim());
		if (head === '') return undefined;
		const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : 'HEAD';
		let behind: number | undefined = 0;
		if (!head.startsWith(asOfCommit)) {
			const counted = await git(['rev-list', '--count', `${asOfCommit}..HEAD`, '--']);
			const n = Number(counted.stdout.trim());
			behind = counted.exitCode === 0 && /^\d+$/.test(counted.stdout.trim()) ? n : undefined;
		}
		const status = await git(['status', '--porcelain']);
		return { head, branch, behind, dirty: status.exitCode === 0 && status.stdout.trim() !== '' };
	} catch {
		return undefined;
	}
}

/** The line now, or undefined when nothing is shown. */
function lineNow(): string | undefined {
	const view = freshnessView(index, local, failure);
	return view === undefined ? undefined : freshnessText(view, Date.now());
}

/** Draws again and logs once when the line changed from `before`. */
function changed(before: string | undefined, invalidate: () => void, log?: Log): void {
	const after = lineNow();
	if (after === before) return;
	invalidate();
	if (after !== undefined && log !== undefined && !logged) {
		logged = true;
		void Promise.resolve(log(after)).catch(() => undefined);
	}
}

/** Compares the checkout with the index, then draws again when the line changed from `before`. Never rejects. */
async function compare(before: string | undefined, run: Run, invalidate: () => void, log?: Log): Promise<void> {
	if (root === undefined || index === undefined) return changed(before, invalidate, log);
	const mine = ++seq;
	const next = await compareLocal(run, root, index.asOfCommit);
	if (mine !== seq) return;
	if (next === undefined) return changed(before, invalidate, log);
	// The snapshot is per branch: one taken on another branch says nothing here.
	if (index.branch === undefined) index = { ...index, branch: next.branch };
	else if (index.branch !== next.branch) index = undefined;
	local = next;
	changed(before, invalidate, log);
}

/**
 * Compares the checkout with the index and draws again when the line changed.
 * A no-op without a tracked root and an index. Never rejects.
 */
export function recheck(run: Run, invalidate: () => void, log?: Log): Promise<void> {
	return compare(lineNow(), run, invalidate, log);
}

/**
 * Learns what the graph was indexed at from a code_intel envelope for the
 * project at `root`. Only a hex commit id is kept, so nothing else from the
 * server reaches git or the text. A failure shows only while no index is
 * known, and never for the codes the onboarding band owns.
 */
export async function observeEnvelope(
	envelope: CodeIntelEnvelope,
	at: string,
	run: Run,
	invalidate: () => void,
	log?: Log,
): Promise<void> {
	if (at !== root) return;
	const before = lineNow();
	if (!envelope.success) {
		const error = envelope.error;
		if (index === undefined && error !== undefined && !ONBOARDING_CODES.has(error.code)) failure = error;
		return changed(before, invalidate, log);
	}
	failure = undefined;
	const commit = envelope.asOfCommit;
	if (commit === undefined || !COMMIT.test(commit)) return changed(before, invalidate, log);
	if (index?.asOfCommit === commit && index.lastIndexedAt === envelope.lastIndexedAt) return changed(before, invalidate, log);
	index = { asOfCommit: commit, ...(envelope.lastIndexedAt === undefined ? {} : { lastIndexedAt: envelope.lastIndexedAt }) };
	await compare(before, run, invalidate, log);
}

/** Tracks the project at `at`. A different root drops what was known about the last one; true when it changed. */
export function track(at: string): boolean {
	if (at === root) return false;
	root = at;
	index = undefined;
	local = undefined;
	failure = undefined;
	return true;
}

/** Starts the redraw timer with `every`, a closure over `$.clock.every`, after cancelling the last one. */
export function startTicks(every: () => Timer): void {
	timer?.cancel();
	timer = every();
}

/** The indicator now: what to draw and its line, or undefined for nothing. */
export function freshnessLine(now: number): { view: FreshnessView; text: string } | undefined {
	const view = freshnessView(index, local, failure);
	return view === undefined ? undefined : { view, text: freshnessText(view, now) };
}

/** The `colors` option, for painting the band. */
export function freshnessColors(): unknown {
	return colors;
}

/**
 * Starts the indicator over and keeps the colors option. A Bash call that ran
 * a git commit, pull, checkout, merge or rebase compares the checkout again;
 * the call's result goes back untouched and does not wait for git.
 */
export function registerFreshness(on: On, options: PluginOptions): void {
	timer?.cancel();
	timer = undefined;
	index = undefined;
	local = undefined;
	failure = undefined;
	root = undefined;
	logged = false;
	seq = 0;
	colors = options.colors;

	on('tool.call', { tool: /^Bash$/ }, async ($, e, next) => {
		const r = await next(e);
		if (r.deny !== undefined || r.isError === true) return r;
		try {
			if (!GIT_MOVES.test(stringArg(e, 'command') ?? '')) return r;
			if (!isConfigured(await $.env.get('CONSTELLATION_ACCESS_KEY'))) return r;
			void recheck(
				(argv, init) => $.process.run(argv, init),
				() => $.ui.invalidate('ui.render'),
				async (text) => {
					if (!canDraw(await $.session.surfaces())) $.ui.log(text);
				},
			).catch(() => undefined);
		} catch {
			// The indicator stays as it was.
		}
		return r;
	});
}

/**
 * Lets the next conversation (`/clear`, `/resume`, `/branch`) log the line
 * again. The index, the checkout and the root stay: they describe the
 * repository, not the conversation.
 */
export function resetFreshness(): void {
	logged = false;
}
