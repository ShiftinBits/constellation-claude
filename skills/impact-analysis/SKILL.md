---
name: impact-analysis
description: Use before renaming, moving, deleting or changing the signature of an existing function, class, type or file, even when the user has already said exactly what to change. Lists every caller and dependent to update, including ones a text search misses, with the change's risk and public API exposure.
when_to_use: Trigger as the first step of a rename, refactor, move, delete or signature change ("rename X to Y and update its callers", "move this to another file", "change this function's parameters"), and when the user asks "what would break if...", "what uses X", "is X safe to remove", or wants the risk of a refactor. Skip it for purely additive changes.
allowed-tools: mcp__plugin_constellation_constellation__code_intel
---

# Impact Analysis

Use the `code_intel` tool to assess the impact of proposed code changes before they happen, identifying affected files, dependents, public API exposure, and risk level.

## When to Run

Run an impact analysis when **any** of the following apply:

- About to rename, move, delete, or significantly modify a code symbol
- About to change a function signature, class shape, or exported interface
- Considering removing code suspected to be dead
- Planning a multi-file refactor and need a safe order
- User asks "what uses X?", "what would break?", "is X safe to remove?"

If the change is purely additive (new file, new function, no signature changes to existing exports), impact analysis is usually unnecessary; skip it.

## How to Run

Call the `code_intel` tool with this code:

```javascript
const result = await api.impactAnalysis({
	symbolName: "TargetSymbol",
	filePath: "src/path/to/file.ts", // optional, helps disambiguate
	depth: 3
});
return result;
```

For broader context (large refactors, whole-file changes), pair with dependency mapping:

```javascript
const [impact, deps, dependents] = await Promise.all([
	api.impactAnalysis({ symbolName, filePath, depth: 3 }),
	api.getDependencies({ filePath, depth: 2 }),
	api.getDependents({ filePath, depth: 2 }),
]);
return { impact, deps, dependents };
```

For confirming dead code:

```javascript
const usage = await api.traceSymbolUsage({ symbolName, filePath });
return usage;
```

## Interpreting Results

The `impactAnalysis` response includes a `data.breakingChangeRisk.riskLevel` field (`low` | `medium` | `high` | `critical`). Use this as the headline risk indicator. Cross-reference with:

| Signal | Where to find it | What it tells you |
|--------|------------------|-------------------|
| Affected file count | `data.summary.impactedFileCount` | Blast radius |
| Public API exposure | `data.symbol.isExported` | External consumers may break |
| Test exposure | `data.summary.testFileCount` vs `data.summary.productionFileCount` | Confidence in catching regressions |
| Direct dependents | `data.directDependents[]` | Where to look first |
| Risk factors | `data.breakingChangeRisk.factors[]` | Why the risk level is what it is |
| Recommendations | `data.breakingChangeRisk.recommendations[]` | Suggested mitigation steps |

**Risk thresholds (rule of thumb):**

- `✓ LOW`: fewer than 5 files affected, internal-only, tests among the dependents. Proceed normally
- `⚠ MEDIUM`: 5 to 15 files affected, or some public surface. Review dependents before changing
- `✗ HIGH`: more than 15 files affected, exported API, or no impacted test files. Update every dependent in the same change and suggest tests
- `✗ CRITICAL`: core infrastructure, security-adjacent, or hub modules. Update every dependent in the same change and suggest a staged migration

## Reporting Format

When presenting results to the user, start with the brand line and join values on one row with ` · `:

```
✦ >_CONSTELLATION://CODE_INTEL · impact
<name> · <kind> · <filePath>:<line>
Risk         ⚠ MEDIUM · <one-sentence rationale>
Scope        <N> files · <M> direct dependents · <exported | not exported>
Tests        <testFileCount> test files · <productionFileCount> production files
Dependents
  • <name> · <kind> · <filePath>:<line>
Next         <proceed | review the listed files | stage in N steps | add tests first>
```

1. **Symbol**: name, kind, location
2. **Risk**: the level as a glyph and an uppercase word (`✓ LOW`, `⚠ MEDIUM`, `✗ HIGH`, `✗ CRITICAL`) and a one-sentence rationale
3. **Scope**: `data.summary.impactedFileCount` files, `data.summary.directDependentCount` direct dependents, and whether the symbol is exported
4. **Dependents**: the first 5 to 10 from `directDependents`
5. **Tests**: impacted test files vs production files from `data.summary`
6. **Next**: one concrete next step

A failed call is reported as `✗ CODE · headline · next step`, for example `✗ AUTH_ERROR · Your access key wasn't accepted · const auth`.

For high or critical risk, lead with the warning and suggest a safer change order.

## After the Analysis

The analysis informs the change; it never replaces it. When the user has already asked for the change, do not stop to ask for confirmation: use the dependents as the list of places to update, make the change, and give the report with the result. Stop after the report only when the user asked for an assessment rather than the change.

## Fallbacks

If the `code_intel` call fails:

| Failure | Fallback |
|---------|----------|
| MCP unavailable | Use Grep to find textual usages of the symbol; warn the result is incomplete (misses indirect/dynamic refs) |
| `AUTH_ERROR`, `PROJECT_NOT_INDEXED` | Note the error briefly, suggest `/constellation:diagnose`, then fall back to Grep |
| `SYMBOL_NOT_FOUND` | Symbol may be renamed/deleted/misspelled. Try a broader `searchSymbols` or confirm the file path |

A partial Grep-based assessment is always better than skipping the analysis.

## Related

- The plugin's `impactGate` option (off by default) checks a file's impact automatically before Claude edits it; set it with `/config`
- `/constellation:impact <symbol> [file-path]`: one-shot slash command equivalent
- `/constellation:deps <file-path>`: dependency-only view
- `/constellation:unused`: proactive dead-code scan
