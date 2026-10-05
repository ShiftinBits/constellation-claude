import type { ElementTable, On, PluginOptions, RenderElement, RenderNode } from 'claude-code';
import { isTestFile } from './blast';
import { explain } from './explain';
import { type CodeIntelEnvelope, isRecord, num, parseEnvelope, plural, projectName } from './lib';
import { badge, forTheme, kind, palette, risk, type Scheme, scheme, status, type Tone } from './theme';

/** The mark that opens a code_intel call row. */
const mark: Tone = { color: palette.nebula, word: 'code_intel', glyph: '✦' };

const SEP = ' · ';

/** Most rows remembered; the oldest is dropped past it. */
const MAX_ROWS = 200;

/** Symbol names a search row lists. */
const MAX_NAMES = 3;

/**
 * The project each call row named, by requestId (the tool_use_id), for its
 * result row: a result row has no input to read the `cwd` from.
 */
const projects = new Map<string, string>();

/** Claude Code's theme and verbose settings, read once and again after either changes. */
let settings: { theme: unknown; verbose: boolean } | undefined;

/** Forgets every row and the settings read, for a new conversation. */
export function resetToolRows(): void {
	projects.clear();
	settings = undefined;
}

function remember(id: string, project: string): void {
	projects.set(id, project);
	if (projects.size > MAX_ROWS) {
		const oldest = projects.keys().next().value;
		if (oldest !== undefined) projects.delete(oldest);
	}
}

/** The `api.*` methods `code` calls, each once, in order of first appearance. */
export function methodsOf(code: string): string[] {
	const names = [...code.matchAll(/\bapi\s*\??\.\s*(\w+)\s*\(/g)].map((m) => m[1]).filter((n): n is string => n !== undefined);
	return [...new Set(names)];
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

/** The children of a call row: the mark, the methods called, the project, and `running` until it ends. */
function callRow(el: ElementTable, methods: string[], project: string | undefined, running: boolean, to: Scheme): RenderNode[] {
	const parts: RenderNode[] = [badge(el, '', forTheme(mark, to))];
	if (methods.length > 0) parts.push(methods.join(', '));
	if (project) parts.push(dim(el, project));
	if (running) parts.push(dim(el, 'running'));
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
			// ponytail: a zero test count is left out, since Core's impact analysis reports 0 even when tests depend on the symbol.
			const tests = num(summary?.testFileCount);
			if (tests !== undefined && tests > 0) parts.push(counted(el, tests, 'test file'));
			return parts;
		}
		if (Array.isArray(result.directDependents) && typeof result.file === 'string') {
			// The result is one page; the total is the server's. Test files are counted only when the page holds them all.
			const dependents = result.directDependents;
			const total = (isRecord(result.pagination) ? num(result.pagination.total) : undefined) ?? dependents.length;
			const parts: RenderNode[] = [counted(el, total, 'dependent file')];
			const tests = dependents.filter((d) => isRecord(d) && typeof d.filePath === 'string' && isTestFile(d.filePath)).length;
			if (tests > 0 && total === dependents.length) parts.push(counted(el, tests, 'test file'));
			return parts;
		}
		if (Array.isArray(result.directDependencies)) {
			const dependencies = result.directDependencies;
			const files = dependencies.filter((d) => isRecord(d) && d.type === 'file').length;
			const packages = dependencies.filter((d) => isRecord(d) && d.type === 'module').length;
			const parts: RenderNode[] = [counted(el, files, 'dependency file')];
			if (packages > 0) parts.push(counted(el, packages, 'package'));
			return parts;
		}
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
 * The children of a result row for `envelope`: an error's code as a badge, its
 * headline and the first step to take, or what the result holds and why it is
 * empty; then how long the call took and the commit the graph was indexed at.
 */
export function summarize(el: ElementTable, envelope: CodeIntelEnvelope, to: Scheme, project?: string): RenderNode[] {
	const { error } = envelope;
	const parts: RenderNode[] = [];
	if (!envelope.success && error !== undefined) {
		const ex = explain(error);
		parts.push(badge(el, '', forTheme({ ...status('error'), word: error.code }, to)), ex.title);
		if (ex.steps[0] !== undefined) parts.push(ex.steps[0]);
	} else {
		parts.push(...shape(el, envelope.result, to, project));
		if (envelope.reason !== undefined) parts.push(dim(el, envelope.reason.replace(/_/g, ' ')));
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
 * under it. Every other tool and surface, an interrupted call, and a result
 * with no envelope to read (one over the MCP output limit, say) or a failure
 * without an error code keeps Claude Code's own row.
 */
export function registerToolRows(on: On, options: PluginOptions): void {
	on('config.set', { key: ['theme', 'verbose'] }, async ($, e, next) => {
		const set = await next(e);
		settings = undefined;
		$.ui.invalidate('ui.render');
		return set;
	});

	on('ui.render', { component: ['ToolUse', 'ToolResult'] }, async ($, e, next) => {
		if (!/__code_intel$/.test(e.props.tool)) return next(e);
		if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e);
		if (e.component === 'ToolUse' && e.props.isInterrupted) return next(e);
		const el = $.ui.resolve(e);
		let row: RenderElement | undefined;
		let verbose = false;
		try {
			if (settings === undefined) {
				try {
					const config = await $.config.list();
					settings = {
						theme: config.find((r) => r.key === 'theme')?.value,
						verbose: config.find((r) => r.key === 'verbose')?.value === true,
					};
				} catch {
					// The default colors and Claude Code's row hidden, until a read succeeds.
				}
			}
			verbose = settings?.verbose ?? false;
			const to = scheme(options.colors, settings?.theme);
			if (e.component === 'ToolUse') {
				const input = e.props.input;
				if (isRecord(input) && typeof input.code === 'string') {
					const project = projectName(input.cwd);
					if (project !== undefined) remember(e.requestId, project);
					row = el.Text({ children: callRow(el, methodsOf(input.code), project, e.props.isRunning, to) });
				}
			} else {
				const text = outputText(e.props.output);
				// An errored call's output is the text the model read: `Error: ` and then the envelope.
				const envelope = parseEnvelope(e.props.isErrored ? text?.replace(/^Error:\s*/, '') : text);
				const drawable = envelope.error === undefined ? envelope.success && !e.props.isErrored : envelope.error.code !== 'INVALID_RESPONSE';
				if (drawable) row = el.Text({ children: summarize(el, envelope, to, projects.get(e.requestId)) });
			}
		} catch {
			row = undefined;
		}
		if (row === undefined) return next(e);
		if (!verbose) return row;
		return el.Box({ flexDirection: 'column', children: [row, await next(e)] });
	});
}
