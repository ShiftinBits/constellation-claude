import type { On } from 'claude-code';
import { forgetAgentLines, resetAugment } from './augment';
import { forgetAgentBudget, resetBudgets } from './budget';
import { resetRiskCache } from './risk';

/**
 * Session lifecycle for the module's state, in one place: a new conversation
 * (`/clear`, `/resume`, `/branch`) starts every budget and shown line over, and
 * a subagent's state is dropped when its run ends.
 */
export function registerSession(on: On): void {
	on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async (_$, e, next) => {
		resetBudgets();
		resetAugment();
		resetRiskCache();
		return next(e);
	});

	on('turn.complete', async (_$, e, next) => {
		if (e.agentId !== undefined) {
			forgetAgentBudget(e.agentId);
			forgetAgentLines(e.agentId);
		}
		return next(e);
	});
}
