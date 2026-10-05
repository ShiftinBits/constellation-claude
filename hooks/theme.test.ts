import { describe, expect, test } from 'claude-code/testing';
import type { Engine } from 'claude-code/testing';
import type { ElementTable, On, RenderElement } from 'claude-code';
import { BANNER_WIDTH, BOX_WIDTH, badge, banner, buttonRow, compactBanner, forTheme, gradientAt, header, kind, onboarding, paint, palette, rgb, risk, scheme, status } from './theme';
import type { Tone } from './theme';

const SURFACES = ['terminal', 'desktop'] as const;

/** Draws one prompt hint line as whatever the build returns for the resolved element table. */
async function draw(
	$: Engine,
	on: On,
	surface: (typeof SURFACES)[number],
	build: (el: ElementTable) => RenderElement,
) {
	on('ui.render', ($, e) => build($.ui.resolve(e)));
	return $.ui.mount({
		plugin: 'test',
		surface,
		component: 'PromptHint',
		props: { isDraft: false, isWorking: false, hint: '' },
	});
}

describe('badge', () => {
	for (const surface of SURFACES) {
		test(`renders glyph, word, text and the tone color on ${surface}`, async ($, on) => {
			const ui = await draw($, on, surface, (el) => badge(el, 'index ready', status('info')));
			const tone = (await ui.findAll({ type: 'Text' })).find((t) => t.children.includes('ℹ info'));
			expect(tone?.props['color']).toBe(palette.nebula);
			expect(await ui.find({ type: 'Text', text: /index ready/ })).toBeDefined();
		});

		test(`colors an error stellar on ${surface}`, async ($, on) => {
			const ui = await draw($, on, surface, (el) => badge(el, 'bad key', status('error')));
			const tone = (await ui.findAll({ type: 'Text' })).find((t) => t.children.includes('✗ error'));
			expect(tone?.props['color']).toBe(palette.stellar);
			expect(await ui.find({ type: 'Text', text: /bad key/ })).toBeDefined();
		});
	}

	test('never sets a background', async ($, on) => {
		const ui = await draw($, on, 'terminal', (el) => badge(el, 'x', risk('critical')));
		const texts = await ui.findAll({ type: 'Text' });
		for (const t of texts) {
			expect(t.props['backgroundColor']).toBeUndefined();
		}
	});
});

describe('status and risk', () => {
	test('status words and colors', () => {
		expect(status('healthy')).toMatchObject({ color: palette.cosmic, word: 'ok' });
		expect(status('indexed').word).toBe('ok');
		expect(status('success').word).toBe('ok');
		expect(status('stale')).toMatchObject({ color: palette.solar, word: 'stale' });
		expect(status('pending').color).toBe(palette.solar);
		expect(status('indexing').word).toBe('indexing');
		for (const k of ['error', 'auth', 'critical']) {
			expect(status(k)).toMatchObject({ color: palette.stellar, word: k });
		}
		expect(status('info').color).toBe(palette.nebula);
	});

	test('unknown input falls back to the dim tone', () => {
		for (const tone of [status('unknown'), status('disabled'), status('???'), status('constructor')]) {
			expect(tone.dimColor).toBe(true);
			expect(tone.color).toBeUndefined();
		}
		expect(risk('nope').dimColor).toBe(true);
		expect(kind('nope').dimColor).toBe(true);
	});

	test('risk levels', () => {
		expect(risk('low')).toMatchObject({ color: palette.cosmic, word: 'LOW' });
		expect(risk('medium')).toMatchObject({ color: palette.solar, word: 'MEDIUM' });
		expect(risk('high')).toMatchObject({ color: palette.stellar, word: 'HIGH' });
		expect(risk('critical')).toMatchObject({ color: palette.stellar, bold: true, word: 'CRITICAL' });
	});

	test('every colored tone carries a word and a glyph', () => {
		for (const tone of [status('healthy'), status('stale'), status('error'), status('info'), risk('low'), risk('critical')]) {
			expect(tone.word.length).toBeGreaterThan(0);
			expect(tone.glyph.length).toBeGreaterThan(0);
		}
	});
});

describe('kind', () => {
	test('maps every kind', () => {
		const expected: Record<string, string> = {
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
		for (const [name, color] of Object.entries(expected)) {
			expect(kind(name).color).toBe(color);
		}
		expect(kind('Function').color).toBe(palette.nebula);
	});

	test('an unknown kind is dim', () => {
		expect(kind('widget')).toMatchObject({ dimColor: true, word: 'widget' });
	});
});

describe('scheme', () => {
	test('brand follows a dark theme, swaps on a light one, and hands ANSI and color-blind themes their own colors', () => {
		expect(scheme('brand', 'dark')).toBe('brand');
		expect(scheme('brand', 'auto')).toBe('brand');
		expect(scheme(undefined, undefined)).toBe('brand');
		expect(scheme('brand', 'light')).toBe('brand-light');
		expect(scheme('brand', 'dark-ansi')).toBe('theme');
		expect(scheme('brand', 'light-ansi')).toBe('theme');
		expect(scheme('brand', 'dark-daltonized')).toBe('theme');
		expect(scheme('brand', 'light-daltonized')).toBe('theme');
	});

	test('the theme and none options win over the theme', () => {
		expect(scheme('theme', 'dark')).toBe('theme');
		expect(scheme('none', 'light')).toBe('none');
	});
});

describe('forTheme', () => {
	test('brand returns the tone as given', () => {
		const tone: Tone = status('stale');
		expect(forTheme(tone, 'brand')).toBe(tone);
	});

	test('brand-light swaps gold and green for the warning and success theme colors', () => {
		expect(forTheme(status('stale'), 'brand-light')).toMatchObject({ color: 'warning', word: 'stale', glyph: '◐' });
		expect(forTheme(status('healthy'), 'brand-light')).toMatchObject({ color: 'success', word: 'ok', glyph: '✓' });
	});

	test('brand-light leaves the other accents in the palette', () => {
		for (const tone of [status('error'), status('info'), status('unknown'), risk('critical')]) {
			expect(forTheme(tone, 'brand-light')).toBe(tone);
		}
	});

	test('theme maps every accent to a Claude Code theme color', () => {
		expect(forTheme(status('info'), 'theme').color).toBe('suggestion');
		expect(forTheme(kind('class'), 'theme').color).toBe('merged');
		expect(forTheme(status('stale'), 'theme').color).toBe('warning');
		expect(forTheme(status('healthy'), 'theme').color).toBe('success');
		expect(forTheme(risk('critical'), 'theme')).toMatchObject({ color: 'error', bold: true, word: 'CRITICAL' });
	});

	test('none drops the color and keeps the word, glyph and weight', () => {
		const themed = forTheme(risk('critical'), 'none');
		expect(themed.color).toBeUndefined();
		expect(themed).toMatchObject({ bold: true, word: 'CRITICAL', glyph: '✗' });
	});

	test('paint maps a bare palette color the same way', () => {
		expect(paint(palette.nebula, 'brand')).toBe(palette.nebula);
		expect(paint(palette.nebula, 'theme')).toBe('suggestion');
		expect(paint(palette.nebula, 'none')).toBeUndefined();
	});
});

describe('buttonRow', () => {
	for (const surface of SURFACES) {
		test(`each button runs its own onPress on ${surface}`, async ($, on) => {
			const pressed: string[] = [];
			const ui = await draw($, on, surface, (el) =>
				buttonRow(
					el,
					{ key: 'cancel', label: 'Cancel', onPress: () => pressed.push('cancel') },
					{ key: 'save', label: 'Save', onPress: () => pressed.push('save') },
				),
			);
			await ui.press({ key: 'save' });
			await ui.press({ key: 'cancel' });
			expect(pressed).toEqual(['save', 'cancel']);
		});

		test(`right-aligns cancel then action on ${surface}`, async ($, on) => {
			const ui = await draw($, on, surface, (el) =>
				buttonRow(
					el,
					{ key: 'cancel', label: 'Cancel', hotkey: 'c', onPress: () => {} },
					{ key: 'save', label: 'Save', hotkey: 's', onPress: () => {} },
				),
			);
			const row = await ui.find({ type: 'Box' });
			expect(row?.props).toMatchObject({ flexDirection: 'row', justifyContent: 'flex-end', columnGap: 2 });
			const buttons = await ui.findAll({ type: 'Button' });
			expect(buttons.map((b) => b.key)).toEqual(['cancel', 'save']);
			for (const b of buttons) {
				expect(b.props['color']).toBeUndefined();
			}
		});
	}
});

describe('rgb', () => {
	test('rgb equals the matching palette hex', () => {
		for (const name of Object.keys(rgb) as (keyof typeof rgb)[]) {
			expect(rgb[name]).toBe(parseInt(palette[name].slice(1), 16));
		}
	});
});

describe('banner', () => {
	test('the gradient runs galactic to sky blue and back, like the CLI', () => {
		expect(gradientAt(0, 'brand')).toBe(palette.galactic);
		// The CLI's lightest stop, RGB 130, 200, 250.
		expect(gradientAt(0.5, 'brand')).toBe(`#${[130, 200, 250].map((v) => v.toString(16).toUpperCase()).join('')}`);
		expect(gradientAt(1, 'brand')).toBe(palette.galactic);
	});

	test('a light theme keeps to the darker stops, and theme and none follow the scheme', () => {
		expect(gradientAt(0.5, 'brand-light')).toBe(palette.nebula);
		expect(gradientAt(0.5, 'theme')).toBe('suggestion');
		expect(gradientAt(0.5, 'none')).toBeUndefined();
	});

	test('the full banner is six lines of its width, with no tag box', async ($, on) => {
		const ui = await draw($, on, 'terminal', (el) => banner(el, 'brand'));
		const lines = (await ui.findAll({ type: 'Text' })).filter((t) => t.props['wrap'] === 'truncate');
		expect(lines).toHaveLength(6);
		for (const line of lines) expect([...line.text].length).toBe(BANNER_WIDTH);
		expect(lines[4]?.text).toMatch(/CONSTELLATIONDEV\.IO/);
		expect(lines[5]?.text.startsWith('╰')).toBe(true);
	});

	test('the compact header is >_CONSTELLATION:// in bold along the gradient', async ($, on) => {
		const ui = await draw($, on, 'desktop', (el) => compactBanner(el, 'brand'));
		const line = await ui.find({ type: 'Text', text: '>_CONSTELLATION://' });
		expect(line?.props['bold']).toBe(true);
		const runs = (await ui.findAll({ type: 'Text' })).filter((t) => t.children.length === 1 && typeof t.children[0] === 'string');
		expect(runs.map((r) => r.children[0]).join('')).toBe('>_CONSTELLATION://');
		expect(runs[0]?.props['color']).toBe(palette.galactic);
		expect(runs.at(-1)?.props['color']).toBe(palette.galactic);
		expect(runs[9]?.props['color']).not.toBe(palette.galactic);
	});

	const BOX = [
		'╭─────────────────────╮',
		'│ >_CONSTELLATION://  │',
		'│ constellationdev.io │',
		'╰─────────────────────╯',
	];
	const cases: [string, number, boolean, number | string[]][] = [
		['the full banner at its width', BANNER_WIDTH, true, 6],
		['the boxed header one column short of the banner', BANNER_WIDTH - 1, true, BOX],
		['the boxed header at its width', BOX_WIDTH, true, BOX],
		['one line one column short of the box', BOX_WIDTH - 1, true, 0],
		['one line without a grid, however wide', 200, false, 0],
	];
	for (const [name, columns, grid, expected] of cases) {
		test(`the header draws ${name}`, async ($, on) => {
			const ui = await draw($, on, grid ? 'terminal' : 'desktop', (el) => header(el, columns, grid, 'brand'));
			const lines = (await ui.findAll({ type: 'Text' })).filter((t) => t.props['wrap'] === 'truncate').map((t) => t.text);
			if (typeof expected === 'number') expect(lines).toHaveLength(expected);
			else expect(lines).toEqual(expected);
		});
	}

	test('the boxed header runs the whole gradient across its own width', async ($, on) => {
		const ui = await draw($, on, 'terminal', (el) => header(el, BOX_WIDTH, true, 'brand'));
		const runs = (await ui.findAll({ type: 'Text' })).filter((t) => t.children.length === 1 && typeof t.children[0] === 'string');
		expect(runs[0]?.props['color']).toBe(palette.galactic);
		// Runs start every three columns, so the sixth starts at column 15 of 23.
		expect(runs[5]?.props['color']).toBe(gradientAt(15 / (BOX_WIDTH - 1), 'brand'));
	});

	test('the boxed header draws the name bold and nothing else on its line', async ($, on) => {
		const ui = await draw($, on, 'terminal', (el) => header(el, BOX_WIDTH, true, 'brand'));
		const line = (await ui.findAll({ type: 'Text' })).find((t) => t.props['wrap'] === 'truncate' && t.text.includes('>_'));
		type Run = { props: Record<string, unknown>; children: unknown[] };
		const isRun = (c: unknown): c is Run => typeof c === 'object' && c !== null && 'props' in c && 'children' in c;
		const runs = ((line?.children ?? []) as unknown[]).filter(isRun);
		const textOf = (rs: Run[]) => rs.map((r) => r.children.join('')).join('');
		expect(textOf(runs.filter((r) => r.props['bold'] === true))).toBe('>_CONSTELLATION://');
		expect(textOf(runs.filter((r) => r.props['bold'] !== true))).toBe('│   │');
		expect(runs.every((r) => typeof r.props['color'] === 'string')).toBe(true);
	});
});

describe('onboarding tones', () => {
	const cases: [keyof typeof onboarding, string][] = [
		['notSetUp', palette.solar],
		['pending', palette.solar],
		['failed', palette.stellar],
		['connected', palette.cosmic],
	];
	for (const [name, color] of cases) {
		test(`${name} carries a word, a glyph and its accent, and no background`, () => {
			const tone: Tone = onboarding[name];
			expect(tone.word).not.toBe('');
			expect(tone.glyph).not.toBe('');
			expect(tone.color).toBe(color);
			expect(tone).not.toHaveProperty('backgroundColor');
		});

		test(`${name} drops its color under the none scheme and keeps its word and glyph`, () => {
			const tone = forTheme(onboarding[name], 'none');
			expect(tone.color).toBeUndefined();
			expect(tone.word).toBe(onboarding[name].word);
			expect(tone.glyph).toBe(onboarding[name].glyph);
		});
	}
});
