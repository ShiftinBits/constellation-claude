import type { EngineInterface, RenderSurface } from 'claude-code';

/**
 * The MCP calls `codeIntel` makes. `claude plugin validate` follows `$` only
 * into functions declared in the same file, so a handler passes closures that
 * spell `$.mcp.connect(...)` and `$.mcp.call(...)` itself:
 * `{ connect: (s) => $.mcp.connect(s), call: (s, t, a) => $.mcp.call(s, t, a) }`.
 */
export type McpPort = Pick<EngineInterface['mcp'], 'connect' | 'call'>;

export type CodeIntelError = {
	code: string;
	message?: string;
	guidance?: readonly string[];
	/** Project roots code_intel found under the git root, sent with `CWD_NOT_INDEXED`. */
	candidates?: readonly string[];
	/** A documentation link the server sends with the error. */
	docs?: string;
};

export type CodeIntelEnvelope = {
	success: boolean;
	result?: unknown;
	error?: CodeIntelError;
	asOfCommit?: string;
	lastIndexedAt?: string;
	time?: number;
	/** Why a result came back empty (`resultContext.reason`), such as `branch_not_indexed`. */
	reason?: string;
};

const SERVER_KEY = 'constellation';
const PROJECT_FILE = 'constellation.json';

/**
 * True when the access key starts with `ak:`, the same gate the settings hooks
 * used. The handler reads it, so validate sees the literal name:
 * `isConfigured(await $.env.get('CONSTELLATION_ACCESS_KEY'))`.
 */
export function isConfigured(accessKey: string | undefined): boolean {
	return (accessKey ?? '').startsWith('ak:');
}

/**
 * True when the session can draw a pane: a `terminal` or `desktop` surface is
 * present. `CommandRunInput` has no surface field, so the handler passes
 * `await $.session.surfaces()`, which validate sees as a literal call. Later
 * pane stories reuse this check.
 */
export function canDraw(surfaces: readonly RenderSurface[]): boolean {
	return surfaces.includes('terminal') || surfaces.includes('desktop');
}

/** The string field `name` of a tool call or event, or undefined. */
export function stringArg(e: object, name: string): string | undefined {
	const value: unknown = Reflect.get(e, name);
	return typeof value === 'string' ? value : undefined;
}

/** Resolves `path` against `cwd` into an absolute, forward-slash path with no `.` or `..` segments. */
export function absolute(path: string, cwd: string): string {
	const full = path.replace(/\\/g, '/');
	const joined = /^([A-Za-z]:)?\//.test(full) ? full : `${cwd.replace(/\\/g, '/')}/${full}`;
	const root = /^([A-Za-z]:)?\//.exec(joined)?.[0] ?? '/';
	const segments: string[] = [];
	for (const segment of joined.slice(root.length).split('/')) {
		if (segment === '..') segments.pop();
		else if (segment !== '' && segment !== '.') segments.push(segment);
	}
	return root + segments.join('/');
}

/** `path` (absolute, normalized) relative to `root` in POSIX form, or null when it is outside the root. */
export function relativeTo(root: string, path: string): string | null {
	const base = absolute(root, root).replace(/\/+$/, '');
	return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : null;
}

/** `value` when it is an array of strings, else undefined. */
export function strings(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : undefined;
}

/**
 * A markdown table, for a surface without a monospace grid (the Desktop app),
 * where padded columns do not line up. A `|` in a cell is escaped and a line
 * break becomes a space, so data from the graph cannot break the table.
 */
export function markdownTable(head: readonly string[], rows: readonly (readonly string[])[]): string {
	const line = (cells: readonly string[]) => `| ${cells.map((c) => c.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')).join(' | ')} |`;
	return [line(head), line(head.map(() => ':-')), ...rows.map(line)].join('\n');
}

/** `count` and `word`, with an `s` unless the count is one. */
export function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * The nearest directory at or above `path` (default: `cwd`) that holds an
 * entry called `name`, or null. Walks up with `exists` (`(p) => $.fs.exists(p)`)
 * because `$.fs.ancestors` only accepts `.md` file names.
 */
async function findUp(
	cwd: string,
	exists: (path: string) => Promise<boolean>,
	name: string,
	path?: string,
): Promise<string | null> {
	let dir = absolute(path ?? cwd, cwd);
	for (;;) {
		const prefix = dir.endsWith('/') ? dir : `${dir}/`;
		if (await exists(prefix + name)) return dir;
		const parent = absolute('..', dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * The nearest directory at or above `path` (default: `cwd`) that holds a
 * `constellation.json`, or null. `path` may be a file or a directory; a
 * relative one is resolved against `cwd`.
 */
export function projectRoot(cwd: string, exists: (path: string) => Promise<boolean>, path?: string): Promise<string | null> {
	return findUp(cwd, exists, PROJECT_FILE, path);
}

/**
 * The nearest directory at or above `cwd` that holds `.git`, or null outside a
 * git repository. `$.fs.exists` answers for any entry, so a `.git` directory
 * and a worktree's `.git` file both count. No git process runs.
 */
export function gitRoot(cwd: string, exists: (path: string) => Promise<boolean>): Promise<string | null> {
	return findUp(cwd, exists, '.git');
}

function failure(code: string, message: string): CodeIntelEnvelope {
	return { success: false, error: { code, message } };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `value` when it is a finite number, else undefined. */
export function num(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The last segment of a string path, split on either slash, as a project's name. */
export function projectName(path: unknown): string | undefined {
	return typeof path === 'string' ? path.split(/[\\/]/).filter(Boolean).pop() : undefined;
}

function parseError(value: unknown): CodeIntelError | undefined {
	if (!isRecord(value) || typeof value.code !== 'string') return undefined;
	const error: CodeIntelError = { code: value.code };
	if (typeof value.message === 'string') error.message = value.message;
	if (Array.isArray(value.guidance)) {
		error.guidance = value.guidance.filter((g): g is string => typeof g === 'string');
	}
	if (typeof value.docs === 'string' && value.docs !== '') error.docs = value.docs;
	const candidates = isRecord(value.context) ? value.context.candidates : undefined;
	if (Array.isArray(candidates)) {
		error.candidates = candidates.filter((c): c is string => typeof c === 'string');
	}
	return error;
}

/** Reads a code_intel response body into the typed envelope, or a stable parse failure. */
export function parseEnvelope(text: string | undefined): CodeIntelEnvelope {
	if (text === undefined) return failure('INVALID_RESPONSE', 'code_intel returned no text content');
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return failure('INVALID_RESPONSE', 'code_intel returned text that is not JSON');
	}
	if (!isRecord(body) || typeof body.success !== 'boolean') {
		return failure('INVALID_RESPONSE', 'code_intel returned JSON without a success flag');
	}
	const envelope: CodeIntelEnvelope = { success: body.success };
	if ('result' in body) envelope.result = body.result;
	const error = parseError(body.error);
	if (error) envelope.error = error;
	if (typeof body.asOfCommit === 'string') envelope.asOfCommit = body.asOfCommit;
	if (typeof body.lastIndexedAt === 'string') envelope.lastIndexedAt = body.lastIndexedAt;
	if (typeof body.time === 'number') envelope.time = body.time;
	const reason = isRecord(body.resultContext) ? body.resultContext.reason : undefined;
	if (typeof reason === 'string' && reason !== '') envelope.reason = reason;
	return envelope;
}

/**
 * Reads the text a code_intel call gave the model into the envelope. An
 * errored call's text is `Error: ` and then the envelope, so the prefix goes first.
 */
export function parseToolText(text: string | undefined, isError: boolean): CodeIntelEnvelope {
	return parseEnvelope(isError ? text?.replace(/^Error:\s*/, '') : text);
}

/**
 * Runs `code` through the plugin's `code_intel` MCP tool in the project at `cwd`.
 * Connects on every call: `$.mcp.connect` answers at once for a connected
 * server and gives the name it runs under now, so a restarted or renamed server
 * is picked up without a cache to go stale. Never throws: every failure is an
 * envelope with `success: false`.
 */
export async function codeIntel(mcp: McpPort, code: string, { cwd }: { cwd: string }): Promise<CodeIntelEnvelope> {
	try {
		const connection = await mcp.connect(SERVER_KEY);
		if (!connection.isConnected) {
			return failure('MCP_UNAVAILABLE', `${connection.reason}: ${connection.message}`);
		}
		const response = await mcp.call(connection.server, 'code_intel', { code, cwd });
		const text = response.content.find((block) => block.type === 'text')?.text;
		const envelope = parseEnvelope(text);
		if (!response.isError) return envelope;
		// An error result may still carry code_intel's own envelope (an error code
		// and guidance); anything else, such as a host message, is MCP_TOOL_ERROR.
		if (envelope.error !== undefined && envelope.error.code !== 'INVALID_RESPONSE') return { ...envelope, success: false };
		return failure('MCP_TOOL_ERROR', text ?? 'code_intel returned an error');
	} catch (error) {
		return failure('MCP_CALL_FAILED', error instanceof Error ? error.message : String(error));
	}
}

/**
 * `pending` if it settles within `ms` (and before `signal` aborts), else
 * undefined. `sleep` is `(ms, o) => $.clock.sleep(ms, o)`: the hook's own time
 * limit pauses during `$` calls, so a slow lookup needs a deadline of its own.
 */
export async function withinDeadline<T>(
	sleep: (ms: number, options: { signal: AbortSignal }) => Promise<unknown>,
	pending: Promise<T>,
	ms: number,
	signal: AbortSignal,
): Promise<T | undefined> {
	const stop = new AbortController();
	const deadline = sleep(ms, { signal: AbortSignal.any([signal, stop.signal]) }).then(
		() => undefined,
		() => undefined,
	);
	try {
		return await Promise.race([pending, deadline]);
	} finally {
		stop.abort();
	}
}
