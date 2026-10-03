import type { On, PluginOptions, ToolCheckResult } from 'claude-code';
import { isConfigured, projectRoot, stringArg } from './lib';
import { atLeast, type FileRisk, fileRisk, type RiskLevel } from './risk';
import { MARK, risk as tone } from './theme';

/** What the gate does before an edit to a file at or above the threshold. */
type Mode = 'off' | 'dialog' | 'native' | 'require-analysis';

const MODES: readonly Mode[] = ['off', 'dialog', 'native', 'require-analysis'];

/** How long the toast for an edit already headed to the permission prompt stays. */
const TOAST_MS = 10_000;

const PROCEED = 'Proceed';
const PROCEED_REMEMBER = "Proceed, and don't ask again for this file";
const CANCEL = 'Cancel';

let mode: Mode = 'off';
let threshold: RiskLevel = 'high';

/**
 * Files the user chose not to be asked about again, by absolute path. Session
 * wide, not per agent: `tool.check` carries no `agentId`.
 */
const remembered = new Set<string>();

/** One line naming the file, how many files depend on it and its risk word, with the indexed commit when known. */
export function headline(risk: FileRisk): string {
	const line = `${MARK} ${risk.path}: ${risk.dependents} dependents · ${tone(risk.level).word} risk`;
	return risk.asOfCommit === undefined ? line : `${line} (as of ${risk.asOfCommit})`;
}

/** The dialog's question: the headline, the top dependents when there are any, and the question itself. */
function question(risk: FileRisk): string {
	const lines = [headline(risk)];
	if (risk.topDependents.length > 0) lines.push(`Top dependents: ${risk.topDependents.join(', ')}`);
	lines.push('Edit it anyway?');
	return lines.join('\n');
}

/** The refusal the model reads when the user declines or dismisses the dialog. */
function declined(risk: FileRisk): ToolCheckResult {
	return {
		decision: 'deny',
		reason: `The user declined this edit to ${risk.path} (${risk.dependents} dependents, ${tone(risk.level).word} risk). Ask before trying a different approach.`,
	};
}

function modeOf(value: unknown): Mode {
	return MODES.find((m) => m === value) ?? 'off';
}

export function registerImpactGate(on: On, options: PluginOptions): void {
	resetImpact();
	mode = modeOf(options.impactGate);
	threshold = options.impactThreshold === 'critical' ? 'critical' : 'high';
	if (mode !== 'dialog' && mode !== 'native') return;

	on('tool.check', { tool: /^(Edit|Write|MultiEdit|NotebookEdit)$/ }, async ($, e, next) => {
		const decided = await next(e);
		// A query (another plugin's `$.tool.check`) has no call id and never opens a dialog or toast.
		if (e.tool_use_id === undefined) return decided;
		const input = typeof e.input === 'object' && e.input !== null ? e.input : undefined;
		const path = input === undefined ? undefined : (stringArg(input, 'file_path') ?? stringArg(input, 'notebook_path'));
		if (path === undefined || decided.decision === 'deny') return decided;
		if (!isConfigured(await $.env.get('CONSTELLATION_ACCESS_KEY'))) return decided;
		const root = await projectRoot(await $.session.cwd(), (p) => $.fs.exists(p), path);
		if (root === null) return decided;
		if (String(e.tool) === 'Write' && !(await $.fs.exists(path))) return decided;
		const risk = await fileRisk({ connect: (s) => $.mcp.connect(s), call: (s, t, a) => $.mcp.call(s, t, a) }, root, path);
		if (risk === undefined || !atLeast(risk.level, threshold)) return decided;

		const line = headline(risk);
		if (mode === 'native') {
			// Only an edit core would run unprompted is downgraded; one that already asks or is denied passes through.
			if (decided.decision !== 'allow') return decided;
			// A -p or SDK run has no one to answer the prompt: downgrading would turn the edit into a refusal.
			if ((await $.session.surfaces()).length === 0) return decided;
			$.ui.toast(line, { timeoutMs: TOAST_MS });
			return { decision: 'ask', reason: `${risk.dependents} dependents, ${tone(risk.level).word} risk` };
		}
		if (decided.decision === 'ask') {
			$.ui.toast(line, { timeoutMs: TOAST_MS });
			return decided;
		}
		if (remembered.has(path)) return decided;
		try {
			const answer = await $.ui.ask(question(risk), [PROCEED, PROCEED_REMEMBER, CANCEL]);
			if (answer === PROCEED) return decided;
			if (answer === PROCEED_REMEMBER) {
				remembered.add(path);
				return decided;
			}
			return declined(risk);
		} catch {
			// Rejected: no one to ask (a headless run), or the user dismissed the dialog.
			const surfaces = await $.session.surfaces();
			if (surfaces.length === 0) {
				$.ui.log(`${line} (no one to ask, edit allowed)`);
				return decided;
			}
			return declined(risk);
		}
	});
}

/** Forgets every file the user chose not to be asked about, for a new conversation (`/clear`, `/resume`, `/branch`). */
export function resetImpact(): void {
	remembered.clear();
}
