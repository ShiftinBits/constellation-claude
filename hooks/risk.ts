import { codeIntel, type McpPort, stringArg } from './lib';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type FileRisk = {
	/** Project-relative POSIX path. */
	path: string;
	/** Direct dependents counted; a full page of 100 means 100 or more. */
	dependents: number;
	/** The first three dependents. */
	topDependents: string[];
	exportedSymbols: string[];
	level: RiskLevel;
	/** The first 7 characters of the commit the graph was indexed at. */
	asOfCommit?: string;
};

const LEVELS: readonly RiskLevel[] = ['low', 'medium', 'high', 'critical'];

/** True when `level` ranks at or above `threshold`. */
export function atLeast(level: RiskLevel, threshold: RiskLevel): boolean {
	return LEVELS.indexOf(level) >= LEVELS.indexOf(threshold);
}

/** Untuned placeholder cut-offs on the count of direct dependents. */
function levelOf(dependents: number): RiskLevel {
	if (dependents >= 50) return 'critical';
	if (dependents >= 20) return 'high';
	if (dependents >= 5) return 'medium';
	return 'low';
}

/** `path` relative to `root` in POSIX form, or null when it is outside the root. */
function relativeTo(root: string, path: string): string | null {
	const norm = (p: string) => p.replace(/\\/g, '/');
	const base = norm(root).replace(/\/+$/, '');
	const full = norm(path);
	if (!full.startsWith(`${base}/`)) return null;
	const rel = full.slice(base.length + 1);
	return rel === '' || rel.split('/').includes('..') ? null : rel;
}

/**
 * Runs inside code_intel: `probeCode` sends its source, so it may use only its arguments.
 */
async function probe(api: {
	getDependents: (p: { filePath: string; limit: number }) => Promise<{ directDependents: ReadonlyArray<{ filePath: string }> }>;
	searchSymbols: (p: {
		query: string;
		filterByFile: string;
		isExported: boolean;
		limit: number;
	}) => Promise<{ symbols: ReadonlyArray<{ name: string; filePath: string }> }>;
}, filePath: string) {
	const [deps, found] = await Promise.all([
		api.getDependents({ filePath, limit: 100 }),
		api.searchSymbols({ query: '', filterByFile: filePath, isExported: true, limit: 50 }),
	]);
	return {
		dependents: deps.directDependents.map((d) => d.filePath),
		exported: found.symbols.filter((s) => s.filePath === filePath).map((s) => s.name),
	};
}

function probeCode(rel: string): string {
	return `return await (${probe.toString()})(api, ${JSON.stringify(rel)});`;
}

function strings(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : undefined;
}

/** Settled or in-flight risk by `${root}\0${rel}`. */
const cache = new Map<string, Promise<FileRisk | undefined>>();

/** The commit each root's cached entries were read at. */
const commits = new Map<string, string>();

/**
 * Per agent, the code each of its code_intel calls ran and the text they
 * returned, joined: what the agent has looked at, searched for by substring.
 */
const evidence = new Map<string, string>();

/** Forgets every cached risk and commit, and every agent's evidence. */
export function resetRiskCache(): void {
	cache.clear();
	commits.clear();
	evidence.clear();
}

/** Records a code_intel tool call `e` (its arguments sit on the event itself) and its result `r` as evidence for the agent `key`; a denied call adds nothing. */
export function noteCodeIntel(key: string, e: object, r: object): void {
	if (Reflect.has(r, 'deny')) return;
	const code = stringArg(e, 'code') ?? '';
	const text = stringArg(r, 'text') ?? '';
	evidence.set(key, `${evidence.get(key) ?? ''}\n${code}\n${text}`);
}

/** True when the agent `key` has code_intel evidence that mentions any non-empty `needle`. */
export function hasEvidence(key: string, needles: string[]): boolean {
	const seen = evidence.get(key);
	return seen !== undefined && needles.some((n) => n !== '' && seen.includes(n));
}

/** Drops what the agent `key` has looked at. */
export function forgetAgentEvidence(key: string): void {
	evidence.delete(key);
}

async function load(mcp: McpPort, root: string, rel: string, key: string): Promise<FileRisk | undefined> {
	const envelope = await codeIntel(mcp, probeCode(rel), { cwd: root });
	const result: unknown = envelope.result;
	const body = typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : undefined;
	const dependents = strings(body?.dependents);
	const exported = strings(body?.exported);
	if (!envelope.success || dependents === undefined || exported === undefined) {
		cache.delete(key);
		return undefined;
	}
	const commit = envelope.asOfCommit;
	if (commit !== undefined && commits.get(root) !== commit) {
		if (commits.has(root)) {
			for (const other of [...cache.keys()]) {
				if (other !== key && other.startsWith(`${root}\0`)) cache.delete(other);
			}
		}
		commits.set(root, commit);
	}
	const risk: FileRisk = {
		path: rel,
		dependents: dependents.length,
		topDependents: dependents.slice(0, 3),
		exportedSymbols: exported,
		level: levelOf(dependents.length),
	};
	if (commit !== undefined) risk.asOfCommit = commit.slice(0, 7);
	return risk;
}

/**
 * How far a change to `path` (absolute, inside `root`) reaches in the code
 * graph, or undefined when the path is outside the root or the lookup failed.
 * A failure is not cached, so the next edit retries.
 */
export function fileRisk(mcp: McpPort, root: string, path: string): Promise<FileRisk | undefined> {
	const rel = relativeTo(root, path);
	if (rel === null) return Promise.resolve(undefined);
	const key = `${root}\0${rel}`;
	const known = cache.get(key);
	if (known !== undefined) return known;
	const pending = load(mcp, root, rel, key);
	cache.set(key, pending);
	return pending;
}
