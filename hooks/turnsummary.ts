import type { On, PluginOptions } from 'claude-code';
import { type Blast, blastRadius, relativeTo } from './blast';
import { absolute, type McpPort, projectRoot, stringArg, withinDeadline } from './lib';
import { PROMPT } from './theme';

/**
 * How long the end of a turn waits for the lookup before it shows no line. The
 * hook's own time limit pauses while `$.mcp.call` runs, so a slow server would
 * otherwise hold the answer for code_intel's full timeout.
 */
export const TURN_SUMMARY_DEADLINE_MS = 2000;

let enabled = true;

/** Absolute paths edited this turn, in the order they were first edited. */
const changed = new Set<string>();

/** Absolute paths a Write created this turn. */
const created = new Set<string>();

/** Starts a new turn's record of changed files. */
export function startTurnSummary(): void {
	changed.clear();
	created.clear();
}

/** Drops the record of changed files, for a new conversation (`/clear`, `/resume`, `/branch`). */
export function resetTurnSummary(): void {
	changed.clear();
	created.clear();
}

/** What `summarizeTurn` needs from `$`, as closures the handler spells out. */
export type TurnSummaryPort = {
	exists: (path: string) => Promise<boolean>;
	mcp: McpPort;
	sleep: (ms: number, options: { signal: AbortSignal }) => Promise<unknown>;
};

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** The summary line for `n` changed files, `k` of them new, `queried` of them looked up, and their blast radius. */
function summaryLine(n: number, k: number, queried: number, blast: Blast): string {
	const fresh = k > 0 ? ` (${k} new)` : '';
	const tests = plural(blast.tests, 'test file');
	const commit = blast.asOfCommit === undefined ? '' : ` · as of ${blast.asOfCommit}`;
	const of = blast.skipped === undefined ? '' : ` of the first ${queried - blast.skipped} files`;
	return `${PROMPT} ${plural(n, 'file')} changed${fresh} · ${plural(blast.dependents.length, 'downstream dependent')}${of} (${tests})${commit}`;
}

/**
 * One line on the files this turn changed and how many files depend on them,
 * then a fresh record for the next turn. Undefined when the summary is off,
 * nothing changed, the first changed file is not in a Constellation project, or
 * the lookup failed or missed `TURN_SUMMARY_DEADLINE_MS`.
 */
export async function summarizeTurn(port: TurnSummaryPort, signal: AbortSignal): Promise<string | undefined> {
	if (!enabled || changed.size === 0) return undefined;
	const files = [...changed];
	const fresh = new Set(created);
	startTurnSummary();
	const [first] = files;
	if (first === undefined) return undefined;
	const root = await projectRoot(absolute('..', first), port.exists);
	if (root === null) return undefined;
	const queried = files.flatMap((path) => {
		const rel = fresh.has(path) ? null : relativeTo(root, path);
		return rel === null ? [] : [rel];
	});
	const blast: Blast | undefined =
		queried.length === 0
			? { dependents: [], tests: 0, exports: [] }
			: await withinDeadline(port.sleep, blastRadius(port.mcp, root, queried, { exports: false }), TURN_SUMMARY_DEADLINE_MS, signal);
	return blast === undefined ? undefined : summaryLine(files.length, fresh.size, queried.length, blast);
}

export function registerTurnSummary(on: On, options: PluginOptions): void {
	enabled = options.turnSummary !== false;
	resetTurnSummary();
	if (!enabled) return;

	// Every agent's edits count, a subagent's included: the line sums up what the turn changed.
	on('tool.call', { tool: /^(Edit|Write|MultiEdit|NotebookEdit)$/ }, async ($, e, next) => {
		const raw = stringArg(e, 'file_path') ?? stringArg(e, 'notebook_path');
		if (raw === undefined) return next(e);
		const path = absolute(raw, await $.session.cwd());
		const creates = String(e.tool) === 'Write' && !(await $.fs.exists(path));
		const r = await next(e);
		if (r.deny === undefined && !r.isError) {
			changed.add(path);
			if (creates) created.add(path);
		}
		return r;
	});
}
