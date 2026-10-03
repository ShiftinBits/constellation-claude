import { describe, expect, test } from 'claude-code/testing';
import type { Engine } from 'claude-code/testing';
import type { ElementTable, On, RenderElement } from 'claude-code';
import { MARK, badge, buttonRow, forTheme, kind, paint, palette, rgb, risk, scheme, status } from './theme';
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

describe('rgb and MARK', () => {
	test('rgb equals the matching palette hex', () => {
		for (const name of Object.keys(rgb) as (keyof typeof rgb)[]) {
			expect(rgb[name]).toBe(parseInt(palette[name].slice(1), 16));
		}
	});

	test('MARK is the single brand mark', () => {
		expect(MARK).toBe('✦');
	});
});
