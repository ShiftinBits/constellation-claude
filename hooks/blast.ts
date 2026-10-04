import { absolute, codeIntel, type McpPort } from './lib';

export type Blast = {
	/** Project-relative files that depend on the inspected files, sorted, minus the inspected files. */
	dependents: string[];
	/** How many of the dependents are test files. */
	tests: number;
	/** Exported symbol names of the inspected files; empty unless asked for. */
	exports: string[];
	/** The first 7 characters of the commit the graph was indexed at. */
	asOfCommit?: string;
};

/** Most files one lookup inspects. */
const MAX_FILES = 50;

/** True for test files: `*.test.*`, `*.spec.*`, a `__tests__`, `test` or `tests` directory, Go `_test.go`, Python `test_*.py`. */
export function isTestFile(path: string): boolean {
	const p = path.replace(/\\/g, '/');
	const name = p.slice(p.lastIndexOf('/') + 1);
	return (
		/\.(?:test|spec)\./.test(name) ||
		/(?:^|\/)(?:__tests__|tests?)\//.test(p) ||
		name.endsWith('_test.go') ||
		/^test_.*\.py$/.test(name)
	);
}

/** `path` (absolute, normalized) relative to `root` in POSIX form, or null when it is outside the root. */
export function relativeTo(root: string, path: string): string | null {
	const base = absolute(root, root).replace(/\/+$/, '');
	return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : null;
}

/**
 * Runs inside code_intel: `blastRadius` sends its source, so it may use only
 * its arguments. A file that is new or not indexed has no dependents rather
 * than failing the call, and a failed export search keeps the dependents.
 */
export async function probe(
	api: {
		getDependents: (p: { filePath: string; limit: number }) => Promise<{
			directDependents: ReadonlyArray<{ filePath: string }>;
		}>;
		searchSymbols: (p: {
			query: string;
			isExported: boolean;
			filterByFile: string;
			limit: number;
		}) => Promise<{ symbols: ReadonlyArray<{ name: string; filePath: string }> }>;
	},
	files: string[],
	withExports: boolean,
) {
	const perFile = await Promise.all(
		files.map(async (file) => {
			let dependents: string[] = [];
			let exported: string[] = [];
			try {
				const deps = await api.getDependents({ filePath: file, limit: 100 });
				dependents = deps.directDependents.map((d) => d.filePath);
			} catch {
				dependents = [];
			}
			// Core reads `*` and `?` in filterByFile as a glob, so such a path cannot name one file.
			if (withExports && !/[*?]/.test(file)) {
				try {
					const found = await api.searchSymbols({ query: '', isExported: true, filterByFile: file, limit: 50 });
					exported = found.symbols.filter((s) => s.filePath === file).map((s) => s.name);
				} catch {
					exported = [];
				}
			}
			return { dependents, exported };
		}),
	);
	const inputs = new Set(files);
	return {
		dependents: [...new Set(perFile.flatMap((f) => f.dependents))].filter((d) => !inputs.has(d)).sort(),
		exports: [...new Set(perFile.flatMap((f) => f.exported))],
	};
}

function strings(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : undefined;
}

/**
 * Who depends on `files` (project-relative, inside `root`) in the code graph,
 * and with `exports` which symbols they export. Undefined when the lookup
 * failed. Never throws.
 */
export async function blastRadius(
	mcp: McpPort,
	root: string,
	files: string[],
	{ exports }: { exports: boolean },
): Promise<Blast | undefined> {
	try {
		const sent = files.slice(0, MAX_FILES);
		const code = `return await (${probe.toString()})(api, ${JSON.stringify(sent)}, ${JSON.stringify(exports)});`;
		const envelope = await codeIntel(mcp, code, { cwd: root });
		const result: unknown = envelope.result;
		const body = typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : undefined;
		const dependents = strings(body?.dependents);
		const names = strings(body?.exports);
		if (!envelope.success || dependents === undefined || names === undefined) return undefined;
		const blast: Blast = { dependents, tests: dependents.filter(isTestFile).length, exports: names };
		const commit = envelope.asOfCommit?.slice(0, 7);
		if (commit !== undefined) blast.asOfCommit = commit;
		return blast;
	} catch {
		return undefined;
	}
}
