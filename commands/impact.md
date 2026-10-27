---
description: Analyze the impact of changing a symbol or file
argument-hint: "<symbol-name> [file-path]"
arguments: symbol path
allowed-tools: mcp__plugin_constellation_constellation__code_intel
---

**IMPORTANT: Do NOT invoke any skills or other commands. Directly call the MCP tool specified below.**

Analyze the impact of changing the specified symbol.

**Arguments:**
- $symbol: Symbol name (required)
- $path: File path (optional, helps disambiguate)

If no symbol name is provided, ask the user what symbol they want to analyze.

Call `mcp__plugin_constellation_constellation__code_intel` with this code parameter:

```javascript
const result = await api.impactAnalysis({
  symbolName: "$symbol",
  filePath: "$path" === "" ? undefined : "$path",
  depth: 3
});
return result;
```

**If successful**, report in this layout, starting with the brand line. Values on one row are joined with ` · `:

```
✦ >_CONSTELLATION://CODE_INTEL · impact
<name> · <kind> · <filePath>:<line>
Risk         <risk> · <one-line rationale from result.data.breakingChangeRisk.factors>
Scope        <impactedFileCount> files · <directDependentCount> direct dependents · <exported | not exported>
Tests        <testFileCount> test files · <productionFileCount> production files
Dependents
  • <name> · <kind> · <filePath>:<line>   (top 10 from result.data.directDependents)
Recommendations
  • <each of result.data.breakingChangeRisk.recommendations>
```

- **Symbol**: name, kind and location from result.data.symbol
- **Risk**: result.data.breakingChangeRisk.riskLevel as a glyph and an uppercase word: `✓ LOW`, `⚠ MEDIUM`, `✗ HIGH`, `✗ CRITICAL`
- **Scope**: from result.data.summary (impactedFileCount, directDependentCount) and result.data.symbol.isExported
- **Tests**: impacted test files vs production files from result.data.summary (testFileCount, productionFileCount)

**If high or critical risk**, emphasize caution and suggest reviewing dependents before making changes.

**If error**, report it under the brand line as `✗ <error.code> · <headline> · <next step>`: the headline is error.message without its `[CODE]` prefix, the next step the first command in error.guidance (written with the CLI's `const` shorthand, as in `const auth`) (for example `✗ AUTH_ERROR · Your access key wasn't accepted · const auth`), with any other guidance indented below.
