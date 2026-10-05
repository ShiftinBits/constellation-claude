import type { On } from 'claude-code';
import { resetAdoption } from './adoption';
import { forgetAgentLines, resetAugment } from './augment';
import { forgetAgentBudget, resetBudgets } from './budget';
import { resetFreshness } from './freshness';
import { forgetAgentImpact, resetImpact } from './impact';
import { isConfigured } from './lib';
import { resetOnboarding } from './onboarding';
import { resetPrImpact } from './primpact';
import { resetRiskCache } from './risk';
import { resetToolRows } from './toolrows';
import { resetTurnSummary, summarizeTurn } from './turnsummary';

/**
 * Session lifecycle for the module's state, in one place: a new conversation
 * (`/clear`, `/resume`, `/branch`) starts every budget and shown line over, and
 * a subagent's state is dropped when its run ends. The main loop's answered
 * turn also gets its impact summary line here.
 */
export function registerSession(on: On): void {
	on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async (_$, e, next) => {
		resetBudgets();
		resetAugment();
		resetRiskCache();
		resetImpact();
		resetTurnSummary();
		resetPrImpact();
		resetToolRows();
		resetOnboarding();
		resetAdoption();
		resetFreshness();
		return next(e);
	});

	on('turn.complete', async ($, e, next) => {
		if (e.agentId !== undefined) {
			forgetAgentBudget(e.agentId);
			forgetAgentLines(e.agentId);
			forgetAgentImpact(e.agentId);
			return next(e);
		}
		if (e.isAborted || e.reason !== 'answer') {
			resetTurnSummary();
			return next(e);
		}
		const r = await next(e);
		try {
			if (!isConfigured(await $.env.get('CONSTELLATION_ACCESS_KEY'))) return r;
			const line = await summarizeTurn(
				{
					exists: (p) => $.fs.exists(p),
					mcp: { connect: (s) => $.mcp.connect(s), call: (s, t, a) => $.mcp.call(s, t, a) },
					sleep: (ms, o) => $.clock.sleep(ms, o),
				},
				next.signal,
			);
			if (line === undefined) return r;
			// A line another hook beneath already set stays, with this one under it.
			return { ...r, text: r.text !== undefined && r.text !== e.answer ? `${r.text}\n${line}` : line };
		} catch {
			return r;
		} finally {
			// Every main-loop turn ends here, so the next one starts with an empty record, whatever happened above.
			resetTurnSummary();
		}
	});
}
