import { atom, update } from 'claude-code';
import type { On } from 'claude-code';
import { ADOPTION_SHAPE, endConversation, NO_COUNTS } from './adoption';
import { forgetAgentLines, resetAugment } from './augment';
import { forgetAgentBudget, resetBudgets } from './budget';
import { forgetPane, NO_PANE, PANE_SHAPE } from './command';
import { resetFreshness } from './freshness';
import { forgetAgentImpact, resetImpact } from './impact';
import { isConfigured } from './lib';
import { BAND_SHAPE, NO_BAND, resetBand, resetOnboarding } from './onboarding';
import { resetPrImpact } from './primpact';
import { resetRiskCache } from './risk';
import { resetToolRows } from './toolrows';
import { resetTurnSummary, summarizeTurn } from './turnsummary';

const ADOPTION = atom({ plugin: 'constellation', key: 'adoption' } as const, NO_COUNTS, { shape: ADOPTION_SHAPE });
const BAND = atom({ plugin: 'constellation', key: 'band' } as const, NO_BAND, { shape: BAND_SHAPE });
const PANE_STATE = atom({ plugin: 'constellation', key: 'pane' } as const, NO_PANE, { shape: PANE_SHAPE });

/**
 * Session lifecycle for the module's state, in one place: when a conversation
 * ends and the process goes on with another (`/clear` ends it with `clear`,
 * `/resume` and `/branch` with `resume`), every budget and shown line starts
 * over, and a subagent's state is dropped when its run ends. The main loop's
 * answered turn also gets its impact summary line here.
 */
export function registerSession(on: On): void {
	on('session.end', { reason: ['clear', 'resume'] }, async ($, e, next) => {
		endConversation();
		resetBudgets();
		resetAugment();
		resetRiskCache();
		resetImpact();
		resetTurnSummary();
		resetPrImpact();
		resetToolRows();
		resetOnboarding();
		resetFreshness();
		forgetPane();
		// `$.state` outlasts the conversation, so the next one starts its drawn values over here. The
		// freshness line stays: it describes the repository, not the conversation.
		await Promise.allSettled([update($, ADOPTION, () => NO_COUNTS), update($, BAND, resetBand), update($, PANE_STATE, () => NO_PANE)]);
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
