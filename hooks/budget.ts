import type { On, PluginOptions } from 'claude-code';
import { canDraw, isConfigured, stringArg } from './lib';
import { observeCodeIntel } from './onboarding';
import { noteCodeIntel } from './risk';

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
 * The main conversation's current turn, from `turn.start`. A subagent's run is
 * one turn (its loop's `turn.complete` closes the run, and `forgetAgentBudget`
 * then drops its state), so its turn is its `agentId`.
 */
let mainTurn: string | undefined;

/**
 * The subagent a search call runs in, by `tool_use_id`, for the span of the call.
 * The envelope `classic.PreToolUse` receives carries no `agentId`, but it runs
 * inside the same call's `tool.call`, which does.
 */
const searchAgents = new Map<string, string>();

let nudgeLimit = DEFAULT_NUDGE_LIMIT;

/** The agent a tool call belongs to: `agentId` in a subagent, else the main conversation. */
export function agentKey(e: object): string {
	const id = stringArg(e, 'agentId');
	if (id !== undefined) return id;
	const callId = stringArg(e, 'tool_use_id');
	return (callId !== undefined ? searchAgents.get(callId) : undefined) ?? MAIN;
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
	searchAgents.clear();

	on('turn.start', async (_$, e, next) => {
		mainTurn = e.turnId;
		return next(e);
	});

	on('tool.call', { tool: /code_intel$/ }, async ($, e, next) => {
		const key = agentKey(e);
		const turn = turnOf(key);
		if (turn !== undefined) budgetOf(key).codeIntelTurn = turn;
		const r = await next(e);
		// A plugin's own `$.mcp.call` of code_intel (this one's risk lookups among them) is not the agent's analysis,
		// and the onboarding acts on its own pings itself.
		if (next.origin.plugin === 'engine') {
			noteCodeIntel(key, e, r);
			try {
				observeCodeIntel(
					r,
					isConfigured(await $.env.get('CONSTELLATION_ACCESS_KEY')),
					() => $.ui.invalidate('ui.render'),
					async (text) => {
						if (!canDraw(await $.session.surfaces())) $.ui.log(text);
					},
				);
			} catch {
				// The band stays as it was; the agent's answer goes back untouched.
			}
		}
		return r;
	});

	on('tool.call', { tool: /^(Grep|Glob|Bash)$/ }, async (_$, e, next) => {
		if (e.agentId === undefined) return next(e);
		searchAgents.set(e.tool_use_id, e.agentId);
		try {
			return await next(e);
		} finally {
			searchAgents.delete(e.tool_use_id);
		}
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
