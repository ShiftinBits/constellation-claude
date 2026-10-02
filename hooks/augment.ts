import type { On, PluginOptions } from 'claude-code';
import { usedCodeIntelThisTurn } from './budget';
import { bashSearchPattern, symbolOf } from './classify';
import { codeIntel, isConfigured, projectRoot } from './lib';

/**
 * How long a search waits for its code_intel lookup before it returns the
 * search result alone. Allows for a cold start of the MCP server.
 */
export const SOFT_DEADLINE_MS = 2500;

/** What the lookup reports for an exact-name symbol match. */
type Found = { name: string; kind: string; filePath: string; line: number; dependents: number };

/**
 * Identifiers already augmented. Each is augmented once per load of the hooks
 * module; a lookup that fails, times out or finds no exact match does not count.
 */
const augmented = new Set<string>();

/** The string argument `name` of a tool call, or undefined. */
function argOf(e: object, name: string): string | undefined {
	const value: unknown = Reflect.get(e, name);
	return typeof value === 'string' ? value : undefined;
}

/**
 * The code_intel program for `name`: the exact-name match among the first three
 * search results, with the number of files that import it (or the whole file),
 * or null when nothing matches exactly.
 */
function lookupCode(name: string): string {
	return `const NAME = ${JSON.stringify(name)};
const { symbols } = await api.searchSymbols({ query: NAME, limit: 3 });
const hit = symbols.find((s) => s.name === NAME);
if (!hit) return null;
const { directDependents } = await api.getDependents({ filePath: hit.filePath, includeSymbols: true });
const dependents = directDependents.filter((d) => (d.usedSymbols ?? []).some((s) => s === NAME || s === '*')).length;
return { name: hit.name, kind: hit.kind, filePath: hit.filePath, line: hit.line, dependents };`;
}

/** The lookup's result read into `Found`, or null when it is not one. */
function foundOf(value: unknown): Found | null {
	if (typeof value !== 'object' || value === null) return null;
	const name: unknown = Reflect.get(value, 'name');
	const kind: unknown = Reflect.get(value, 'kind');
	const filePath: unknown = Reflect.get(value, 'filePath');
	const line: unknown = Reflect.get(value, 'line');
	const dependents: unknown = Reflect.get(value, 'dependents');
	if (typeof name !== 'string' || typeof kind !== 'string' || typeof filePath !== 'string') return null;
	if (typeof line !== 'number' || typeof dependents !== 'number') return null;
	return { name, kind, filePath, line, dependents };
}

/** The one line a search result gains. */
export function augmentLine({ name, kind, filePath, line, dependents }: Found): string {
	return `✦ code_intel: ${name} is a ${kind} at ${filePath}:${line} (${dependents} dependents). Use code_intel for references, callers, and impact.`;
}

export function registerAugment(on: On, options: PluginOptions): void {
	augmented.clear();
	if (options.augmentGrep === false) return;

	on('tool.call', { tool: /^(Grep|Bash)$/ }, async ($, e, next) => {
		const r = await next(e);
		if (r.deny !== undefined || r.isError) return r;
		if (!isConfigured(await $.env.get('CONSTELLATION_ACCESS_KEY'))) return r;
		const isBash = String(e.tool) === 'Bash';
		const name = symbolOf(isBash ? (bashSearchPattern(argOf(e, 'command') ?? '') ?? '') : (argOf(e, 'pattern') ?? ''));
		if (name === null || augmented.has(name) || usedCodeIntelThisTurn(e)) return r;
		const root = await projectRoot(await $.session.cwd(), (p) => $.fs.exists(p), isBash ? undefined : argOf(e, 'path'));
		if (root === null) return r;

		const lookup = codeIntel(
			{ connect: (s) => $.mcp.connect(s), call: (s, t, a) => $.mcp.call(s, t, a) },
			lookupCode(name),
			{ cwd: root },
		);
		const deadline = $.clock.sleep(SOFT_DEADLINE_MS, { signal: next.signal }).then(
			() => undefined,
			() => undefined,
		);
		const envelope = await Promise.race([lookup, deadline]);
		if (envelope === undefined || !envelope.success) return r;
		const found = foundOf(envelope.result);
		if (found === null) return r;

		augmented.add(name);
		return { ...r, context: [...(r.context ?? []), augmentLine(found)] };
	});
}
