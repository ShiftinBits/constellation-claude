import { codeIntel, type McpPort, strings } from './lib';

export type Blast = {
	/** Project-relative files that depend on the inspected files, minus every inspected file, those importing the most of them first. */
	dependents: string[];
	/** How many of the dependents are test files. */
	tests: number;
	/** The inspected files' symbols the dependents import; empty unless asked for. */
	exports: string[];
	/** The first 7 characters of the commit the graph was indexed at. */
	asOfCommit?: string;
	/** How many files past the cap were not looked up; absent when all were. */
	skipped?: number;
	/** True when a file filled its page of dependents, so the count is a floor. */
	atLimit?: true;
};

/**
 * Most files one lookup inspects. code_intel allows 50 `api.*` calls per run
 * and the probe makes one per file.
 */
const MAX_FILES = 50;

/** Most dependents read per file. */
const PAGE = 100;

/**
 * True for test files: `*.test.*`, `*.spec.*`, a `__tests__`, `test` or `tests`
 * directory (any case) or a `.Tests` project, Go `_test.go`, Python `test_*.py`
 * and `*_test.py`, C# and Java `*Test` and `*Tests` classes.
 */
export function isTestFile(path: string): boolean {
	const p = path.replace(/\\/g, '/');
	const name = p.slice(p.lastIndexOf('/') + 1);
	return (
		/\.(?:test|spec)\./.test(name) ||
		/(?:^|\/)(?:__tests__|[Tt]ests?|[^/]+\.Tests?)\//.test(p) ||
		name.endsWith('_test.go') ||
		/^test_.*\.py$/.test(name) ||
		/_test\.py$/.test(name) ||
		/[a-z0-9]Tests?\.(?:cs|java|kt)$/.test(name)
	);
}

/**
 * Runs inside code_intel: `blastRadius` sends its source, so it may use only
 * its arguments. One `getDependents` per file, with the symbols each dependent
 * imports. A file the graph does not know (new, or not indexed) has no
 * dependents; any other failure (auth, the server, the call cap) fails the
 * whole lookup rather than reading as zero.
 */
export async function probe(
	api: {
		getDependents: (p: { filePath: string; limit: number; includeSymbols: boolean }) => Promise<{
			directDependents: ReadonlyArray<{ filePath: string; usedSymbols?: readonly string[] }>;
		}>;
	},
	files: string[],
	withSymbols: boolean,
	page: number,
) {
	const perFile = await Promise.all(
		files.map(async (filePath) => {
			try {
				const found = await api.getDependents({ filePath, limit: page, includeSymbols: withSymbols });
				return found.directDependents;
			} catch (error) {
				if (/File not found/.test(error instanceof Error ? error.message : String(error))) return [];
				throw error;
			}
		}),
	);
	return {
		dependents: perFile.flat().map((d) => ({ filePath: d.filePath, symbols: [...(d.usedSymbols ?? [])] })),
		atLimit: perFile.some((d) => d.length >= page),
	};
}

/**
 * Who depends on `files` (project-relative, inside `root`) in the code graph,
 * and with `exports` which of their symbols those dependents import.
 * Undefined when the lookup failed. Never throws.
 */
export async function blastRadius(
	mcp: McpPort,
	root: string,
	files: string[],
	{ exports }: { exports: boolean },
): Promise<Blast | undefined> {
	try {
		const sent = files.slice(0, MAX_FILES);
		const code = `return await (${probe.toString()})(api, ${JSON.stringify(sent)}, ${JSON.stringify(exports)}, ${PAGE});`;
		const envelope = await codeIntel(mcp, code, { cwd: root });
		const result: unknown = envelope.result;
		const body = typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : undefined;
		const edges = Array.isArray(body?.dependents) ? (body.dependents as unknown[]) : undefined;
		if (!envelope.success || edges === undefined) return undefined;
		// Every changed file is excluded, past the cap too: it is a changed file, not a dependent.
		const changed = new Set(files);
		const hits = new Map<string, number>();
		const used = new Set<string>();
		for (const edge of edges) {
			const filePath: unknown = typeof edge === 'object' && edge !== null ? Reflect.get(edge, 'filePath') : undefined;
			const symbols = strings(typeof edge === 'object' && edge !== null ? Reflect.get(edge, 'symbols') : undefined);
			if (typeof filePath !== 'string' || symbols === undefined) return undefined;
			if (changed.has(filePath)) continue;
			hits.set(filePath, (hits.get(filePath) ?? 0) + 1);
			for (const symbol of symbols) used.add(symbol);
		}
		const dependents = [...hits.keys()].sort((a, b) => (hits.get(b) ?? 0) - (hits.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0));
		const blast: Blast = { dependents, tests: dependents.filter(isTestFile).length, exports: [...used] };
		const commit = envelope.asOfCommit?.slice(0, 7);
		if (commit !== undefined) blast.asOfCommit = commit;
		if (files.length > sent.length) blast.skipped = files.length - sent.length;
		if (body?.atLimit === true) blast.atLimit = true;
		return blast;
	} catch {
		return undefined;
	}
}
