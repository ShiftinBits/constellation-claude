import { absolute, codeIntel, type McpPort, stringArg } from './lib';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type FileRisk = {
	/** Project-relative POSIX path. */
	path: string;
	/** Direct dependents counted; a full page of 100 means 100 or more. */
	dependents: number;
	/** The first three dependents. */
	topDependents: string[];
	/** The file's symbols its dependents import. */
	usedSymbols: string[];
	level: RiskLevel;
	/** The first 7 characters of the commit the graph was indexed at. */
	asOfCommit?: string;
};

/**
 * What `fileRisk` calls: code_intel through the MCP server, and a timer that
 * drops a cached answer (`(ms, fn) => $.clock.after(ms, fn)`).
 */
export type RiskPort = McpPort & { after: (ms: number, fn: () => void) => unknown };

/** How long a failed lookup (server down, a file not in the graph) is remembered before it is tried again. */
export const RETRY_MS = 60_000;

/** How long a risk is trusted before it is read again, so a reindex shows up even for a file already cached. */
export const FRESH_MS = 5 * 60_000;

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

/** `path` (absolute, normalized) relative to `root` in POSIX form, or null when it is outside the root. */
function relativeTo(root: string, path: string): string | null {
	const base = absolute(root, root).replace(/\/+$/, '');
	return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : null;
}

/**
 * Runs inside code_intel: `probeCode` sends its source, so it may use only its
 * arguments. One query gives both the dependents and, exactly, which of the
 * file's symbols they import.
 */
async function probe(api: {
	getDependents: (p: { filePath: string; limit: number; includeSymbols: boolean }) => Promise<{
		directDependents: ReadonlyArray<{ filePath: string; usedSymbols?: readonly string[] }>;
	}>;
}, filePath: string) {
	const deps = await api.getDependents({ filePath, limit: 100, includeSymbols: true });
	return {
		dependents: deps.directDependents.map((d) => d.filePath),
		used: [...new Set(deps.directDependents.flatMap((d) => d.usedSymbols ?? []))],
	};
}

function probeCode(rel: string): string {
	return `return await (${probe.toString()})(api, ${JSON.stringify(rel)});`;
}

function strings(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : undefined;
}

/** Settled or in-flight risk by `${root}\0${rel}`; undefined when the lookup failed. */
const cache = new Map<string, Promise<FileRisk | undefined>>();

/** The commit each root's cached entries were read at. */
const commits = new Map<string, string>();

/** Bumped by every reset, so a lookup started before one leaves the newer cache alone. */
let generation = 0;

/** The code_intel methods whose use on a file or its symbols counts as looking at its impact. */
const ANALYSIS = /\bapi\.(?:impactAnalysis|traceSymbolUsage|getDependents)\s*\(/;

/** String literals in a program: the paths and names it asked about. */
const LITERAL = /'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`\\$\n]*)`/g;

/** Whether code_intel calls are recorded as evidence: only require-analysis reads it. */
let collecting = false;

/** Per agent, the string literals of its code_intel programs that ran an impact method. */
const evidence = new Map<string, Set<string>>();

/** Forgets every cached risk and commit, and every agent's evidence. */
export function resetRiskCache(): void {
	generation += 1;
	cache.clear();
	commits.clear();
	evidence.clear();
}

/** Turns evidence recording on (require-analysis) or off, dropping what was recorded. */
export function collectEvidence(on: boolean): void {
	collecting = on;
	evidence.clear();
}

/**
 * Records a code_intel tool call `e` (its arguments sit on the event itself) as
 * evidence for the agent `key`: the string literals of a program that ran
 * `impactAnalysis`, `traceSymbolUsage` or `getDependents`. A denied call adds nothing.
 */
export function noteCodeIntel(key: string, e: object, r: object): void {
	if (!collecting || Reflect.get(r, 'deny') !== undefined) return;
	const code = stringArg(e, 'code');
	if (code === undefined || !ANALYSIS.test(code)) return;
	const seen = evidence.get(key) ?? new Set<string>();
	for (const m of code.matchAll(LITERAL)) {
		const literal = (m[1] ?? m[2] ?? m[3] ?? '').trim().replace(/^\.\//, '');
		if (literal !== '') seen.add(literal);
	}
	evidence.set(key, seen);
}

/**
 * True when the agent `key` ran an impact method naming one of `paths` exactly,
 * or one of `symbols` as a whole identifier (`'AuthService.login'` names both).
 */
export function hasEvidence(key: string, paths: string[], symbols: string[]): boolean {
	for (const literal of evidence.get(key) ?? []) {
		if (paths.includes(literal)) return true;
		const words = literal.split(/[^\w$]+/);
		if (symbols.some((s) => s !== '' && words.includes(s))) return true;
	}
	return false;
}

/** Drops what the agent `key` has looked at. */
export function forgetAgentEvidence(key: string): void {
	evidence.delete(key);
}

async function load(mcp: McpPort, root: string, rel: string): Promise<{ risk: FileRisk; commit?: string } | undefined> {
	const envelope = await codeIntel(mcp, probeCode(rel), { cwd: root });
	const result: unknown = envelope.result;
	const body = typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : undefined;
	const dependents = strings(body?.dependents);
	const used = strings(body?.used);
	if (!envelope.success || dependents === undefined || used === undefined) return undefined;
	const risk: FileRisk = {
		path: rel,
		dependents: dependents.length,
		topDependents: dependents.slice(0, 3),
		usedSymbols: used,
		level: levelOf(dependents.length),
	};
	const commit = envelope.asOfCommit;
	if (commit === undefined) return { risk };
	risk.asOfCommit = commit.slice(0, 7);
	return { risk, commit };
}

/**
 * How far a change to `path` (inside `root`) reaches in the code graph, or
 * undefined when the path is outside the root or the lookup failed. A risk is
 * kept for `FRESH_MS` and a failure for `RETRY_MS`; a new indexed commit drops
 * the root's other entries at once.
 */
export function fileRisk(port: RiskPort, root: string, path: string): Promise<FileRisk | undefined> {
	const rel = relativeTo(root, absolute(path, root));
	if (rel === null) return Promise.resolve(undefined);
	const key = `${root}\0${rel}`;
	const known = cache.get(key);
	if (known !== undefined) return known;
	const born = generation;
	const pending: Promise<FileRisk | undefined> = load(port, root, rel).then((found) => {
		// A reset while this was in flight: the cache now belongs to newer lookups.
		if (generation !== born) return found?.risk;
		if (found?.commit !== undefined && commits.get(root) !== found.commit) {
			if (commits.has(root)) {
				for (const other of [...cache.keys()]) {
					if (other !== key && other.startsWith(`${root}\0`)) cache.delete(other);
				}
			}
			commits.set(root, found.commit);
		}
		port.after(found === undefined ? RETRY_MS : FRESH_MS, () => {
			if (cache.get(key) === pending) cache.delete(key);
		});
		return found?.risk;
	});
	cache.set(key, pending);
	return pending;
}
