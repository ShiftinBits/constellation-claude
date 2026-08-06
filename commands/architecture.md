---
description: Get a high-level overview of the codebase architecture
allowed-tools: mcp__plugin_constellation_constellation__code_intel
---

**IMPORTANT: Do NOT invoke any skills or other commands. Directly call the MCP tool specified below.**

Retrieve a high-level architectural overview of the codebase.

Call the `mcp__plugin_constellation_constellation__code_intel` tool with this code parameter:

```javascript
const result = await api.getArchitectureOverview({ includeMetrics: true, includeModuleGraph: false });
return result;
```

**Present the following:**

1. **Project Summary**
   - Primary language (result.data.metadata.primaryLanguage) and detected frameworks (result.data.metadata.frameworks)
   - Total files (result.data.metadata.totalFiles) and total symbols (result.data.structure.symbols.total)

2. **Language Distribution**
   - For each language in result.data.metadata.languages, show:
     - Language name (language)
     - File count (fileCount)
     - Percentage of codebase (percentage)

3. **Symbol Breakdown**
   - Top 10 symbol kinds from result.data.structure.symbols.byKind (functions, classes, interfaces, etc.)
   - Show count for each, plus the exported count (result.data.structure.symbols.exported)

4. **Dependency Hotspots**
   - Most connected files from result.data.dependencies.internal.mostConnectedFiles (path, incoming/outgoing counts)
   - These represent the hub modules of the codebase
   - Top external packages from result.data.dependencies.external.topPackages

5. **Quality Metrics** (only if result.data.metrics is present)
   - Average complexity and high-complexity count (metrics.complexity)
   - Maintainability score and issues (metrics.maintainability)
   - Test coverage percentage if available (metrics.testCoverage)

6. **Observations** (optional insights):
   - Note if it's heavily function-based vs class-based
   - Multi-language codebase characteristics
   - Concentration of connections in a few hub files

Keep the output concise and scannable. Focus on giving a quick mental model of the codebase structure.
