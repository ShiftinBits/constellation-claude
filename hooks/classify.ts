const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const DECLARATION = /^(?:class|interface|function|def|func|type)\s+(\S+)$/;
const SEARCH_COMMANDS = new Set(['grep', 'egrep', 'rg', 'ag', 'ack']);

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
 * name worth a graph lookup, so it is not identifier-like either.
 */
export function symbolOf(pattern: string): string | null {
	let text = pattern.trim();
	const declaration = DECLARATION.exec(text);
	if (declaration?.[1] !== undefined) text = declaration[1];
	text = text.replace(/^\\b/, '').replace(/\\b$/, '').replace(/\\\(\\\)$|\\\($/, '');
	if (!IDENTIFIER.test(text) || !/[a-z]/.test(text)) return null;
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
 * value of `-e` or `--regexp` when given, else the first argument that does
 * not start with `-`.
 */
export function bashSearchPattern(command: string): string | null {
	const words = leadingWords(command);
	const first = words[0] ?? '';
	const args = first === 'git' && words[1] === 'grep' ? words.slice(2) : SEARCH_COMMANDS.has(first) ? words.slice(1) : null;
	if (args === null) return null;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? '';
		if (arg === '-e' || arg === '--regexp') return args[i + 1] ?? null;
		if (arg.startsWith('--regexp=')) return arg.slice('--regexp='.length);
	}
	return args.find((arg) => !arg.startsWith('-')) ?? null;
}

/**
 * True when a path segment of `glob` has a stem (the part before the first `*`
 * or `.`) holding a PascalCase or camelCase token, such as `UserService.ts`.
 * Globs that only name a file extension never qualify.
 */
export function globHasSymbolStem(glob: string): boolean {
	return glob.split(/[\\/]/).some((segment) => {
		const stem = segment.split(/[*.]/, 1)[0] ?? '';
		return /[a-z]/.test(stem) && (/^[A-Z][a-z]/.test(stem) || /^.+[A-Z]/.test(stem));
	});
}
