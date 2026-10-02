import type { EngineInterface } from 'claude-code';

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
};

export type CodeIntelEnvelope = {
	success: boolean;
	result?: unknown;
	error?: CodeIntelError;
	asOfCommit?: string;
	lastIndexedAt?: string;
	time?: number;
};

const SERVER_KEY = 'constellation';
const PROJECT_FILE = 'constellation.json';

/** The name `$.mcp.call` takes for the plugin's server, once connected. */
let connectedServer: string | undefined;

/**
 * True when the access key starts with `ak:`, the same gate the settings hooks
 * used. The handler reads it, so validate sees the literal name:
 * `isConfigured(await $.env.get('CONSTELLATION_ACCESS_KEY'))`.
 */
export function isConfigured(accessKey: string | undefined): boolean {
	return (accessKey ?? '').startsWith('ak:');
}

/** The string field `name` of a tool call or event, or undefined. */
export function stringArg(e: object, name: string): string | undefined {
	const value: unknown = Reflect.get(e, name);
	return typeof value === 'string' ? value : undefined;
}

/** Resolves `path` against `cwd` into an absolute, forward-slash path with no `.` or `..` segments. */
function absolute(path: string, cwd: string): string {
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

/**
 * The nearest directory at or above `path` (default: `cwd`) that holds a
 * `constellation.json`, or null. `path` may be a file or a directory; a
 * relative one is resolved against `cwd`.
 *
 * Walks up with `exists` (`(p) => $.fs.exists(p)`) because `$.fs.ancestors`
 * only accepts `.md` file names.
 */
export async function projectRoot(
	cwd: string,
	exists: (path: string) => Promise<boolean>,
	path?: string,
): Promise<string | null> {
	let dir = absolute(path ?? cwd, cwd);
	for (;;) {
		const prefix = dir.endsWith('/') ? dir : `${dir}/`;
		if (await exists(prefix + PROJECT_FILE)) return dir;
		const parent = absolute('..', dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function failure(code: string, message: string): CodeIntelEnvelope {
	return { success: false, error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseError(value: unknown): CodeIntelError | undefined {
	if (!isRecord(value) || typeof value.code !== 'string') return undefined;
	const error: CodeIntelError = { code: value.code };
	if (typeof value.message === 'string') error.message = value.message;
	if (Array.isArray(value.guidance)) {
		error.guidance = value.guidance.filter((g): g is string => typeof g === 'string');
	}
	return error;
}

/** Reads a code_intel response body into the typed envelope, or a stable parse failure. */
function parseEnvelope(text: string | undefined): CodeIntelEnvelope {
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
	return envelope;
}

/**
 * Runs `code` through the plugin's `code_intel` MCP tool in the project at `cwd`.
 * Connects once and reuses the server name. Never throws: every failure is an
 * envelope with `success: false`.
 */
export async function codeIntel(mcp: McpPort, code: string, { cwd }: { cwd: string }): Promise<CodeIntelEnvelope> {
	try {
		if (connectedServer === undefined) {
			const connection = await mcp.connect(SERVER_KEY);
			if (!connection.isConnected) {
				return failure('MCP_UNAVAILABLE', `${connection.reason}: ${connection.message}`);
			}
			connectedServer = connection.server;
		}
		const response = await mcp.call(connectedServer, 'code_intel', { code, cwd });
		const text = response.content.find((block) => block.type === 'text')?.text;
		return parseEnvelope(text);
	} catch (error) {
		connectedServer = undefined;
		return failure('MCP_CALL_FAILED', error instanceof Error ? error.message : String(error));
	}
}
