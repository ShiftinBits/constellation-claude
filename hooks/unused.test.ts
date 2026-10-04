import { describe, expect, test } from 'claude-code/testing';
import { byFile, location, orphanPage, removalPrompt } from './unused';
import type { OrphanRow } from './unused';

const ROWS: OrphanRow[] = [
	{ symbolId: 'a', name: 'helper', kind: 'function', filePath: 'src/util.ts', lineEnd: 12 },
	{ symbolId: 'b', name: 'Legacy', kind: 'class', filePath: 'src/old.ts' },
	{ symbolId: 'c', name: 'other', kind: 'function', filePath: 'src/util.ts' },
];

describe('orphanPage', () => {
	test('reads rows, total and the next offset', () => {
		const page = orphanPage({
			orphanedSymbols: [{ symbolId: 'a', name: 'helper', kind: 'function', filePath: 'src/util.ts', lineEnd: 12 }],
			summary: { totalOrphanedSymbols: 80 },
			pagination: { hasMore: true, nextOffset: 50 },
		});
		expect(page).toEqual({ rows: [ROWS[0]], total: 80, nextOffset: 50 });
	});

	test('leaves the next offset out when there is no more', () => {
		expect(orphanPage({ orphanedSymbols: [], pagination: { hasMore: false, nextOffset: 50 } })).toEqual({ rows: [] });
	});

	test('skips entries missing an id, name or file', () => {
		const page = orphanPage({ orphanedSymbols: [{ name: 'x', filePath: 'a.ts' }, 'text', null, { symbolId: 'z', name: 'ok', kind: 'type', filePath: 'a.ts' }] });
		expect(page.rows).toEqual([{ symbolId: 'z', name: 'ok', kind: 'type', filePath: 'a.ts' }]);
	});

	test('a result of the wrong shape is an empty page', () => {
		expect(orphanPage('text')).toEqual({ rows: [] });
		expect(orphanPage(null)).toEqual({ rows: [] });
		expect(orphanPage({ orphanedSymbols: 'x', summary: 3, pagination: 4 })).toEqual({ rows: [] });
	});
});

describe('byFile', () => {
	test('groups rows by file in first-seen order', () => {
		const files = byFile(ROWS);
		expect([...files.keys()]).toEqual(['src/util.ts', 'src/old.ts']);
		expect(files.get('src/util.ts')?.map((r) => r.symbolId)).toEqual(['a', 'c']);
	});
});

describe('location', () => {
	test('adds the end line only when present', () => {
		expect(location(ROWS[0]!)).toBe('src/util.ts:12');
		expect(location(ROWS[1]!)).toBe('src/old.ts');
	});
});

describe('removalPrompt', () => {
	test('asks for verification before deleting and names every export', () => {
		const text = removalPrompt(ROWS);
		expect(text.startsWith('Remove these unused exports.')).toBe(true);
		for (const word of ['traceSymbolUsage', 'impactAnalysis', 'literal text search', 'path aliases', 'export * barrels']) expect(text).toContain(word);
		expect(text).toContain('- `helper` (function) in src/util.ts:12');
		expect(text).toContain('- `Legacy` (class) in src/old.ts');
		expect(text).not.toContain('Graph as of');
	});

	test('names the commit by its first seven characters', () => {
		expect(removalPrompt(ROWS, '0123456789abcdef')).toContain('\nGraph as of 0123456.\n');
	});
});
