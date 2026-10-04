import { describe, expect, test } from 'claude-code/testing';
import { askText, callTree, detailLines, drillCode, hits, impactView, rankExact, searchCode, searchQuery, usageLines, where } from './explore';
import type { Hit } from './explore';

const HITS: Hit[] = [
	{ id: '1', name: 'GraphService', kind: 'class', filePath: 'src/a.ts', line: 3 },
	{ id: '2', name: 'graph', kind: 'variable', filePath: 'src/b.ts' },
	{ id: '3', name: 'Graph', kind: 'class', filePath: 'src/c.ts', line: 10 },
	{ id: '4', name: 'GraphNode', kind: 'interface', filePath: 'src/d.ts', line: 1 },
];

describe('rankExact', () => {
	test('puts the exact match first when it sits after substring matches', () => {
		expect(rankExact('Graph', HITS).map((h) => h.id)).toEqual(['3', '2', '1', '4']);
	});

	test('keeps the server order when nothing matches exactly', () => {
		expect(rankExact('Gra', HITS).map((h) => h.id)).toEqual(['1', '2', '3', '4']);
	});
});

describe('hits', () => {
	test('reads symbols and skips entries without an id or a name', () => {
		const found = hits({ symbols: [{ id: 'a', name: 'X', kind: 'function', filePath: 'f.ts', line: 2 }, { name: 'no id' }, 'text', { id: 'b' }] });
		expect(found).toEqual([{ id: 'a', name: 'X', kind: 'function', filePath: 'f.ts', line: 2 }]);
	});

	test('a result of the wrong shape gives no hits', () => {
		expect(hits(null)).toEqual([]);
		expect(hits({ symbols: 'x' })).toEqual([]);
	});
});

describe('where', () => {
	test('adds the line only when there is one', () => {
		expect(where(HITS[0] as Hit)).toBe('src/a.ts:3');
		expect(where(HITS[1] as Hit)).toBe('src/b.ts');
	});
});

describe('query code', () => {
	test('the search asks for a full page of the query', async () => {
		const asked: unknown[] = [];
		await searchQuery({ searchSymbols: async (p) => (asked.push(p), { symbols: [] }) }, 'a"b');
		expect(asked).toEqual([{ query: 'a"b', limit: 100 }]);
	});

	test('the search sends back only the fields the pane reads, so a full page stays small', async () => {
		const symbol = { id: 's1', name: 'Graph', qualifiedName: 'a.Graph', kind: 'class', filePath: 'src/g.ts', line: 3, signature: 'class Graph', isExported: true, sourceSnippet: 'x'.repeat(2000) };
		const result = await searchQuery({ searchSymbols: async () => ({ symbols: Array.from({ length: 100 }, () => symbol), resultContext: {} }) }, 'Graph');
		expect(hits(result)).toHaveLength(100);
		expect(result.symbols[0]).toEqual({ id: 's1', name: 'Graph', kind: 'class', filePath: 'src/g.ts', line: 3 });
		expect(JSON.stringify(result).length).toBeLessThan(20_000);
	});

	test('searchCode sends the function with the escaped query', () => {
		expect(searchCode('a"b')).toBe(`return await (${searchQuery.toString()})(api, "a\\"b");`);
	});

	test('the drill sends all four reads with the escaped id', () => {
		const code = drillCode('id"1');
		for (const method of ['getSymbolDetails', 'traceSymbolUsage', 'impactAnalysis', 'getCallGraph']) expect(code).toContain(`api.${method}(`);
		expect(code).toContain('"id\\"1"');
		expect(code).toContain('Promise.all');
	});
});

describe('detailLines', () => {
	test('reads the signature, kind, export flag and complexity', () => {
		const lines = detailLines({ symbol: { signature: 'class Graph', kind: 'class', isExported: false, complexity: { cyclomaticComplexity: 4, complexityRisk: 'low' } } });
		expect(lines).toEqual(['Signature: class Graph', 'Kind: class', 'Exported: no', 'Complexity: 4 (low)']);
	});

	test('leaves out what is missing', () => {
		expect(detailLines({ symbol: { kind: 'function', isExported: true } })).toEqual(['Kind: function', 'Exported: yes']);
		expect(detailLines({})).toEqual([]);
	});
});

describe('usageLines', () => {
	test('gives the totals then the rows, capped at 15', () => {
		const directUsages = Array.from({ length: 20 }, (_, i) => ({ filePath: `f${i}.ts`, line: i + 1, usageType: 'call' }));
		const lines = usageLines({ summary: { totalUsages: 20, filesAffected: 20 }, directUsages });
		expect(lines).toHaveLength(16);
		expect(lines.slice(0, 2)).toEqual(['20 usages in 20 files', 'f0.ts:1 call']);
	});

	test('a row without a line or type is just the file', () => {
		expect(usageLines({ directUsages: [{ filePath: 'f.ts' }] })).toEqual(['f.ts']);
	});
});

describe('impactView', () => {
	test('reads risk, counts and the top ten dependents', () => {
		const directDependents = Array.from({ length: 12 }, (_, i) => ({ name: `d${i}`, kind: 'function' }));
		const view = impactView({
			breakingChangeRisk: { riskLevel: 'high' },
			summary: { impactedFileCount: 5, directDependentCount: 12, transitiveDependentCount: 30, testFileCount: 2, productionFileCount: 3 },
			directDependents,
		});
		expect(view).toMatchObject({ riskLevel: 'high', files: 5, direct: 12, transitive: 30, tests: 2, production: 3 });
		expect(view.top).toHaveLength(10);
	});

	test('partial data gives only what is there', () => {
		expect(impactView({ summary: { impactedFileCount: 1 } })).toEqual({ files: 1, top: [] });
		expect(impactView('text')).toEqual({ top: [] });
	});
});

describe('callTree', () => {
	test('puts callers above the root and callees below, with their depth', () => {
		const tree = callTree({
			root: { name: 'root' },
			callers: [{ name: 'near', filePath: 'n.ts', line: 1, depth: 1 }, { name: 'far', depth: 2 }],
			callees: [{ name: 'deep', depth: 2 }, { name: 'next', filePath: 'x.ts', depth: 1 }],
		});
		expect(tree).toEqual([
			{ text: 'far', depth: 2 },
			{ text: 'near  n.ts:1', depth: 1 },
			{ text: 'root', depth: 0 },
			{ text: 'next  x.ts', depth: 1 },
			{ text: 'deep', depth: 2 },
		]);
	});

	test('a result of the wrong shape gives no lines', () => {
		expect(callTree(undefined)).toEqual([]);
		expect(callTree({ callers: 'x' })).toEqual([]);
	});
});

describe('askText', () => {
	test('names the symbol, its kind and where it is', () => {
		const text = askText(HITS[0] as Hit);
		expect(text).toContain('`GraphService` (class) at src/a.ts:3');
		expect(text).toContain('what would break if it changed');
	});
});
