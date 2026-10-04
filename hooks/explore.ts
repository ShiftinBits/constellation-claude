/** One symbol a search found, as the explorer lists and drills into it. */
export type Hit = {
	id: string;
	name: string;
	kind: string;
	filePath: string;
	line?: number;
};

/** What the impact section shows, narrowed from an `impactAnalysis` result. */
export type ImpactView = {
	riskLevel?: string;
	files?: number;
	direct?: number;
	transitive?: number;
	tests?: number;
	production?: number;
	top: { name: string; kind: string }[];
};

/** One line of the call tree: its text and how far from the root it sits. */
export type CallLine = { text: string; depth: number };

const TOP_DEPENDENTS = 10;
const USAGE_ROWS = 15;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value !== '' ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function entries(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** The symbols of a `searchSymbols` result. The result is untyped, so every field is narrowed before it is read. */
export function hits(result: unknown): Hit[] {
	if (!isRecord(result)) return [];
	const found: Hit[] = [];
	for (const entry of entries(result['symbols'])) {
		const id = str(entry['id']);
		const name = str(entry['name']);
		if (id === undefined || name === undefined) continue;
		const line = num(entry['line']);
		found.push({ id, name, kind: str(entry['kind']) ?? 'unknown', filePath: str(entry['filePath']) ?? '', ...(line === undefined ? {} : { line }) });
	}
	return found;
}

/**
 * The hits with exact name matches first (same case, then any case), the rest
 * in the server's order. `searchSymbols` matches substrings in name order, so
 * the exact name can sit far down its page.
 */
export function rankExact(query: string, found: readonly Hit[]): Hit[] {
	const lower = query.toLowerCase();
	const same = found.filter((h) => h.name === query);
	const any = found.filter((h) => h.name !== query && h.name.toLowerCase() === lower);
	const rest = found.filter((h) => h.name.toLowerCase() !== lower);
	return [...same, ...any, ...rest];
}

/** The file, and the line when the graph has one. */
export function where(hit: Hit): string {
	return hit.line === undefined ? hit.filePath : `${hit.filePath}:${hit.line}`;
}

/**
 * Runs inside code_intel: `searchCode` sends its source, so it may use only
 * its arguments. It returns only the fields the explorer reads: each match's
 * source snippet would make a full page too big for Claude Code's MCP output
 * limit, which then hands back a note instead of the JSON.
 */
export async function searchQuery(api: { searchSymbols: (params: { query: string; limit: number }) => Promise<{ symbols?: unknown }> }, query: string) {
	const found = await api.searchSymbols({ query, limit: 100 });
	const symbols: ReadonlyArray<Record<string, unknown>> = Array.isArray(found.symbols) ? found.symbols : [];
	return { symbols: symbols.map((s) => ({ id: s.id, name: s.name, kind: s.kind, filePath: s.filePath, line: s.line })) };
}

/** The code the search sends. */
export function searchCode(query: string): string {
	return `return await (${searchQuery.toString()})(api, ${JSON.stringify(query)});`;
}

/**
 * The kinds that have a call graph. Core refuses `getCallGraph` for any other
 * kind (a constant, class or variable), and a function assigned to a constant
 * is indexed as a function, so it is not left out.
 */
const CALLABLE: ReadonlySet<string> = new Set(['function', 'method', 'generator']);

/** True when a symbol of `kind` has a call graph to show. */
export function hasCallGraph(kind: string): boolean {
	return CALLABLE.has(kind);
}

/**
 * The code one drill-down sends: the reads in one run, the call graph only for
 * a kind that has one, since one refused read fails the whole run.
 */
export function drillCode(id: string, kind: string): string {
	const symbolId = JSON.stringify(id);
	const calls = hasCallGraph(kind) ? 'api.getCallGraph({ symbolId, depth: 2 })' : 'null';
	return `const symbolId = ${symbolId}; const [details, usages, impact, calls] = await Promise.all([api.getSymbolDetails({ symbolId }), api.traceSymbolUsage({ symbolId, limit: 20 }), api.impactAnalysis({ symbolId }), ${calls}]); return { details, usages, impact, calls }`;
}

/** The signature, kind, whether it is exported and its complexity, from a `getSymbolDetails` result. */
export function detailLines(details: unknown): string[] {
	const symbol = isRecord(details) && isRecord(details['symbol']) ? details['symbol'] : undefined;
	if (symbol === undefined) return [];
	const lines: string[] = [];
	const signature = str(symbol['signature']);
	if (signature !== undefined) lines.push(`Signature: ${signature}`);
	const kind = str(symbol['kind']);
	if (kind !== undefined) lines.push(`Kind: ${kind}`);
	if (typeof symbol['isExported'] === 'boolean') lines.push(`Exported: ${symbol['isExported'] ? 'yes' : 'no'}`);
	const complexity = isRecord(symbol['complexity']) ? symbol['complexity'] : undefined;
	const cyclomatic = complexity === undefined ? undefined : num(complexity['cyclomaticComplexity']);
	if (cyclomatic !== undefined) {
		const level = complexity === undefined ? undefined : str(complexity['complexityRisk']);
		lines.push(`Complexity: ${cyclomatic}${level === undefined ? '' : ` (${level})`}`);
	}
	return lines;
}

/** The totals, then up to 15 `file:line usageType` rows, from a `traceSymbolUsage` result. */
export function usageLines(usages: unknown): string[] {
	if (!isRecord(usages)) return [];
	const lines: string[] = [];
	const summary = isRecord(usages['summary']) ? usages['summary'] : {};
	const total = num(summary['totalUsages']);
	const files = num(summary['filesAffected']);
	if (total !== undefined) lines.push(`${total} usage${total === 1 ? '' : 's'}${files === undefined ? '' : ` in ${files} file${files === 1 ? '' : 's'}`}`);
	for (const usage of entries(usages['directUsages']).slice(0, USAGE_ROWS)) {
		const file = str(usage['filePath']);
		if (file === undefined) continue;
		const line = num(usage['line']);
		const type = str(usage['usageType']);
		lines.push(`${line === undefined ? file : `${file}:${line}`}${type === undefined ? '' : ` ${type}`}`);
	}
	return lines;
}

/** The risk, the counts and the top dependents of an `impactAnalysis` result. */
export function impactView(impact: unknown): ImpactView {
	const view: ImpactView = { top: [] };
	if (!isRecord(impact)) return view;
	const risk = isRecord(impact['breakingChangeRisk']) ? str(impact['breakingChangeRisk']['riskLevel']) : undefined;
	if (risk !== undefined) view.riskLevel = risk;
	const summary = isRecord(impact['summary']) ? impact['summary'] : {};
	const counts = {
		files: num(summary['impactedFileCount']),
		direct: num(summary['directDependentCount']),
		transitive: num(summary['transitiveDependentCount']),
		tests: num(summary['testFileCount']),
		production: num(summary['productionFileCount']),
	};
	for (const [key, value] of Object.entries(counts)) {
		if (value !== undefined) view[key as 'files' | 'direct' | 'transitive' | 'tests' | 'production'] = value;
	}
	for (const dependent of entries(impact['directDependents']).slice(0, TOP_DEPENDENTS)) {
		const name = str(dependent['name']);
		if (name !== undefined) view.top.push({ name, kind: str(dependent['kind']) ?? 'unknown' });
	}
	return view;
}

function node(entry: Record<string, unknown>): CallLine | undefined {
	const name = str(entry['name']);
	if (name === undefined) return undefined;
	const file = str(entry['filePath']);
	const line = num(entry['line']);
	const place = file === undefined ? '' : `  ${line === undefined ? file : `${file}:${line}`}`;
	return { text: `${name}${place}`, depth: Math.max(0, Math.trunc(num(entry['depth']) ?? 1)) };
}

/**
 * The call graph as lines to indent by depth: callers above the root (the
 * farthest first) and callees below it. The lists are flat with no parent, so
 * depth is all the structure there is.
 */
export function callTree(calls: unknown): CallLine[] {
	if (!isRecord(calls)) return [];
	const callers = entries(calls['callers']).flatMap((c) => node(c) ?? []);
	const callees = entries(calls['callees']).flatMap((c) => node(c) ?? []);
	const root = isRecord(calls['root']) ? str(calls['root']['name']) : undefined;
	return [
		...callers.sort((a, b) => b.depth - a.depth),
		...(root === undefined ? [] : [{ text: root, depth: 0 }]),
		...callees.sort((a, b) => a.depth - b.depth),
	];
}

/** The prompt that hands one symbol to the model. */
export function askText(hit: Hit): string {
	return `Explain \`${hit.name}\` (${hit.kind}) at ${where(hit)} in this codebase: what it does, who calls it, and what would break if it changed.`;
}
