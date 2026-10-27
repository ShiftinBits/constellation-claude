import type { EngineInterface, On, PluginOptions } from 'claude-code';
import { agentKey } from './budget';
import { absolute, isConfigured, plural, projectRoot, stringArg, withinDeadline } from './lib';
import { atLeast, collectEvidence, type FileRisk, fileRisk, forgetAgentEvidence, hasEvidence, resetRiskCache, type RiskLevel } from './risk';
import { branded, risk as tone } from './theme';

/** What the gate does before an edit to a file at or above the threshold. */
type Mode = 'off' | 'dialog' | 'native' | 'require-analysis';

const MODES: readonly Mode[] = ['off', 'dialog', 'native', 'require-analysis'];

/**
 * How long an edit waits for its file's risk before it goes ahead ungated. The
 * hook's own time limit pauses while `$.mcp.call` runs, so a slow server would
 * otherwise hold the edit for code_intel's full timeout. A late lookup still
 * settles into the cache for the next edit.
 */
export const RISK_DEADLINE_MS = 3000;

const PROCEED = 'Proceed';
const PROCEED_REMEMBER = "Proceed, and don't ask again for this file";
const CANCEL = 'Cancel';

let mode: Mode = 'off';
let threshold: RiskLevel = 'high';

/**
 * Files the user chose not to be asked about again, by absolute path. Session
 * wide, not per agent. `tool.check` has carried `agentId` since 2.1.290, but
 * the choice is about the file, not who edits it.
 */
const remembered = new Set<string>();

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

/** `impactLine` after the brand, for the dialog or a permission prompt's reason. */
export function headline(risk: FileRisk): string {
	return branded(impactLine(risk));
}

/** The dialog's question: the headline, the top dependents when there are any, and the question itself. */
function question(risk: FileRisk): string {
	const lines = [headline(risk)];
	if (risk.topDependents.length > 0) lines.push(`Top dependents: ${risk.topDependents.join(', ')}`);
	lines.push('Edit it anyway?');
	return lines.join('\n');
}

/** The refusal the model reads when the user declines or dismisses the dialog, with what they typed under "Other". */
function declined(risk: FileRisk, said?: string): string {
	const words = said === undefined ? '' : ` The user said: "${said}"`;
	return branded(`The user declined this edit to ${risk.path} (${impactLine(risk)}). Ask before trying a different approach.${words}`);
}

/** The refusal the model reads before its first edit to a file it has not looked into. */
function refusal(risk: FileRisk): string {
	const commit = risk.asOfCommit === undefined ? '' : `, as of ${risk.asOfCommit}`;
	const top = risk.topDependents.length > 0 ? ` Top dependents: ${risk.topDependents.join(', ')}.` : '';
	const symbols = risk.usedSymbols.length > 0 ? ` Symbols they import from it: ${risk.usedSymbols.join(', ')}.` : '';
	return branded(`${risk.path} has ${risk.dependents} dependents (${tone(risk.level).word} risk${commit}).${top}${symbols} Check that your change keeps these callers working (use code_intel impactAnalysis / traceSymbolUsage on the symbols you change), then retry the edit.`);
}

function modeOf(value: unknown): Mode {
	return MODES.find((m) => m === value) ?? 'off';
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
		on('tool.call', { tool: /^(Edit|Write|MultiEdit|NotebookEdit)$/ }, async ($, e, next) => {
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
	if (mode !== 'dialog' && mode !== 'native') return;

	// Every return is `next(e)` or a fixed `ask` or `deny`: core's decision is read from a
	// `$.tool.check` query, never from what `next` resolves to, so the gate cannot turn it into an allow.
	on('tool.check', { tool: /^(Edit|Write|MultiEdit|NotebookEdit)$/ }, async ($, e, next) => {
		// A query (another plugin's `$.tool.check`) has no call id and never opens a dialog.
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
		// A file the person chose not to be asked about again is never asked about, whoever answers this edit.
		if (remembered.has(path)) return next(e);
		// Only an edit core would run, with a person to answer, gets the plugin's own dialog.
		const dialog = mode === 'dialog' && decision === 'allow' && e.approver === 'person';
		const risk = await gatedRisk($, String(e.tool), path, next.signal);
		if (risk === undefined) return next(e);
		// A hook's ask goes to a person or the host's callback, never to the auto-mode classifier.
		if (!dialog) return { decision: 'ask', reason: headline(risk) };

		let answer = CANCEL;
		try {
			answer = await $.ui.ask(question(risk), [PROCEED, PROCEED_REMEMBER, CANCEL]);
		} catch {
			// With a person to ask, a rejection is the dialog dismissed (Esc), which refuses.
		}
		if (answer === PROCEED) return next(e);
		if (answer === PROCEED_REMEMBER) {
			remembered.add(path);
			return next(e);
		}
		return { decision: 'deny', reason: declined(risk, answer === CANCEL ? undefined : answer) };
	});
}

/** Forgets every file the user chose not to be asked about, for a new conversation (`/clear`, `/resume`, `/branch`). */
export function resetImpact(): void {
	remembered.clear();
	assessed.clear();
}

/** Drops what the subagent `agentId` has been refused and looked at, when its run ends. */
export function forgetAgentImpact(agentId: string): void {
	assessed.delete(agentId);
	forgetAgentEvidence(agentId);
}
