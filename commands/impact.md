---
description: Analyze the impact of changing a symbol or file
argument-hint: "<symbol-name> <file-path>"
allowed-tools: mcp__plugin_constellation_constellation__code_intel
---

**IMPORTANT: Do NOT invoke any skills or other commands. Directly call the MCP tool specified below.**

Analyze the impact of changing the specified symbol.

**Arguments:**
- $1: Symbol name (required)
- $2: File path (optional, helps disambiguate)

If no symbol name is provided, ask the user what symbol they want to analyze.

Call `mcp__plugin_constellation_constellation__code_intel` with this code parameter:

```javascript
const result = await api.impactAnalysis({
  symbolName: "$1",
  filePath: "$2" || undefined,
  depth: 3
});
return result;
```

**If successful**, present:
1. **Symbol**: Name, kind (function/class/etc), and location
2. **Risk Assessment**: Risk level from result.data.breakingChangeRisk.riskLevel (low/medium/high/critical) and contributing factors
3. **Impact Scope**: Files and dependents affected from result.data.summary (impactedFileCount, directDependentCount), whether it's exported (result.data.symbol.isExported)
4. **Direct Dependents**: Top 10 from result.data.directDependents
5. **Test Exposure**: Impacted test files vs production files from result.data.summary (testFileCount, productionFileCount)
6. **Recommendations**: From result.data.breakingChangeRisk.recommendations

**If high or critical risk**, emphasize caution and suggest reviewing dependents before making changes.

**If error**, explain the error and provide guidance from the error response.
