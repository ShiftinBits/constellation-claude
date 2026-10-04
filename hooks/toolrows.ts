import type { ElementTable, On, PluginOptions, RenderElement, RenderNode } from 'claude-code';
import { isTestFile } from './blast';
import { explain } from './explain';
import { type CodeIntelEnvelope, parseEnvelope, plural } from './lib';
import { badge, forTheme, kind, palette, risk, type Scheme, scheme, status, type Tone } from './theme';

/** The mark that opens a code_intel call row. */
const mark: Tone = { color: palette.nebula, word: 'code_intel', glyph: '✦' };

const SEP = ' · ';

/** Most rows remembered; the oldest is dropped past it. */
const MAX_ROWS = 200;

/** Symbol names a search row lists. */
const MAX_NAMES = 3;

/**
 * What a call row learned for its result row, by requestId (the tool_use_id):
 * the project from the call's `cwd` (a result row has no input) and the parsed
 * envelope, so a redraw does not parse it again. Plain data only.
 */
const rows = new Map<string, { project?: string; envelope?: CodeIntelEnvelope }>();

/** Forgets every row, for a new conversation. */
export function resetToolRows(): void {
	rows.clear();
}

function remember(id: string, entry: { project?: string; envelope?: CodeIntelEnvelope }): void {
	rows.set(id, { ...rows.get(id), ...entry });
	if (rows.size > MAX_ROWS) {
		const oldest = rows.keys().next().value;
		if (oldest !== undefined) rows.delete(oldest);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The `api.*` methods `code` calls, each once, in order of first appearance. */
export function methodsOf(code: string): string[] {
	const names = [...code.matchAll(/api\.(\w+)\(/g)].map((m) => m[1]).filter((n): n is string => n !== undefined);
	return [...new Set(names)];
}

/** The last segment of a string `cwd`, split on either slash, as a project's name. */
export function projectName(cwd: unknown): string | undefined {
	return typeof cwd === 'string' ? cwd.split(/[\\/]/).filter(Boolean).pop() : undefined;
}

function firstText(blocks: unknown[]): string | undefined {
	for (const block of blocks) {
		if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') return block.text;
	}
	return undefined;
}

/**
 * The text of a tool row's `output`: the string itself, else the first text
 * block of a content-block array or of an object's `content` array. Never
 * `structuredContent`: on an error it holds only a message, not the code or
 * guidance.
 */
export function outputText(output: unknown): string | undefined {
	if (typeof output === 'string') return output;
	if (Array.isArray(output)) return firstText(output);
	if (isRecord(output) && Array.isArray(output.content)) return firstText(output.content);
	return undefined;
}

function tinted(el: ElementTable, tone: Tone, text: string): RenderElement {
	return el.Text({
		...(tone.color === undefined ? {} : { color: tone.color }),
		...(tone.dimColor ? { dimColor: true } : {}),
		...(tone.bold ? { bold: true } : {}),
		children: text,
	});
}

/** `count` in bold and `word`, plural unless the count is one. */
function counted(el: ElementTable, count: number, word: string): RenderElement {
	const digits = String(count);
	return el.Text({ children: [el.Text({ bold: true, children: digits }), plural(count, word).slice(digits.length)] });
}

function dim(el: ElementTable, text: string): RenderElement {
	return el.Text({ dimColor: true, children: text });
}

/** The parts of a row with ` · ` between them. */
function joined(parts: RenderNode[]): RenderNode[] {
	return parts.flatMap((part, i) => (i === 0 ? [part] : [SEP, part]));
}

/** The children of a call row: the mark, the methods called and the project. */
function callRow(el: ElementTable, methods: string[], project: string | undefined, to: Scheme): RenderNode[] {
	const parts: RenderNode[] = [badge(el, '', forTheme(mark, to))];
	if (methods.length > 0) parts.push(methods.join(', '));
	if (project) parts.push(dim(el, project));
	return joined(parts);
}

function depthOf(nodes: unknown[]): number {
	return nodes.reduce<number>((max, n) => Math.max(max, (isRecord(n) ? num(n.depth) : undefined) ?? 0), 0);
}

/** The parts that describe `result`, by the distinctive keys of each method's result, else a generic count. */
function shape(el: ElementTable, result: unknown, to: Scheme, project: string | undefined): RenderNode[] {
	if (isRecord(result)) {
		const summary = isRecord(result.summary) ? result.summary : undefined;
		if (isRecord(result.breakingChangeRisk) || num(summary?.directDependentCount) !== undefined) {
			const parts: RenderNode[] = [];
			const level = isRecord(result.breakingChangeRisk) ? result.breakingChangeRisk.riskLevel : undefined;
			if (typeof level === 'string') parts.push(badge(el, '', forTheme(risk(level), to)));
			const direct = num(summary?.directDependentCount);
			if (direct !== undefined) parts.push(counted(el, direct + (num(summary?.transitiveDependentCount) ?? 0), 'dependent'));
			const tests = num(summary?.testFileCount);
			if (tests !== undefined) parts.push(counted(el, tests, 'test file'));
			return parts;
		}
		if (Array.isArray(result.directDependents) && typeof result.file === 'string') {
			const dependents = result.directDependents;
			const tests = dependents.filter((d) => isRecord(d) && typeof d.filePath === 'string' && isTestFile(d.filePath)).length;
			const parts: RenderNode[] = [counted(el, dependents.length, 'dependent file')];
			if (tests > 0) parts.push(counted(el, tests, 'test file'));
			return parts;
		}
		if (Array.isArray(result.directDependencies)) return [counted(el, result.directDependencies.length, 'dependency file')];
		if (Array.isArray(result.symbols)) {
			const symbols = result.symbols;
			const total = (isRecord(result.pagination) ? num(result.pagination.total) : undefined) ?? symbols.length;
			const parts: RenderNode[] = [counted(el, total, 'symbol')];
			const names = symbols
				.slice(0, MAX_NAMES)
				.filter((s): s is Record<string, unknown> => isRecord(s) && typeof s.name === 'string')
				.map((s) => tinted(el, forTheme(kind(typeof s.kind === 'string' ? s.kind : ''), to), String(s.name)));
			if (names.length > 0) parts.push(el.Text({ children: names.flatMap((n, i) => (i === 0 ? [n] : [', ', n])) }));
			return parts;
		}
		if (Array.isArray(result.orphanedSymbols)) {
			return [counted(el, num(summary?.totalOrphanedSymbols) ?? result.orphanedSymbols.length, 'export')];
		}
		if ('root' in result && (Array.isArray(result.callers) || Array.isArray(result.callees))) {
			const callers = Array.isArray(result.callers) ? result.callers : [];
			const callees = Array.isArray(result.callees) ? result.callees : [];
			const depth = Math.max(depthOf(callers), depthOf(callees));
			return [counted(el, callers.length + callees.length, 'node'), el.Text({ children: ['depth ', el.Text({ bold: true, children: String(depth) })] })];
		}
		if (result.pong === true) {
			const parts: RenderNode[] = [badge(el, '', forTheme({ ...status('success'), word: 'connected' }, to))];
			if (project) parts.push(dim(el, project));
			return parts;
		}
		return [el.Text({ children: ['result: ', counted(el, Object.keys(result).length, 'key')] })];
	}
	if (Array.isArray(result)) return [el.Text({ children: ['result: ', counted(el, result.length, 'item')] })];
	return [`result: ${typeof result}`];
}

/**
 * The children of a result row for `envelope`: an error's code as a badge and
 * the line for a person, or what the result holds; then how long the call took
 * and the commit the graph was indexed at.
 */
export function summarize(el: ElementTable, envelope: CodeIntelEnvelope, to: Scheme, project?: string): RenderNode[] {
	const { error } = envelope;
	const parts: RenderNode[] = [];
	if (!envelope.success && error !== undefined) {
		const ex = explain(error);
		parts.push(badge(el, '', forTheme({ ...status('error'), word: error.code }, to)), ex.steps[0] ?? ex.notes[0] ?? ex.title);
	} else {
		parts.push(...shape(el, envelope.result, to, project));
	}
	const meta: string[] = [];
	if (envelope.time !== undefined) meta.push(`${envelope.time} ms`);
	if (envelope.asOfCommit) meta.push(`as of ${envelope.asOfCommit.slice(0, 7)}`);
	if (meta.length > 0) parts.push(dim(el, meta.join(SEP)));
	return joined(parts);
}

/**
 * The code_intel call and result rows in the transcript: the call row reads
 * `✦ code_intel · <methods> · <project>` and the result row one line about what
 * came back. With the `verbose` setting on, Claude Code's own row follows
 * under it. Every other tool, surface and unreadable error keeps its own row.
 */
export function registerToolRows(on: On, options: PluginOptions): void {
	on('ui.render', { component: ['ToolUse', 'ToolResult'] }, async ($, e, next) => {
		if (!/code_intel$/.test(e.props.tool)) return next(e);
		if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e);
		const el = $.ui.resolve(e);
		let row: RenderElement | undefined;
		let verbose = false;
		try {
			let theme: unknown;
			try {
				const config = await $.config.list();
				theme = config.find((r) => r.key === 'theme')?.value;
				verbose = config.find((r) => r.key === 'verbose')?.value === true;
			} catch {
				// The default colors and Claude Code's row hidden.
			}
			const to = scheme(options.colors, theme);
			if (e.component === 'ToolUse') {
				const input = e.props.input;
				if (isRecord(input) && typeof input.code === 'string') {
					const project = projectName(input.cwd);
					remember(e.requestId, project === undefined ? {} : { project });
					row = el.Text({ children: callRow(el, methodsOf(input.code), project, to) });
				}
			} else {
				const known = rows.get(e.requestId);
				let envelope = known?.envelope;
				if (envelope === undefined) {
					const text = outputText(e.props.output);
					// An errored call's output is the text the model read: `Error: ` and then the envelope.
					envelope = parseEnvelope(e.props.isErrored ? text?.replace(/^Error:\s*/, '') : text);
					remember(e.requestId, { envelope });
				}
				const readable = envelope.error?.code !== 'INVALID_RESPONSE';
				if (e.props.isErrored) {
					if (readable && envelope.error !== undefined) row = el.Text({ children: summarize(el, envelope, to, known?.project) });
				} else {
					row = el.Text({ children: readable ? summarize(el, envelope, to, known?.project) : ['result: unreadable'] });
				}
			}
		} catch {
			row = undefined;
		}
		if (row === undefined) return next(e);
		if (!verbose) return row;
		return el.Box({ flexDirection: 'column', children: [row, await next(e)] });
	});
}
