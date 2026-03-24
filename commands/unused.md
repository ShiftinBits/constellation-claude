---
description: Find orphaned/dead code that is exported but never imported
argument-hint: [kind: function|class|type|interface|variable]
allowed-tools: mcp__plugin_constellation_constellation__code_intel
effort: medium
---

**IMPORTANT: Do NOT invoke any skills or other commands. Directly call the MCP tool specified below.**

Find exported code that is never imported or used anywhere in the codebase.

**Arguments:**
- $ARGUMENTS: Optional filter by symbol kind (function, class, type, interface, variable)

**Construct the API call:**
- If `$ARGUMENTS` is empty or not provided: call with no filter
- If `$ARGUMENTS` contains a kind: pass it as an array element

Call the `mcp__plugin_constellation_constellation__code_intel` tool:

```javascript
// $ARGUMENTS = user's argument (may be empty)
const kindFilter = "$ARGUMENTS".trim();
const params = kindFilter ? { filterByKind: [kindFilter] } : {};
const result = await api.findOrphanedCode(params);
return result;
```

**If orphaned code is found**, present:
1. **Summary**: Total count of orphaned exports, broken down by kind (function, class, etc.)
2. **Files with Most Orphans**: Group results by file, sorted by count (show top 20)
3. **For Each File**: List the orphaned symbol names, kinds, and line numbers

**Recommendations to include:**
- Review each orphaned export to confirm it's truly unused
- Some may be entry points or dynamically imported
- Consider removing confirmed dead code to reduce maintenance burden
- Focus on files with multiple orphans first

**If no orphans found**, congratulate the user on a clean codebase.

**If error**, explain the error and provide guidance from the error response.
