import type { On, PluginOptions } from 'claude-code';

/** How many nudges one agent gets when the option is unset. */
const DEFAULT_NUDGE_LIMIT = 3;

/** The agent key of the main conversation. */
const MAIN = 'main';

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
 * The turn each agent is in. `turn.start` carries no `agentId`, so only the main
 * conversation has an entry; a subagent has no turn to scope code_intel use to.
 */
const currentTurn = new Map<string, string>();

let nudgeLimit = DEFAULT_NUDGE_LIMIT;

/** The agent a tool call belongs to: `agentId` in a subagent, else the main conversation. */
function agentKey(e: object): string {
	const id: unknown = Reflect.get(e, 'agentId');
	return typeof id === 'string' ? id : MAIN;
}

function budgetOf(key: string): AgentBudget {
	let budget = budgets.get(key);
	if (budget === undefined) {
		budget = { nudges: 0 };
		budgets.set(key, budget);
	}
	return budget;
}

/** True when the agent that made the tool call `e` already called code_intel in its current turn. */
export function usedCodeIntelThisTurn(e: object): boolean {
	const key = agentKey(e);
	const turn = currentTurn.get(key);
	return turn !== undefined && budgets.get(key)?.codeIntelTurn === turn;
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
	currentTurn.clear();

	on('turn.start', async (_$, e, next) => {
		currentTurn.set(MAIN, e.turnId);
		return next(e);
	});

	on('tool.call', { tool: /code_intel$/ }, async (_$, e, next) => {
		const key = agentKey(e);
		const turn = currentTurn.get(key);
		if (turn !== undefined) budgetOf(key).codeIntelTurn = turn;
		return next(e);
	});

	on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async (_$, e, next) => {
		budgets.clear();
		return next(e);
	});
}
