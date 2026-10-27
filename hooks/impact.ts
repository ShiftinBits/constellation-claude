import type { EngineInterface, On, PluginOptions } from 'claude-code';
import { agentKey } from './budget';
import { absolute, isConfigured, plural, projectRoot, stringArg, withinDeadline } from './lib';
import { atLeast, collectEvidence, type FileRisk, fileRisk, forgetAgentEvidence, hasEvidence, resetRiskCache, type RiskLevel } from './risk';
import { branded, risk as tone } from './theme';

/** What the gate does before an edit to a file at or above the threshold. */
type Mode = 'off' | 'ask' | 'require-analysis';

/** The edit tools the gate watches. */
const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;

/**
 * How long an edit waits for its file's risk before it goes ahead ungated. The
 * hook's own time limit pauses while `$.mcp.call` runs, so a slow server would
 * otherwise hold the edit for code_intel's full timeout. A late lookup still
 * settles into the cache for the next edit.
 */
export const RISK_DEADLINE_MS = 3000;

let mode: Mode = 'off';
let threshold: RiskLevel = 'high';

/**
 * Files whose impact the person has seen and approved an edit of, by absolute
 * path: later edits to them are left to core. Session wide, not per agent: the
 * impact is about the file, not who edits it.
 */
const remembered = new Set<string>();

/** The file each pending ask was about, by the call's `tool_use_id`, until that call resolves. */
const asked = new Map<string, string>();

/** Per agent, the files require-analysis mode has already refused once, by absolute path. */
const assessed = new Map<string, Set<string>>();

/**
 * The risk word first, so a narrow line that cuts the end keeps it, then how
 * many files depend on the file, the file, and the indexed commit when known.
 */
export function impactLine(risk: FileRisk): string {
	const commit = risk.asOfCommit === undefined ? '' : ` · as of ${risk.asOfCommit}`;
	return `${tone(risk.level).word} risk · ${plural(risk.dependents, 'dependent')} · ${risk.path}${commit}`;
}

/** `impactLine` after the brand. */
export function headline(risk: FileRisk): string {
	return branded(impactLine(risk));
}

/** The permission prompt's reason: the headline, then the top dependents when there are any. */
export function promptReason(risk: FileRisk): string {
	const top = risk.topDependents.length > 0 ? ` · top dependents: ${risk.topDependents.join(', ')}` : '';
	return `${headline(risk)}${top}`;
}

/** The refusal the model reads before its first edit to a file it has not looked into. */
function refusal(risk: FileRisk): string {
	const commit = risk.asOfCommit === undefined ? '' : `, as of ${risk.asOfCommit}`;
	const top = risk.topDependents.length > 0 ? ` Top dependents: ${risk.topDependents.join(', ')}.` : '';
	const symbols = risk.usedSymbols.length > 0 ? ` Symbols they import from it: ${risk.usedSymbols.join(', ')}.` : '';
	return branded(`${risk.path} has ${risk.dependents} dependents (${tone(risk.level).word} risk${commit}).${top}${symbols} Check that your change keeps these callers working (use code_intel impactAnalysis / traceSymbolUsage on the symbols you change), then retry the edit.`);
}

function modeOf(value: unknown): Mode {
	// `dialog` and `native` are the option's earlier values for what is now `ask`.
	if (value === 'ask' || value === 'dialog' || value === 'native') return 'ask';
	return value === 'require-analysis' ? 'require-analysis' : 'off';
}

/**
 * The risk of an edit by `tool` to `path` (absolute, normalized) when it is at
 * or above the threshold, else undefined: no access key, no indexed project, a
 * `Write` that creates the file, a failed lookup, or one slower than
 * `RISK_DEADLINE_MS`.
 */
async function gatedRisk($: EngineInterface, tool: string, path: string, signal: AbortSignal): Promise<FileRisk | undefined> {
	if (!isConfigured(await $.env.get('CONSTELLATION_ACCESS_KEY'))) return undefined;
	const root = await projectRoot(absolute('..', path), (p) => $.fs.exists(p));
	if (root === null) return undefined;
	if (tool === 'Write' && !(await $.fs.exists(path))) return undefined;
	const pending = fileRisk(
		{ connect: (s) => $.mcp.connect(s), call: (s, t, a) => $.mcp.call(s, t, a), after: (ms, fn) => $.clock.after(ms, fn) },
		root,
		path,
	);
	const risk = await withinDeadline((ms, o) => $.clock.sleep(ms, o), pending, RISK_DEADLINE_MS, signal);
	return risk !== undefined && atLeast(risk.level, threshold) ? risk : undefined;
}

export function registerImpactGate(on: On, options: PluginOptions): void {
	resetImpact();
	resetRiskCache();
	mode = modeOf(options.impactGate);
	threshold = options.impactThreshold === 'critical' ? 'critical' : 'high';
	collectEvidence(mode === 'require-analysis');

	if (mode === 'require-analysis') {
		on('tool.call', { tool: EDIT_TOOLS }, async ($, e, next) => {
			const raw = stringArg(e, 'file_path') ?? stringArg(e, 'notebook_path');
			if (raw === undefined) return next(e);
			const path = absolute(raw, await $.session.cwd());
			const key = agentKey(e);
			const seen = assessed.get(key) ?? new Set<string>();
			if (seen.has(path)) return next(e);
			// The first edit is the one chance: a lookup that misses the deadline or fails lets
			// it through, and a later refusal would come after the file already changed.
			assessed.set(key, seen);
			seen.add(path);
			const found = await gatedRisk($, String(e.tool), path, next.signal);
			if (found === undefined || hasEvidence(key, [found.path, path], found.usedSymbols)) return next(e);
			return { deny: refusal(found) };
		});
		return;
	}
	if (mode !== 'ask') return;

	// Every return is `next(e)` or a fixed `ask`: core's decision is read from a `$.tool.check`
	// query, never from what `next` resolves to, so the gate cannot turn it into an allow.
	on('tool.check', { tool: EDIT_TOOLS }, async ($, e, next) => {
		// A query (another plugin's `$.tool.check`) has no call id and is never asked about.
		if (e.tool_use_id === undefined) return next(e);
		// With no one to answer, a hook's ask would turn the edit into a refusal.
		if (e.approver === undefined) return next(e);
		const input = typeof e.input === 'object' && e.input !== null ? e.input : undefined;
		const raw = input === undefined ? undefined : (stringArg(input, 'file_path') ?? stringArg(input, 'notebook_path'));
		if (raw === undefined) return next(e);
		// The query skips this hook and asks no settings PreToolUse hook, so it is the rules' and the mode's decision.
		const { decision } = await $.tool.check({ tool: e.tool, input: e.input });
		if (decision === 'deny') return next(e);
		const path = absolute(raw, await $.session.cwd());
		if (remembered.has(path)) return next(e);
		const risk = await gatedRisk($, String(e.tool), path, next.signal);
		if (risk === undefined) return next(e);
		asked.set(e.tool_use_id, path);
		// A hook's ask goes to the approver (a person, or the host's callback), never to the auto-mode classifier.
		return { decision: 'ask', reason: promptReason(risk) };
	});

	// An asked edit that ran was approved with the impact in view: later edits to the file are left to core.
	// A refused or failed edit (its tool reported an error) leaves the file to be asked about again.
	on('tool.call', { tool: EDIT_TOOLS }, async (_$, e, next) => {
		const r = await next(e);
		const id = e.tool_use_id;
		const path = id === undefined ? undefined : asked.get(id);
		if (id === undefined || path === undefined) return r;
		asked.delete(id);
		if (r.deny === undefined && r.isError !== true) remembered.add(path);
		return r;
	});
}

/** Forgets the files already asked about, for a new conversation (`/clear`, `/resume`, `/branch`). */
export function resetImpact(): void {
	remembered.clear();
	asked.clear();
	assessed.clear();
}

/** Drops what the subagent `agentId` has been refused and looked at, when its run ends. */
export function forgetAgentImpact(agentId: string): void {
	assessed.delete(agentId);
	forgetAgentEvidence(agentId);
}
