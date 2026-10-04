/** One unused export as the pane lists it and the removal prompt names it. */
export type OrphanRow = {
	symbolId: string;
	name: string;
	kind: string;
	filePath: string;
	/** The graph holds no start line, only the end line, and not for every symbol. */
	lineEnd?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value !== '' ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Runs inside code_intel: `orphanCode` sends its source, so it may use only
 * its arguments. It returns only the fields the pane reads: each row's source
 * snippet would make a page of a large project too big for Claude Code's MCP
 * output limit, which then hands back a note instead of the JSON.
 */
export async function orphanQuery(
	api: { findOrphanedCode: (params: object) => Promise<{ orphanedSymbols?: unknown; summary?: unknown; pagination?: unknown }> },
	params: object,
) {
	const found = await api.findOrphanedCode(params);
	const rows: ReadonlyArray<Record<string, unknown>> = Array.isArray(found.orphanedSymbols) ? found.orphanedSymbols : [];
	return {
		orphanedSymbols: rows.map((s) => ({ symbolId: s.symbolId, name: s.name, kind: s.kind, filePath: s.filePath, lineEnd: s.lineEnd })),
		summary: found.summary,
		pagination: found.pagination,
	};
}

/** The code one page of unused exports sends, with the kind filter and paging in `params`. */
export function orphanCode(params: object): string {
	return `return await (${orphanQuery.toString()})(api, ${JSON.stringify(params)});`;
}

/**
 * One page of a `findOrphanedCode` result: its rows, the total the graph
 * reports, and the offset of the next page when there is one. The result is
 * untyped, so every field is narrowed before it is read.
 */
export function orphanPage(result: unknown): { rows: OrphanRow[]; total?: number; nextOffset?: number } {
	if (!isRecord(result)) return { rows: [] };
	const rows: OrphanRow[] = [];
	if (Array.isArray(result['orphanedSymbols'])) {
		for (const entry of result['orphanedSymbols']) {
			if (!isRecord(entry)) continue;
			const symbolId = str(entry['symbolId']);
			const name = str(entry['name']);
			const filePath = str(entry['filePath']);
			if (symbolId === undefined || name === undefined || filePath === undefined) continue;
			const lineEnd = num(entry['lineEnd']);
			rows.push({ symbolId, name, kind: str(entry['kind']) ?? 'unknown', filePath, ...(lineEnd === undefined ? {} : { lineEnd }) });
		}
	}
	const page: { rows: OrphanRow[]; total?: number; nextOffset?: number } = { rows };
	const total = isRecord(result['summary']) ? num(result['summary']['totalOrphanedSymbols']) : undefined;
	if (total !== undefined) page.total = total;
	const pagination = result['pagination'];
	if (isRecord(pagination) && pagination['hasMore'] === true) {
		const next = num(pagination['nextOffset']);
		if (next !== undefined) page.nextOffset = next;
	}
	return page;
}

/** The rows grouped by file, files in the order they first appear. */
export function byFile(rows: readonly OrphanRow[]): Map<string, OrphanRow[]> {
	const files = new Map<string, OrphanRow[]>();
	for (const row of rows) {
		const group = files.get(row.filePath);
		if (group === undefined) files.set(row.filePath, [row]);
		else group.push(row);
	}
	return files;
}

/** The file, and its end line when the graph has one. */
export function location(row: OrphanRow): string {
	return row.lineEnd === undefined ? row.filePath : `${row.filePath}:${row.lineEnd}`;
}

/**
 * The prompt that hands the picked exports to the model. It asks for a check
 * before any deletion, because the graph can list a symbol as unused when it
 * is only imported through a path alias or an `export *` barrel.
 */
export function removalPrompt(rows: readonly OrphanRow[], commit?: string): string {
	const lines = [
		'Remove these unused exports. For each one, confirm it is unused with code_intel (traceSymbolUsage and impactAnalysis) and a literal text search for string references (reflection, DI tokens, config, framework entry points) before deleting it; skip any that are still referenced. Constellation can report symbols as unused when they are imported through tsconfig path aliases or export * barrels, so do not skip the check.',
	];
	if (commit !== undefined && commit !== '') lines.push(`Graph as of ${commit.slice(0, 7)}.`);
	for (const row of rows) lines.push(`- \`${row.name}\` (${row.kind}) in ${location(row)}`);
	return lines.join('\n');
}
