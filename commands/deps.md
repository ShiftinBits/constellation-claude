---
description: Analyze dependencies for a file or symbol
argument-hint: [file-path] [--reverse]
allowed-tools: mcp__plugin_constellation_constellation__code_intel
context: fork
effort: high
---

**IMPORTANT: Do NOT invoke any skills or other commands. Directly call the MCP tool specified below.**

Analyze dependencies for the specified file.

**Arguments:**
- $1: File path (required)
- $2: Optional "--reverse" or "-r" flag to show what depends ON this file

If no file path is provided, ask the user what file they want to analyze.

**For dependencies (default, no --reverse flag):**

Call the `mcp__plugin_constellation_constellation__code_intel` tool with this code parameter:

```javascript
const [deps, circles] = await Promise.all([
  api.getDependencies({ filePath: "$1", depth: 2, includePackages: true }),
  api.findCircularDependencies({ filePath: "$1", maxDepth: 5 })
]);
return { dependencies: deps, circularDependencies: circles };
```

Present:
1. **Summary**: Count of internal vs external dependencies
2. **Internal Dependencies**: Each file and what symbols are imported from it
3. **External Packages**: List of npm packages used
4. **Circular Dependencies**: If any cycles detected, show severity and the cycle path

**For dependents (with --reverse flag):**

Call the `mcp__plugin_constellation_constellation__code_intel` tool with this code parameter:

```javascript
const result = await api.getDependents({ filePath: "$1", depth: 2 });
return result;
```

Present:
1. **Summary**: How many files depend on this one
2. **Dependents**: Each file and what it imports from this file
3. **Note**: Suggest reviewing these files if planning changes

Highlight any circular dependencies as potential issues to address.
