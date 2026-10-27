---
description: Quick health check for Constellation connectivity and authentication
allowed-tools: mcp__plugin_constellation_constellation__code_intel
disable-model-invocation: true
disallowed-tools: Skill
---

**IMPORTANT: Do NOT invoke any skills or other commands. Directly call the MCP tool specified below.**

Run a quick Constellation health check by calling `mcp__plugin_constellation_constellation__code_intel` with this code:

```javascript
const result = await api.getArchitectureOverview({});
return {
  success: result.success,
  error: result.error,
  primaryLanguage: result.data?.metadata?.primaryLanguage,
  files: result.data?.metadata?.totalFiles,
  symbols: result.data?.structure?.symbols?.total
};
```

**Interpret the response and report.** Start with the line `✦ >_CONSTELLATION://CODE_INTEL · diagnose`, then one row per field. Statuses are a glyph and a lowercase word (`✓ ok`, `⏱ <word>` in progress, `⚠ <word>` a warning, `✗ <word>`, `· not checked`); values on one row are joined with ` · `. An error is one line, `✗ CODE · headline · next step`, under the rows.

### If the tool call FAILS ENTIRELY (timeout, connection error, MCP not found):

```
✦ >_CONSTELLATION://CODE_INTEL · diagnose
MCP server   ✗ unreachable
API          · not checked
Auth         · not checked
Index        · not checked

✗ MCP_UNAVAILABLE · The Constellation MCP server isn't connected · restart Claude Code
  Check that npm can run the server version set in the plugin's .mcp.json (the one place the version is set)
```

### If `result.success` is true:

```
✦ >_CONSTELLATION://CODE_INTEL · diagnose
MCP server   ✓ ok
API          ✓ ok
Auth         ✓ ok
Index        ✓ ok · <files> files · <symbols> symbols · <primaryLanguage>
```

### If `result.success` is false, check `result.error.code`:

**AUTH_ERROR:**
```
✦ >_CONSTELLATION://CODE_INTEL · diagnose
MCP server   ✓ ok
API          ✓ ok
Auth         ✗ error
Index        · not checked

✗ AUTH_ERROR · Your access key wasn't accepted · const auth
```

**PROJECT_NOT_INDEXED:**
```
✦ >_CONSTELLATION://CODE_INTEL · diagnose
MCP server   ✓ ok
API          ✓ ok
Auth         ✓ ok
Index        ⚠ not indexed

✗ PROJECT_NOT_INDEXED · This project hasn't been indexed yet · const index
```

**API_UNREACHABLE:**
```
✦ >_CONSTELLATION://CODE_INTEL · diagnose
MCP server   ✓ ok
API          ✗ unreachable
Auth         · not checked
Index        · not checked

✗ API_UNREACHABLE · Constellation's API can't be reached · check your network and the apiUrl in constellation.json
  Self-hosted: make sure the API is running at the configured URL
```

**Other errors:**
```
✦ >_CONSTELLATION://CODE_INTEL · diagnose
MCP server   ✓ ok
API          ✓ ok
Auth         · not checked
Index        · not checked

✗ <error.code> · <error.message without its [CODE] prefix> · <the first command in error.guidance (written with the CLI's `const` shorthand, as in `const auth`)>
  <any other error.guidance lines, one per line>
```

Keep the response brief and actionable.
