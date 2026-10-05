import type { EngineInterface, On, PluginOptions } from 'claude-code';
import { agentKey } from './budget';
import { absolute, isConfigured, projectRoot, stringArg, withinDeadline } from './lib';
import { atLeast, collectEvidence, type FileRisk, fileRisk, forgetAgentEvidence, hasEvidence, resetRiskCache, type RiskLevel } from './risk';
import { PROMPT, risk as tone } from './theme';

/** What the gate does before an edit to a file at or above the threshold. */
type Mode = 'off' | 'dialog' | 'native' | 'require-analysis';

const MODES: readonly Mode[] = ['off', 'dialog', 'native', 'require-analysis'];

/** How long the toast for an edit already headed to the permission prompt stays. */
const TOAST_MS = 10_000;

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
 * The session's permission mode as of the last prompt. In `auto` an `ask` goes
 * to the classifier, not a person, so the gate treats it as auto-approved.
 * Read from `classic.UserPromptSubmit`, because `tool.check` and the
 * `classic.PreToolUse` envelope carry no mode; a mode switched mid-turn is seen
 * at the next prompt.
 */
let permissionMode: string | undefined;

/**
 * Files the user chose not to be asked about again, by absolute path. Session
 * wide, not per agent: `tool.check` carries no `agentId`.
 */
const remembered = new Set<string>();

/** Per agent, the files require-analysis mode has already refused once, by absolute path. */
const assessed = new Map<string, Set<string>>();

/** One line naming the file, how many files depend on it and its risk word, with the indexed commit when known. */
export function headline(risk: FileRisk): string {
	const line = `${PROMPT} ${risk.path}: ${risk.dependents} dependents · ${tone(risk.level).word} risk`;
	return risk.asOfCommit === undefined ? line : `${line} (as of ${risk.asOfCommit})`;
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
	return `The user declined this edit to ${risk.path} (${risk.dependents} dependents, ${tone(risk.level).word} risk). Ask before trying a different approach.${words}`;
}

/** The refusal the model reads before its first edit to a file it has not looked into. */
function refusal(risk: FileRisk): string {
	const commit = risk.asOfCommit === undefined ? '' : `, as of ${risk.asOfCommit}`;
	const top = risk.topDependents.length > 0 ? ` Top dependents: ${risk.topDependents.join(', ')}.` : '';
	const symbols = risk.usedSymbols.length > 0 ? ` Symbols they import from it: ${risk.usedSymbols.join(', ')}.` : '';
	return `${PROMPT} ${risk.path} has ${risk.dependents} dependents (${tone(risk.level).word} risk${commit}).${top}${symbols} Check that your change keeps these callers working (use code_intel impactAnalysis / traceSymbolUsage on the symbols you change), then retry the edit.`;
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

	on('classic.UserPromptSubmit', async (_$, e, next) => {
		permissionMode = e.permission_mode;
		return next(e);
	});

	// Every return is `next(e)` or a fixed `ask` or `deny`: core's decision is read from a
	// `$.tool.check` query, never from what `next` resolves to, so the gate cannot turn it into an allow.
	on('tool.check', { tool: /^(Edit|Write|MultiEdit|NotebookEdit)$/ }, async ($, e, next) => {
		// A query (another plugin's `$.tool.check`) has no call id and never opens a dialog or toast.
		if (e.tool_use_id === undefined) return next(e);
		const input = typeof e.input === 'object' && e.input !== null ? e.input : undefined;
		const raw = input === undefined ? undefined : (stringArg(input, 'file_path') ?? stringArg(input, 'notebook_path'));
		if (raw === undefined) return next(e);
		// The query skips this hook and asks no settings PreToolUse hook, so it is the rules' and the mode's decision.
		const { decision } = await $.tool.check({ tool: e.tool, input: e.input });
		if (decision === 'deny') return next(e);
		// In auto mode an ask goes to the classifier: no one would see it, so the gate asks itself.
		const classified = decision === 'ask' && permissionMode === 'auto';
		// An edit headed to the permission prompt needs no downgrade (native) and gets only a toast (dialog).
		if (mode === 'native' && decision === 'ask' && !classified) return next(e);
		// A -p or SDK run has no one to answer: a downgrade there would turn the edit into a refusal.
		if (mode === 'native' && decision === 'allow' && (await $.session.surfaces()).length === 0) return next(e);
		const path = absolute(raw, await $.session.cwd());
		const asks = (mode === 'dialog' && decision === 'allow') || classified;
		if (asks && remembered.has(path)) return next(e);
		const risk = await gatedRisk($, String(e.tool), path, next.signal);
		if (risk === undefined) return next(e);

		const line = headline(risk);
		if (!asks) {
			$.ui.toast(line, { timeoutMs: TOAST_MS });
			// Dialog mode leaves a prompted edit at its prompt; native mode sends an auto-approved one there.
			if (mode !== 'native') return next(e);
			return { decision: 'ask', reason: `${risk.dependents} dependents, ${tone(risk.level).word} risk` };
		}
		// A -p or SDK run has no one to ask: no one would see the dialog, so fail open.
		if ((await $.session.surfaces()).length === 0) {
			$.ui.log(`${line} (could not ask, edit allowed)`);
			return next(e);
		}
		let answer = CANCEL;
		try {
			answer = await $.ui.ask(question(risk), [PROCEED, PROCEED_REMEMBER, CANCEL]);
		} catch {
			// With someone to ask, a rejection is the dialog dismissed (Esc), which refuses.
		}
		// Proceed keeps core's decision, so in auto mode the classifier still decides: the gate only adds a check.
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
	permissionMode = undefined;
	remembered.clear();
	assessed.clear();
}

/** Drops what the subagent `agentId` has been refused and looked at, when its run ends. */
export function forgetAgentImpact(agentId: string): void {
	assessed.delete(agentId);
	forgetAgentEvidence(agentId);
}
