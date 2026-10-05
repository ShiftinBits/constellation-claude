import { type CodeIntelError, projectName } from './lib';

/**
 * A code_intel error laid out for a person: a plain headline, one line of
 * detail, any notes, the commands to run, a docs link, and the raw code last.
 */
export type Explanation = {
	title: string;
	detail?: string;
	notes: string[];
	steps: string[];
	docs?: string;
	code: string;
	/** Project roots below the working directory, when it sits above several. */
	projects: string[];
};

/** Headlines for the codes people meet; any other code uses the server's message. */
const TITLES: Readonly<Record<string, string>> = {
	AUTH_ERROR: "Your access key wasn't accepted",
	AUTH_EXPIRED: 'Your access key has expired',
	AUTHZ_ERROR: "Your access key can't reach this project",
	NOT_CONFIGURED: "Constellation isn't set up for this project",
	CWD_NOT_INDEXED: "This folder isn't a Constellation project",
	API_UNREACHABLE: "Constellation's API can't be reached",
	PROJECT_NOT_INDEXED: "This project hasn't been indexed yet",
	BRANCH_NOT_FOUND: "This branch hasn't been indexed",
	STALE_INDEX: 'The index is out of date',
	RATE_LIMITED: 'Too many requests; try again shortly',
	SERVICE_UNAVAILABLE: 'Constellation is temporarily unavailable',
	MCP_UNAVAILABLE: "The Constellation MCP server isn't connected",
	MCP_CALL_FAILED: 'The call to the Constellation MCP server failed',
	MCP_TOOL_ERROR: 'The Constellation MCP server reported an error',
	INVALID_RESPONSE: 'The Constellation MCP server sent an unexpected reply',
};

/** Details where the server's message reads poorly to a person (a long path, a count in parentheses). */
const DETAILS: Readonly<Record<string, string>> = {
	CWD_NOT_INDEXED: 'No constellation.json at the root of this repository.',
};

/** Constellation CLI commands written without backticks, as in "Run: constellation auth". */
const CLI = /\bconstellation\s+(?:init|auth|index|status|config)(?:\s+--?[\w=-]+)*/g;
const QUOTED = /`([^`]+)`/g;
const URL = /https?:\/\/[^\s'")]+/;
/** Guidance written for an agent (call code_intel again, pass a cwd), not for a person. */
const AGENT = /code_intel|\bre-?invoke\b|`cwd`|\bcwd parameter\b|\bapi\.\w+\(/i;

/** The first words of a sentence, without filler, to tell when guidance restates the message. */
function gist(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9. ]+/g, ' ')
		.split(/\s+/)
		.filter((w) => w !== '' && !['was', 'were', 'is', 'are', 'the', 'a', 'an'].includes(w))
		.slice(0, 5)
		.join(' ');
}

/** The commands a guidance line names, in order: backticked spans of more than one word, then bare CLI commands. */
function commandsIn(line: string): string[] {
	const found = [...line.matchAll(QUOTED)].map((m) => (m[1] ?? '').trim()).filter((c) => /\s/.test(c));
	const bare = line.replace(QUOTED, ' ');
	for (const m of bare.matchAll(CLI)) found.push(m[0].trim());
	return found.flatMap((c) => c.split(/\s*&&\s*/)).filter((c) => c !== '');
}

/**
 * Lays a code_intel error out for a person. The server's `[CODE] ` prefix and
 * trailing parenthetical are dropped from the message; guidance lines that name
 * commands become numbered steps; a line with a link becomes the docs link;
 * lines written for an agent, or restating the message, are dropped; what is
 * left is kept as notes.
 */
export function explain(error: CodeIntelError): Explanation {
	const message = (error.message ?? '')
		.replace(/^\[[A-Z_]+\]\s*/, '')
		.replace(/\s*\([^)]*\)\s*$/, '')
		.trim();
	const title = TITLES[error.code] ?? (message || 'The request failed');
	const curated = DETAILS[error.code];
	const detail = curated ?? (message !== '' && gist(message) !== gist(title) ? message : undefined);
	const steps: string[] = [];
	const notes: string[] = [];
	let docs = error.docs;
	for (const line of error.guidance ?? []) {
		const commands = commandsIn(line);
		if (commands.length > 0) {
			for (const c of commands) if (!steps.includes(c)) steps.push(c);
			continue;
		}
		const url = URL.exec(line)?.[0];
		if (url !== undefined) {
			docs ??= url.replace(/[.,;]$/, '');
			continue;
		}
		if (AGENT.test(line)) continue;
		// The projects are listed on their own; a line naming them repeats the list.
		if (error.candidates?.some((c) => line.includes(c))) continue;
		if (message !== '' && gist(line) === gist(message)) continue;
		notes.push(line.trim());
	}
	return { title, ...(detail === undefined ? {} : { detail }), notes, steps, ...(docs === undefined ? {} : { docs }), code: error.code, projects: [...(error.candidates ?? [])] };
}

/**
 * The explanation as plain text lines: the headline with the error glyph, the
 * detail and notes indented under it, then the steps (or, above several
 * projects, the projects to run from), then the docs link and the code.
 */
export function explainLines(ex: Explanation): string[] {
	const lines = [`✗ ${ex.title}`];
	if (ex.detail !== undefined) lines.push(`  ${ex.detail}`);
	for (const n of ex.notes) lines.push(`  ${n}`);
	if (ex.projects.length > 0) {
		const width = Math.max(...ex.projects.map((p) => (projectName(p) ?? p).length));
		lines.push('', '  Run /constellation from one of these projects:');
		for (const p of ex.projects) lines.push(`  ${(projectName(p) ?? p).padEnd(width)}  ${p}`);
	} else if (ex.steps.length > 0) {
		lines.push('', '  Next steps');
		ex.steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
	}
	lines.push('');
	if (ex.docs !== undefined) lines.push(`  Docs   ${ex.docs}`);
	lines.push(`  Code   ${ex.code}`);
	return lines;
}
