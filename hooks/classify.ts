import { stringArg } from './lib';

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const DECLARATION = /^(?:class|interface|function|def|func|type)\s+(\S+)$/;
const SEARCH_COMMANDS = new Set(['grep', 'egrep', 'rg', 'ag', 'ack']);

/** Language keywords: a search for one is a literal text search, not a symbol lookup. */
const KEYWORDS = new Set([
	'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'def', 'default',
	'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'final', 'finally', 'for', 'from', 'func',
	'function', 'go', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'namespace', 'new',
	'nil', 'none', 'null', 'package', 'pass', 'private', 'protected', 'public', 'require', 'return', 'self',
	'static', 'struct', 'super', 'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'using',
	'var', 'void', 'while', 'with', 'yield',
]);

/**
 * Short flags whose value is the next argument. Letters that take no value in
 * grep (`-r`, `-G`, `-T`) are left out even where rg or ag give them one.
 */
const VALUE_FLAGS = new Set(['-A', '-B', '-C', '-d', '-D', '-f', '-g', '-j', '-m', '-M', '-t']);
const LONG_VALUE_FLAGS = new Set([
	'--after-context', '--before-context', '--context', '--exclude', '--exclude-dir', '--file', '--file-search-regex',
	'--glob', '--iglob', '--ignore-dir', '--include', '--max-columns', '--max-count', '--max-depth', '--replace',
	'--threads', '--type', '--type-not',
]);

/**
 * The bare identifier a search pattern looks for, or null when the pattern is
 * not identifier-like.
 *
 * Identifier-like: a bare identifier (`AuthService`, `get_user`); a declaration
 * keyword and a name (`class X`, `interface X`, `function X`, `def X`,
 * `func X`, `type X`); a name followed by an escaped open paren (`X\(`); a name
 * between regex word boundaries (`\bX\b`).
 *
 * Not identifier-like: text with other whitespace (quoted phrases, error and
 * log text), regex with character classes, alternation or quantifiers, and
 * keys containing `.` or `/`. A word with no lowercase letter (`TODO`,
 * `FIXME`, `ERROR`, and `MAX_RETRIES` too) is a marker or constant, not a
 * name worth a graph lookup, and a language keyword (`import`, `export`) is
 * literal text, so neither is identifier-like.
 */
export function symbolOf(pattern: string): string | null {
	let text = pattern.trim();
	const declaration = DECLARATION.exec(text);
	if (declaration?.[1] !== undefined) text = declaration[1];
	text = text.replace(/^\\b/, '').replace(/\\b$/, '').replace(/\\\(\\\)$|\\\($/, '');
	if (!IDENTIFIER.test(text) || !/[a-z]/.test(text) || KEYWORDS.has(text.toLowerCase())) return null;
	return text;
}

/** True when `pattern` is identifier-like, see {@link symbolOf}. */
export function isSymbolLike(pattern: string): boolean {
	return symbolOf(pattern) !== null;
}

/**
 * The words of the leading command in `command`, quotes removed. The command
 * ends at the first unquoted `|`, `;`, `&&` or `||`, because a grep after a
 * pipe filters output rather than searching code.
 */
function leadingWords(command: string): string[] {
	const words: string[] = [];
	let word = '';
	let inWord = false;
	let quote: string | null = null;
	const endWord = () => {
		if (inWord) words.push(word);
		word = '';
		inWord = false;
	};
	for (let i = 0; i < command.length; i++) {
		const c = command.charAt(i);
		if (quote !== null) {
			if (c === quote) quote = null;
			else word += c;
		} else if (c === "'" || c === '"') {
			quote = c;
			inWord = true;
		} else if (c === '|' || c === ';' || (c === '&' && command.charAt(i + 1) === '&')) {
			break;
		} else if (/\s/.test(c)) {
			endWord();
		} else {
			word += c;
			inWord = true;
		}
	}
	endWord();
	return words;
}

/**
 * The pattern a leading `grep`, `egrep`, `rg`, `ag`, `ack` or `git grep`
 * command searches for, or null for any other command. The pattern is the
 * value of `-e` or `--regexp` when given (`-eFoo` and `--regexp=Foo` too),
 * else the first argument that is neither a flag nor a flag's value.
 */
export function bashSearchPattern(command: string): string | null {
	const words = leadingWords(command);
	const first = words[0] ?? '';
	const args = first === 'git' && words[1] === 'grep' ? words.slice(2) : SEARCH_COMMANDS.has(first) ? words.slice(1) : null;
	if (args === null) return null;
	let pattern: string | null = null;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? '';
		if (arg === '-e' || arg === '--regexp') return args[i + 1] ?? null;
		if (arg.startsWith('--regexp=')) return arg.slice('--regexp='.length);
		if (/^-e./.test(arg)) return arg.slice(2);
		if (arg === '--') {
			pattern ??= args[i + 1] ?? null;
			break;
		}
		if (VALUE_FLAGS.has(arg) || LONG_VALUE_FLAGS.has(arg)) i++;
		else if (!arg.startsWith('-')) pattern ??= arg;
	}
	return pattern;
}

/**
 * True when a segment of `glob` that names what it matches has a stem (the
 * part before the first `*` or `.`) holding a PascalCase or camelCase token,
 * such as `UserService.ts`. Only the last segment and the segments from the
 * first wildcard on count, so a capitalized base directory (`/Users/me/**`)
 * does not; globs that only name a file extension never qualify.
 */
export function globHasSymbolStem(glob: string): boolean {
	const segments = glob.split(/[\\/]/);
	const wild = segments.findIndex((segment) => /[*?[{]/.test(segment));
	const named = wild === -1 ? segments.slice(-1) : segments.slice(wild);
	return named.some((segment) => {
		const stem = segment.split(/[*.]/, 1)[0] ?? '';
		return /[a-z]/.test(stem) && (/^[A-Z][a-z]/.test(stem) || /^.+[A-Z]/.test(stem));
	});
}

/** What a search tool call looks for, and where. */
export type SearchTarget = {
	/** True when it searches for something that looks like a symbol. */
	symbolLike: boolean;
	/** The identifier a Grep or shell search looks for, or null (always null for Glob). */
	symbol: string | null;
	/** The path a Grep or Glob call searches; undefined means the working directory. */
	path: string | undefined;
};

/** The search target of a Grep, Glob or Bash tool call; nothing symbol-like for any other tool. */
export function searchTarget(e: { tool: unknown }): SearchTarget {
	switch (String(e.tool)) {
		case 'Grep': {
			const symbol = symbolOf(stringArg(e, 'pattern') ?? '');
			return { symbolLike: symbol !== null, symbol, path: stringArg(e, 'path') };
		}
		case 'Glob':
			return { symbolLike: globHasSymbolStem(stringArg(e, 'pattern') ?? ''), symbol: null, path: stringArg(e, 'path') };
		case 'Bash': {
			const symbol = symbolOf(bashSearchPattern(stringArg(e, 'command') ?? '') ?? '');
			return { symbolLike: symbol !== null, symbol, path: undefined };
		}
		default:
			return { symbolLike: false, symbol: null, path: undefined };
	}
}
