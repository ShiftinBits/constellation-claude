---
description: Find orphaned/dead code that is exported but never imported
argument-hint: "[kind: function|class|type|interface|variable]"
allowed-tools: mcp__plugin_constellation_constellation__code_intel
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
// $ARGUMENTS = user's argument (may be empty). Accept either "--kind function" or bare "function".
const raw = "$ARGUMENTS".trim();
const kind = raw.replace(/^(?:--kind|-k)\s+/, '').trim();
const params = kind ? { filterByKind: [kind] } : {};
const result = await api.findOrphanedCode(params);
return result;
```

**If orphaned code is found**, present, starting with the brand line (values on one row joined with ` · `):

```
✦ >_CONSTELLATION://CODE_INTEL · unused
<total> unused exports · <n> function · <n> class · ...
<file> · <count>
  • <name> · <kind> · line <lineEnd> · <reason> · confidence <confidence>
```

1. **Summary**: total count of orphaned exports, broken down by kind (function, class, etc.)
2. **Files with Most Orphans**: group results by file, sorted by count (show top 20)
3. **For Each File**: list the orphaned symbol names, kinds, and orphan reasons (each result includes reason and a confidence score). Results carry no start line; show `line <lineEnd>` only when lineEnd is present

**Recommendations to include:**
- Review each orphaned export to confirm it's truly unused
- Some may be entry points or dynamically imported
- Consider removing confirmed dead code to reduce maintenance burden
- Focus on files with multiple orphans first

**If no orphans found**, report `✓ No unused exports found` under the brand line and congratulate the user on a clean codebase.

**If error**, report it under the brand line as `✗ <error.code> · <headline> · <next step>`: the headline is error.message without its `[CODE]` prefix, the next step the first command in error.guidance (written with the CLI's `const` shorthand, as in `const auth`), with any other guidance indented below.
