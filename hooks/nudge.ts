import type { On } from 'claude-code';
import { bashSearchPattern, globHasSymbolStem, isSymbolLike } from './classify';
import { isConfigured, projectRoot } from './lib';

/** Added to the model's context when a session or a subagent starts. */
export const SESSION_TEXT =
	'You have access to the code_intel source code intelligence tool, this should be your preferred tool for searching or navigating the code base (finding definitions or references, impact analysis, architecture details, etc.). Other search tools (e.g. grep, glob, awk, rg) should be used for literal text search or as a fallback.';

/** Added to the model's context before a search tool call. */
export const REMINDER_TEXT =
	'Use the code_intel tool before other tools for searching or navigating the codebase. Other search tools (e.g. grep, glob, awk, rg) should be used for literal text search or as a fallback.';

type WithContext = { additionalContext?: string[] };

/** `result` with `text` appended to its context, whatever decision it already carries. */
function withContext<R extends WithContext>(result: R, text: string): R {
	return { ...result, additionalContext: [...(result.additionalContext ?? []), text] };
}

/** The string argument `name` of a tool call, or undefined. */
function argOf(e: object, name: string): string | undefined {
	const value: unknown = Reflect.get(e, name);
	return typeof value === 'string' ? value : undefined;
}

/** True when the tool call searches for something that looks like a symbol. */
function isSymbolSearch(tool: string, e: object): boolean {
	switch (tool) {
		case 'Grep':
			return isSymbolLike(argOf(e, 'pattern') ?? '');
		case 'Glob':
			return globHasSymbolStem(argOf(e, 'pattern') ?? '');
		case 'Bash':
			return isSymbolLike(bashSearchPattern(argOf(e, 'command') ?? '') ?? '');
		default:
			return false;
	}
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

	on('classic.PreToolUse', { tool: /^(Grep|Glob|Bash)$/ }, async ($, e, next) => {
		const r = await next(e);
		if (!isConfigured(await $.env.get('CONSTELLATION_ACCESS_KEY'))) return r;
		const tool = String(e.tool);
		if (!isSymbolSearch(tool, e)) return r;
		const searchPath = tool === 'Bash' ? undefined : argOf(e, 'path');
		if ((await projectRoot(await $.session.cwd(), (p) => $.fs.exists(p), searchPath)) === null) return r;
		return withContext(r, REMINDER_TEXT);
	});
}
