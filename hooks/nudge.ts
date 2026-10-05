import type { On } from 'claude-code';
import { background, noteSearch, save, showsAdoption } from './adoption';
import { agentKey, hasNudgeLeft, MAIN, spendNudge, usedCodeIntelThisTurn } from './budget';
import { searchTarget } from './classify';
import { isConfigured, projectRoot } from './lib';

/** Added to the model's context when a session or a subagent starts. */
export const SESSION_TEXT =
	'You have access to the code_intel source code intelligence tool, this should be your preferred tool for searching or navigating the code base (finding definitions or references, impact analysis, architecture details, etc.). Other search tools (e.g. grep, glob, awk, rg) should be used for literal text search or as a fallback.';

/** Added to the model's context with a search tool call's result. */
export const REMINDER_TEXT =
	'Use the code_intel tool before other tools for searching or navigating the codebase. Other search tools (e.g. grep, glob, awk, rg) should be used for literal text search or as a fallback.';

type WithContext = { additionalContext?: string[] };

/** `result` with `text` appended to its context, whatever decision it already carries. */
function withContext<R extends WithContext>(result: R, text: string): R {
	return { ...result, additionalContext: [...(result.additionalContext ?? []), text] };
}

export function registerNudges(on: On): void {
	on('classic.SessionStart', async ($, e, next) => {
		const r = await next(e);
		if (!isConfigured(await $.env.get('CONSTELLATION_ACCESS_KEY'))) return r;
		return withContext(r, SESSION_TEXT);
	});

	on('classic.SubagentStart', async ($, e, next) => {
		const r = await next(e);
		if (!isConfigured(await $.env.get('CONSTELLATION_ACCESS_KEY'))) return r;
		return withContext(r, SESSION_TEXT);
	});

	// On `tool.call`, not `classic.PreToolUse`: adding context means reading what `next` resolved to,
	// and a hook on a permission event has to return that unread.
	on('tool.call', { tool: /^(Grep|Glob|Bash)$/ }, async ($, e, next) => {
		const { isSearch, symbolLike, path } = searchTarget(e);
		const r = await next(e);
		if (r.deny !== undefined) return r;
		if (!isConfigured(await $.env.get('CONSTELLATION_ACCESS_KEY'))) return r;
		// One walk for constellation.json per call, shared by the count and the reminder.
		let walk: Promise<boolean> | undefined;
		const inProject = (): Promise<boolean> =>
			(walk ??= (async () => (await projectRoot(await $.session.cwd(), (p) => $.fs.exists(p), path)) !== null)());
		// Counted only where code_intel could have answered: the agent's own search, with a key, inside an indexed project.
		// It runs in the background, so the search's answer waits on neither the walk nor the store.
		if (isSearch && next.origin.plugin === 'engine') {
			const isMain = agentKey(e) === MAIN;
			background(async () => {
				if (!(await inProject())) return;
				const counted = noteSearch(isMain, symbolLike);
				// A literal search changes nothing the spinner shows.
				if (symbolLike && showsAdoption()) $.ui.invalidate('ui.render');
				await save(counted, {
					now: () => $.clock.now(),
					sessionId: () => $.session.id(),
					get: (k) => $.store.get(k),
					set: (k, entry) => $.store.set(k, entry),
					keys: () => $.store.keys(),
					del: (k) => $.store.delete(k),
				});
			});
		}
		if (!symbolLike || usedCodeIntelThisTurn(e) || !hasNudgeLeft(e)) return r;
		if (!(await inProject())) return r;
		if (!spendNudge(e)) return r;
		return { ...r, context: [...(r.context ?? []), REMINDER_TEXT] };
	});
}
