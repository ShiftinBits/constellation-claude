import { atom, read, update } from 'claude-code';
import type { On, PluginOptions } from 'claude-code';
import { ADOPTION_SHAPE, background, counter, NO_COUNTS, noteCodeIntelCall, save } from './adoption';
import { FRESHNESS_SHAPE, observeEnvelope } from './freshness';
import { absolute, canDraw, isConfigured, parseToolText, projectRoot, stringArg } from './lib';
import { BAND_SHAPE, NO_BAND, observeCodeIntel } from './onboarding';
import { noteCodeIntel } from './risk';

const ADOPTION = atom({ plugin: 'constellation', key: 'adoption' } as const, NO_COUNTS, { shape: ADOPTION_SHAPE });
const BAND = atom({ plugin: 'constellation', key: 'band' } as const, NO_BAND, { shape: BAND_SHAPE });
const FRESHNESS = atom({ plugin: 'constellation', key: 'freshness' } as const, null, { shape: FRESHNESS_SHAPE });

/** How many nudges one agent gets when the option is unset. */
const DEFAULT_NUDGE_LIMIT = 3;

/** The agent key of the main conversation. */
export const MAIN = 'main';

type AgentBudget = {
	/** Nudges spent so far. */
	nudges: number;
	/** The turn in which the agent last called code_intel. */
	codeIntelTurn?: string;
};

/**
 * Per agent, what its budget has spent. Module state only: a reload of the
 * hooks module starts every budget over, which is acceptable.
 */
const budgets = new Map<string, AgentBudget>();

/**
 * The main conversation's current turn, set through `startMainTurn` by the
 * `turn.start` hook in `describe.ts`. A subagent's run is one turn (its loop's
 * `turn.complete` closes the run, and `forgetAgentBudget` then drops its
 * state), so its turn is its `agentId`.
 */
let mainTurn: string | undefined;

let nudgeLimit = DEFAULT_NUDGE_LIMIT;

/** The agent a tool call belongs to: `agentId` in a subagent, else the main conversation. */
export function agentKey(e: object): string {
	return stringArg(e, 'agentId') ?? MAIN;
}

function budgetOf(key: string): AgentBudget {
	let budget = budgets.get(key);
	if (budget === undefined) {
		budget = { nudges: 0 };
		budgets.set(key, budget);
	}
	return budget;
}

/** The turn the agent `key` is in, or undefined before the main conversation's first turn. */
function turnOf(key: string): string | undefined {
	return key === MAIN ? mainTurn : key;
}

/** Records `turnId` as the main conversation's current turn. */
export function startMainTurn(turnId: string): void {
	mainTurn = turnId;
}

/** True when the agent that made the tool call `e` already called code_intel in its current turn. */
export function usedCodeIntelThisTurn(e: object): boolean {
	const key = agentKey(e);
	const turn = turnOf(key);
	return turn !== undefined && budgets.get(key)?.codeIntelTurn === turn;
}

/** True when the agent that made `e` has a nudge left. Spends nothing. */
export function hasNudgeLeft(e: object): boolean {
	return (budgets.get(agentKey(e))?.nudges ?? 0) < nudgeLimit;
}

/** Spends one nudge from the budget of the agent that made `e`; false, spending nothing, once it is used up. */
export function spendNudge(e: object): boolean {
	const budget = budgetOf(agentKey(e));
	if (budget.nudges >= nudgeLimit) return false;
	budget.nudges += 1;
	return true;
}

export function registerBudget(on: On, options: PluginOptions): void {
	const limit = options.nudgeLimit;
	nudgeLimit = typeof limit === 'number' ? limit : DEFAULT_NUDGE_LIMIT;
	budgets.clear();
	mainTurn = undefined;

	on('tool.call', { tool: /code_intel$/ }, async ($, e, next) => {
		const key = agentKey(e);
		const turn = turnOf(key);
		if (turn !== undefined) budgetOf(key).codeIntelTurn = turn;
		const r = await next(e);
		// A plugin's own `$.mcp.call` of code_intel (this one's risk lookups among them) is not the agent's analysis,
		// and the onboarding and the freshness indicator act on its own pings themselves.
		if (next.origin.plugin === 'engine') {
			noteCodeIntel(key, e, r);
			try {
				await observeCodeIntel(r, isConfigured(await $.env.get('CONSTELLATION_ACCESS_KEY')), {
					band: () => read($, BAND),
					setBand: (change) => update($, BAND, change),
					log: async (text) => {
						if (!canDraw(await $.session.surfaces())) $.ui.log(text);
					},
				});
			} catch {
				// The band stays as it was; the agent's answer goes back untouched.
			}
			// A refused call never ran; an errored one is still the agent reaching for code_intel.
			if (r.deny === undefined) {
				const note = noteCodeIntelCall(key === MAIN, parseToolText(r.text, r.isError === true).time);
				const count = counter();
				// Counted and saved in the background: the agent's answer never waits on the state or the store.
				background(async () => {
					await update($, ADOPTION, (b) => count(b, note));
				});
				background(() =>
					save(note, {
						now: () => $.clock.now(),
						sessionId: () => $.session.id(),
						get: (k) => $.store.get(k),
						set: (k, entry) => $.store.set(k, entry),
						keys: () => $.store.keys(),
						del: (k) => $.store.delete(k),
					}),
				);
				try {
					// The index the answer came from, for the project the call ran in. The answer does not wait for git.
					const session = await $.session.cwd();
					const cwd = stringArg(e, 'cwd');
					const root = await projectRoot(cwd === undefined ? session : absolute(cwd, session), (p) => $.fs.exists(p));
					if (root !== null) {
						void observeEnvelope(
							parseToolText(r.text, r.isError === true),
							root,
							(argv, init) => $.process.run(argv, init),
							(view) => update($, FRESHNESS, () => view),
							async (text) => {
								if (!canDraw(await $.session.surfaces())) $.ui.log(text);
							},
						).catch(() => undefined);
					}
				} catch {
					// The indicator stays as it was.
				}
			}
		}
		return r;
	});
}

/** Starts every budget over, for a new conversation (`/clear`, `/resume`, `/branch`). */
export function resetBudgets(): void {
	budgets.clear();
}

/**
 * Drops the budget of the subagent `agentId` when its run ends. A subagent
 * continued later (SendMessage) keeps its id but starts a new run, so it gets a
 * fresh budget and its earlier code_intel call no longer counts as this turn's.
 */
export function forgetAgentBudget(agentId: string): void {
	budgets.delete(agentId);
}
