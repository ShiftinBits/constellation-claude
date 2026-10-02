import type { EngineInterface, On, PluginOptions } from 'claude-code';
import { agentKey, usedCodeIntelThisTurn } from './budget';
import { searchTarget } from './classify';
import { codeIntel, isConfigured, projectRoot } from './lib';

/**
 * How long a finished search waits for its code_intel lookup before it returns
 * the search result alone. The lookup starts with the search, so it has the
 * search's own time as well. Allows for a cold start of the MCP server.
 */
export const SOFT_DEADLINE_MS = 2500;

/** How long a lookup that failed (server down, sign-in, timeout) is remembered before it is tried again. */
export const FAILURE_BACKOFF_MS = 60_000;

/** What the lookup reports for an exact-name symbol match. */
export type Found = {
	name: string;
	kind: string;
	filePath: string;
	line: number;
	/** The graph's usage count of the symbol. */
	usages: number;
	/** How many symbols carry the name; the one reported is the most used. */
	definitions: number;
};

/**
 * Lookups by project root and identifier: in flight, or settled to a match,
 * null (no exact match) or undefined (failed). A failure is dropped after
 * `FAILURE_BACKOFF_MS`, so a down server costs one lookup a minute, not one per search.
 */
const lookups = new Map<string, Promise<Found | null | undefined>>();

/**
 * Lines already shown, by agent, project root and identifier. Claimed before the
 * lookup is awaited, so parallel searches show one line, and released when no
 * line is shown.
 */
const shown = new Set<string>();

/** The part of code_intel's `api` the lookup uses. */
export type LookupApi = {
	searchSymbols: (params: {
		query: string;
		limit: number;
		includeUsageCount: boolean;
		isExported?: boolean;
	}) => Promise<{ symbols: ReadonlyArray<{ name: string; kind: string; filePath: string; line: number; usageCount?: number }> }>;
};

/**
 * The most used exact-name match for `name`, searched among exported symbols
 * first, then among used symbols that are not exported (an unused one there is
 * usually a fixture, not what the search means), or null when nothing matches.
 * `searchSymbols` matches substrings, so the exact name can sit far down a
 * page; a full page is read.
 *
 * Runs inside code_intel: `lookupCode` sends its source, so it may use only
 * its arguments.
 */
export async function lookupSymbol(api: LookupApi, name: string): Promise<Found | null> {
	const exact = async (isExported?: boolean) =>
		(await api.searchSymbols({ query: name, limit: 100, includeUsageCount: true, ...(isExported ? { isExported } : {}) })).symbols.filter(
			(s) => s.name === name,
		);
	let hits = await exact(true);
	if (hits.length === 0) hits = (await exact()).filter((s) => (s.usageCount ?? 0) > 0);
	const hit = hits.reduce<(typeof hits)[number] | null>((a, b) => (a === null || (b.usageCount ?? 0) > (a.usageCount ?? 0) ? b : a), null);
	if (hit === null) return null;
	return { name: hit.name, kind: hit.kind, filePath: hit.filePath, line: hit.line, usages: hit.usageCount ?? 0, definitions: hits.length };
}

/** The code_intel program that runs `lookupSymbol` for `name`. */
export function lookupCode(name: string): string {
	return `return await (${lookupSymbol.toString()})(api, ${JSON.stringify(name)});`;
}

/** The lookup's result read into `Found`, or null when it is not one. */
function foundOf(value: unknown): Found | null {
	if (typeof value !== 'object' || value === null) return null;
	const name: unknown = Reflect.get(value, 'name');
	const kind: unknown = Reflect.get(value, 'kind');
	const filePath: unknown = Reflect.get(value, 'filePath');
	const line: unknown = Reflect.get(value, 'line');
	const usages: unknown = Reflect.get(value, 'usages');
	const definitions: unknown = Reflect.get(value, 'definitions');
	if (typeof name !== 'string' || typeof kind !== 'string' || typeof filePath !== 'string') return null;
	if (typeof line !== 'number' || typeof usages !== 'number' || typeof definitions !== 'number') return null;
	return { name, kind, filePath, line, usages, definitions };
}

/** The one line a search result gains. */
export function augmentLine({ name, kind, filePath, line, usages, definitions }: Found): string {
	const others = definitions > 1 ? `, the most used of ${definitions} symbols with that name` : '';
	const count = `${usages} ${usages === 1 ? 'usage' : 'usages'}`;
	return `✦ code_intel: ${name} (${kind}) is defined at ${filePath}:${line}${others}, with ${count}. Use code_intel for references, callers, and impact.`;
}

/** The lookup for `name` in the project at `root`, shared with any already in flight or settled. */
function lookup($: EngineInterface, root: string, name: string): Promise<Found | null | undefined> {
	const key = `${root}\0${name}`;
	let pending = lookups.get(key);
	if (pending === undefined) {
		pending = codeIntel(
			{ connect: (s) => $.mcp.connect(s), call: (s, t, a) => $.mcp.call(s, t, a) },
			lookupCode(name),
			{ cwd: root },
		).then((envelope) => {
			if (envelope.success) return foundOf(envelope.result);
			$.clock.after(FAILURE_BACKOFF_MS, () => lookups.delete(key));
			return undefined;
		});
		lookups.set(key, pending);
	}
	return pending;
}

/** `pending` if it settles within `SOFT_DEADLINE_MS` (and before `signal` aborts), else undefined. */
async function withinDeadline(
	$: EngineInterface,
	pending: Promise<Found | null | undefined>,
	signal: AbortSignal,
): Promise<Found | null | undefined> {
	const stop = new AbortController();
	const deadline = $.clock.sleep(SOFT_DEADLINE_MS, { signal: AbortSignal.any([signal, stop.signal]) }).then(
		() => undefined,
		() => undefined,
	);
	try {
		return await Promise.race([pending, deadline]);
	} finally {
		stop.abort();
	}
}

export function registerAugment(on: On, options: PluginOptions): void {
	lookups.clear();
	shown.clear();
	if (options.augmentGrep === false) return;

	on('tool.call', { tool: /^(Grep|Bash)$/ }, async ($, e, next) => {
		if (!isConfigured(await $.env.get('CONSTELLATION_ACCESS_KEY'))) return next(e);
		const { symbol, path } = searchTarget(e);
		if (symbol === null || usedCodeIntelThisTurn(e)) return next(e);
		const root = await projectRoot(await $.session.cwd(), (p) => $.fs.exists(p), path);
		if (root === null) return next(e);
		const seen = `${agentKey(e)}\0${root}\0${symbol}`;
		if (shown.has(seen)) return next(e);

		shown.add(seen);
		const pending = lookup($, root, symbol);
		const r = await next(e);
		if (r.deny !== undefined || r.isError) {
			shown.delete(seen);
			return r;
		}
		const found = await withinDeadline($, pending, next.signal);
		if (found === null || found === undefined) {
			shown.delete(seen);
			return r;
		}
		return { ...r, context: [...(r.context ?? []), augmentLine(found)] };
	});

	on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async (_$, e, next) => {
		lookups.clear();
		shown.clear();
		return next(e);
	});
}
