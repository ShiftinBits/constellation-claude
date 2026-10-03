import type { ButtonProps, ElementTable, RenderElement, TextProps } from 'claude-code';

/**
 * The Constellation brand palette as hex strings, the only color literals in
 * the plugin. The five accents (nebula, galactic, solar, cosmic, stellar) and
 * the two grays (mutedSilver, terminalGray) may style terminal text. The last
 * six (mutedSilver, terminalGray, mutedWhite, deepSpace, charcoal, dimOutline)
 * are for Desktop Svg only and never appear in a terminal tree: the terminal
 * has no backgrounds, primary text omits `color` and secondary text uses
 * `dimColor`.
 *
 * Svg font stacks: 'Space Grotesk, Inter, sans-serif' for text and
 * 'JetBrains Mono, monospace' for code.
 */
export const palette = {
	nebula: '#4A90E2',
	galactic: '#8E44AD',
	solar: '#F39C12',
	cosmic: '#27AE60',
	stellar: '#E74C3C',
	mutedSilver: '#8E8E93',
	terminalGray: '#B8B8B8',
	mutedWhite: '#EEEEEE',
	deepSpace: '#0B0C10',
	charcoal: '#1F1F28',
	dimOutline: '#2B2C34',
} as const;

/** The five accents as 24-bit integers, for Raster cells. */
export const rgb = {
	nebula: 0x4a90e2,
	galactic: 0x8e44ad,
	solar: 0xf39c12,
	cosmic: 0x27ae60,
	stellar: 0xe74c3c,
} as const;

/** The one brand mark a tree may draw. */
export const MARK = '✦';

/**
 * The Text props of a tone plus the word and glyph every colored badge must
 * carry, so color is never the only signal.
 */
export type Tone = {
	color?: string;
	dimColor?: boolean;
	bold?: boolean;
	word: string;
	glyph: string;
};

const DIM = { dimColor: true } as const;

const OK = { color: palette.cosmic, glyph: '✓' } as const;
const PENDING = { color: palette.solar, glyph: '◐' } as const;
const ERROR = { color: palette.stellar, glyph: '✗' } as const;
const INFO = { color: palette.nebula, glyph: 'ℹ' } as const;
const UNKNOWN_GLYPH = '·';

const STATUS: Readonly<Record<string, Omit<Tone, 'word'> & { word?: string }>> = {
	healthy: { ...OK, word: 'ok' },
	indexed: { ...OK, word: 'ok' },
	success: { ...OK, word: 'ok' },
	pending: PENDING,
	indexing: PENDING,
	stale: PENDING,
	error: ERROR,
	auth: ERROR,
	critical: ERROR,
	info: INFO,
	unknown: { ...DIM, glyph: UNKNOWN_GLYPH },
	disabled: { ...DIM, glyph: UNKNOWN_GLYPH },
};

const RISK: Readonly<Record<string, Tone>> = {
	low: { ...OK, word: 'LOW' },
	medium: { ...PENDING, word: 'MEDIUM' },
	high: { ...ERROR, word: 'HIGH' },
	critical: { ...ERROR, bold: true, word: 'CRITICAL' },
};

const KIND: Readonly<Record<string, string>> = {
	function: palette.nebula,
	method: palette.nebula,
	class: palette.galactic,
	variable: palette.cosmic,
	import: palette.solar,
	error: palette.stellar,
	interface: palette.galactic,
	type: palette.galactic,
	module: palette.nebula,
	enum: palette.galactic,
	property: palette.cosmic,
	constant: palette.cosmic,
};

function lookup<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
	const name = key.toLowerCase();
	return Object.hasOwn(table, name) ? table[name] : undefined;
}

function dim(word: string): Tone {
	return { ...DIM, word, glyph: UNKNOWN_GLYPH };
}

/**
 * The tone of a status string from API data: healthy, indexed and success are
 * green and read "ok"; pending, indexing and stale are gold; error, auth and
 * critical are red; info is blue; unknown, disabled and any other value are dim.
 */
export function status(kind: string): Tone {
	const name = kind.toLowerCase();
	const tone = lookup(STATUS, name);
	return tone ? { ...tone, word: tone.word ?? name } : dim(name || 'unknown');
}

/**
 * The tone of a risk level from API data: low is green, medium gold, high red
 * and critical bold red; any other value is dim.
 */
export function risk(level: string): Tone {
	return lookup(RISK, level) ?? dim(level.toUpperCase() || 'UNKNOWN');
}

/**
 * The tone of a symbol kind. The brand reference maps function and method to
 * nebula, class to galactic, variable to cosmic, import to solar and error to
 * stellar. Extensions beyond it: interface and type are galactic (as in the
 * web graph theme), module is nebula (web), enum is galactic, and property and
 * constant are cosmic. Any other kind is dim.
 */
export function kind(symbolKind: string): Tone {
	const name = symbolKind.toLowerCase();
	const color = lookup(KIND, name);
	return color ? { color, word: name, glyph: '•' } : { ...DIM, word: name || 'unknown', glyph: '•' };
}

/**
 * How the plugin colors what it draws, the one place that decides it:
 * - `brand`: the Constellation palette.
 * - `brand-light`: the palette with gold and green, which read poorly on white,
 *   swapped for Claude Code's `warning` and `success` theme colors.
 * - `theme`: only Claude Code's theme colors, so ANSI and color-blind themes
 *   draw their own values (a raw hex color is only approximated there).
 * - `none`: no color; every tone's word and glyph carry its meaning.
 */
export type Scheme = 'brand' | 'brand-light' | 'theme' | 'none';

/**
 * The scheme for the `colors` option (`brand`, the default, `theme` or `none`) and Claude Code's `theme` setting (its
 * `/config` row). `brand` follows the theme: an ANSI or color-blind theme gets
 * the theme's own colors, a light one the light swap. `auto` reads as dark.
 */
export function scheme(colors: unknown, theme: unknown): Scheme {
	if (colors === 'none' || colors === 'theme') return colors;
	const name = typeof theme === 'string' ? theme : '';
	if (name.endsWith('-ansi') || name.includes('daltonized')) return 'theme';
	return name.startsWith('light') ? 'brand-light' : 'brand';
}

/**
 * Claude Code theme keys for the five accents, read from its built-in themes:
 * blue `suggestion`, purple `merged`, `warning`, `success` and `error`.
 */
const THEME_KEY: Readonly<Record<string, string>> = {
	[palette.nebula]: 'suggestion',
	[palette.galactic]: 'merged',
	[palette.solar]: 'warning',
	[palette.cosmic]: 'success',
	[palette.stellar]: 'error',
};

/** A palette color as the scheme draws it: itself, a theme key, or no color. */
export function paint(color: string | undefined, to: Scheme): string | undefined {
	if (color === undefined || to === 'brand') return color;
	if (to === 'none') return undefined;
	if (to === 'brand-light' && color !== palette.solar && color !== palette.cosmic) return color;
	return THEME_KEY[color] ?? color;
}

/** A tone in the scheme's colors. Its word, glyph, bold and dim are kept, so meaning never rides on color alone. */
export function forTheme(tone: Tone, to: Scheme): Tone {
	const color = paint(tone.color, to);
	if (color === tone.color) return tone;
	const { color: _color, ...rest } = tone;
	return color === undefined ? rest : { ...rest, color };
}

function textProps(tone: Tone): TextProps {
	const props: TextProps = {};
	if (tone.color !== undefined) props.color = tone.color;
	if (tone.dimColor) props.dimColor = true;
	if (tone.bold) props.bold = true;
	return props;
}

/**
 * A badge: the tone's glyph and word in its color, then `text` in the default
 * color. Never sets a background. `el` is the table from `$.ui.resolve(e)`.
 */
export function badge(el: ElementTable, text: string, tone: Tone): RenderElement {
	const label = el.Text({ ...textProps(tone), children: `${tone.glyph} ${tone.word}` });
	return el.Text({ children: text ? [label, ` ${text}`] : [label] });
}

type ButtonSpec = Pick<ButtonProps, 'key' | 'label' | 'hotkey' | 'plain' | 'role' | 'onPress'>;

/**
 * A right-aligned button row, cancel on the left and the affirmative action on
 * the right. Each button runs its own `onPress`; neither carries a color.
 */
export function buttonRow(el: ElementTable, cancel: ButtonSpec, action: ButtonSpec): RenderElement {
	return el.Box({
		flexDirection: 'row',
		justifyContent: 'flex-end',
		columnGap: 2,
		children: [el.Button(cancel), el.Button(action)],
	});
}
