import type { EngineInterface, On, PluginOptions } from 'claude-code';
import { type Blast, blastRadius, relativeTo } from './blast';
import { type GhPrCreate, ghPrCreate } from './classify';
import { absolute, isConfigured, projectRoot, stringArg, withinDeadline } from './lib';

/** What happens before `gh pr create`. */
type Mode = 'require' | 'inform' | 'off';

const MODES: readonly Mode[] = ['require', 'inform', 'off'];

/**
 * How long `gh pr create` waits for the impact lookup before it goes ahead
 * without the section. The hook's own time limit pauses while `$.mcp.call`
 * runs, so a slow server would otherwise hold the command for code_intel's
 * full timeout.
 */
export const PR_DEADLINE_MS = 8000;

/** How long each git command may run. */
const GIT_TIMEOUT_MS = 5000;

/**
 * git with the repository's fsmonitor and hooks turned off, since the command
 * runs before Claude Code asks about the Bash call it guards.
 */
const GIT = ['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];

/** An `## Impact` heading at a line start or after whitespace or a quote (`--body "## Impact`). */
const HEADING = /(^|[\s"'])##\s+Impact\b/m;

const MOST_AFFECTED = 5;
const MAX_EXPORTS = 10;

const INSTRUCTION = 'Add this Impact section to the PR body and run gh pr create again.';

let mode: Mode = 'inform';

/** The branches require mode has refused once, keyed by project root and branch. */
const refused = new Set<string>();

function modeOf(value: unknown): Mode {
	return MODES.find((m) => m === value) ?? 'inform';
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function quoted(names: readonly string[]): string {
	return names.map((n) => `\`${n}\``).join(', ');
}

/**
 * The PR body's `## Impact` section for the `changed` project-relative files
 * and their blast radius: the counts, up to five dependents, up to ten
 * exported symbols, and where the numbers come from.
 */
export function buildImpactSection(changed: string[], blast: Blast): string {
	const lines = [
		'## Impact',
		'',
		`- **Changed files:** ${changed.length}`,
		`- **Downstream dependents:** ${blast.dependents.length} (${plural(blast.tests, 'test file')})${
			blast.skipped === undefined ? '' : `, of the first ${changed.length - blast.skipped} changed files`
		}`,
	];
	if (blast.dependents.length > 0) {
		lines.push(`- **Most affected:** ${quoted(blast.dependents.slice(0, MOST_AFFECTED))}`);
	}
	if (blast.exports.length > 0) {
		const more = blast.exports.length - MAX_EXPORTS;
		const shown = quoted(blast.exports.slice(0, MAX_EXPORTS));
		lines.push(`- **Exported symbols in changed files:** ${more > 0 ? `${shown}, +${more} more` : shown}`);
	}
	const asOf = blast.asOfCommit === undefined ? '' : ` as of ${blast.asOfCommit}`;
	lines.push(
		'',
		`_From the code graph${asOf}; imports through tsconfig path aliases or export * barrels may be undercounted._`,
	);
	return lines.join('\n');
}

/** The branch checked out in `root`, or undefined when git fails. */
async function branchOf($: EngineInterface, root: string): Promise<string | undefined> {
	const head = await $.process.run([...GIT, 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, timeoutMs: GIT_TIMEOUT_MS });
	const branch = head.stdout.trim();
	return head.exitCode === 0 && branch !== '' ? branch : undefined;
}

/**
 * The impact section for the branch checked out in `root`, against the PR's
 * base (`origin/<--base>`, else the remote's default branch). Undefined when
 * a git command fails, nothing changed, or the lookup failed or missed
 * `PR_DEADLINE_MS`. Rejects when a git command cannot start or times out.
 */
async function impactSection($: EngineInterface, pr: GhPrCreate, root: string, signal: AbortSignal): Promise<string | undefined> {
	let base: string;
	if (pr.base !== undefined && pr.base !== '') {
		base = `origin/${pr.base}`;
	} else {
		const head = await $.process.run([...GIT, 'symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd: root, timeoutMs: GIT_TIMEOUT_MS });
		const ref = head.stdout.trim();
		if (head.exitCode !== 0 || !ref.startsWith('refs/remotes/')) return undefined;
		base = ref.slice('refs/remotes/'.length);
		if (base === '') return undefined;
	}
	const diff = await $.process.run([...GIT, 'diff', '--no-ext-diff', '--name-only', '--relative', `${base}...HEAD`], { cwd: root, timeoutMs: GIT_TIMEOUT_MS });
	if (diff.exitCode !== 0) return undefined;
	const changed = diff.stdout
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '');
	if (changed.length === 0) return undefined;
	const blast = await withinDeadline(
		(ms, o) => $.clock.sleep(ms, o),
		blastRadius({ connect: (s) => $.mcp.connect(s), call: (s, t, a) => $.mcp.call(s, t, a) }, root, changed, { exports: true }),
		PR_DEADLINE_MS,
		signal,
	);
	return blast === undefined ? undefined : buildImpactSection(changed, blast);
}

export function registerPrImpact(on: On, options: PluginOptions): void {
	mode = modeOf(options.prImpact);
	refused.clear();
	if (mode === 'off') return;

	on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
		const raw = stringArg(e, 'command') ?? '';
		const pr = ghPrCreate(raw);
		if (pr === null) return next(e);
		if (!isConfigured(await $.env.get('CONSTELLATION_ACCESS_KEY'))) return next(e);
		const session = absolute('.', await $.session.cwd());
		const cwd = absolute(pr.dir ?? '.', session);
		// git runs only under the session's directory, never one a `cd` in the command leads out to.
		if (cwd !== session && relativeTo(session, cwd) === null) return next(e);
		const root = await projectRoot(cwd, (p) => $.fs.exists(p));
		if (root === null) return next(e);

		if (mode === 'inform') {
			const r = await next(e);
			if (r.deny !== undefined || r.isError) return r;
			try {
				const branch = await branchOf($, root);
				const section = branch === undefined ? undefined : await impactSection($, pr, root, next.signal);
				if (section !== undefined) $.ui.log(section);
			} catch {
				// A git command that cannot start or times out shows no section.
			}
			return r;
		}

		try {
			// The raw line covers inline and heredoc bodies, whatever their quoting.
			if (HEADING.test(raw) || (pr.body !== undefined && HEADING.test(pr.body))) return next(e);
			// A body on standard input cannot be read here.
			if (pr.bodyFile === '-') return next(e);
			if (pr.bodyFile !== undefined && HEADING.test(await $.fs.read(absolute(pr.bodyFile, cwd)))) return next(e);
			const branch = await branchOf($, root);
			if (branch === undefined) return next(e);
			const key = `${root}\0${branch}`;
			// Each branch is refused once, so the gate never loops.
			if (refused.has(key)) return next(e);
			const section = await impactSection($, pr, root, next.signal);
			if (section === undefined) return next(e);
			refused.add(key);
			return { deny: `${section}\n\n${INSTRUCTION}` };
		} catch {
			// A body file that cannot be read, or a git command that cannot start or times out.
			return next(e);
		}
	});
}

/** Forgets the branches already refused, for a new conversation (`/clear`, `/resume`, `/branch`). */
export function resetPrImpact(): void {
	refused.clear();
}
