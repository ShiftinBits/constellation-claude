import { atom, update } from 'claude-code';
import type { On } from 'claude-code';
import { ADOPTION_SHAPE, background, counted, NO_COUNTS, noteSearch, save } from './adoption';
import { agentKey, hasNudgeLeft, MAIN, spendNudge, usedCodeIntelThisTurn } from './budget';
import { searchTarget } from './classify';
import { isConfigured, projectRoot } from './lib';
import { branded } from './theme';

const ADOPTION = atom({ plugin: 'constellation', key: 'adoption' } as const, NO_COUNTS, { shape: ADOPTION_SHAPE });

/** Added to the model's context with a search tool call's result. */
export const REMINDER_TEXT = branded(
	'Use the code_intel tool before other tools for searching or navigating the codebase. Other search tools (e.g. grep, glob, awk, rg) should be used for literal text search or as a fallback.',
);

export function registerNudges(on: On): void {
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
				const note = noteSearch(isMain, symbolLike);
				// The state write redraws the spinner and the Stats tab; the store keeps the day's counts, whatever the write did.
				await update($, ADOPTION, (b) => counted(b, note)).catch(() => undefined);
				await save(note, {
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
