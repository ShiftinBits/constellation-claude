---
description: Analyze dependencies for a file or symbol
argument-hint: "<file-path> [--reverse]"
allowed-tools: mcp__plugin_constellation_constellation__code_intel
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
  api.findCircularDependencies({ filePath: "$1" })
]);
return { dependencies: deps, circularDependencies: circles };
```

Present, starting with the brand line (values on one row joined with ` · `):

```
✦ >_CONSTELLATION://CODE_INTEL · deps
<file-path> · <n> internal · <m> external
Internal
  • <file> · <symbols imported from it>
External
  • <package>
Cycles       ✓ none
```

1. **Summary**: count of internal vs external dependencies, on the line under the brand line
2. **Internal**: each file and what symbols are imported from it
3. **External**: the packages used
4. **Cycles**: `✓ none`, or for each cycle found `✗ <severity> · a.ts ▸ b.ts ▸ a.ts` (the severity and the cycle path)

**For dependents (with --reverse flag):**

Call the `mcp__plugin_constellation_constellation__code_intel` tool with this code parameter:

```javascript
const result = await api.getDependents({ filePath: "$1", depth: 2 });
return result;
```

Present, starting with the brand line (values on one row joined with ` · `):

```
✦ >_CONSTELLATION://CODE_INTEL · deps
<file-path> · <n> dependent files
Dependents
  • <file> · <symbols it imports from this file>
ℹ Review these files before changing <file-path>.
```

1. **Summary**: how many files depend on this one, on the line under the brand line
2. **Dependents**: each file and what it imports from this file
3. **Note**: suggest reviewing these files if planning changes

Highlight any circular dependencies as potential issues to address.

**If error**, report it under the brand line as `✗ <error.code> · <headline> · <next step>`: the headline is error.message without its `[CODE]` prefix, the next step the first command in error.guidance, with any other guidance indented below.
