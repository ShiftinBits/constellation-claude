---
description: Quick health check for Constellation connectivity and authentication
allowed-tools: mcp__plugin_constellation_constellation__code_intel
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

**Interpret the response and report:**

### If the tool call FAILS ENTIRELY (timeout, connection error, MCP not found):

```
Constellation Health Check
===========================
MCP Server:  UNREACHABLE
API Auth:    -

Issue: The Constellation MCP server is not running or not configured.

Quick Fixes:
1. Restart Claude Code to reinitialize MCP connections
2. Verify npm can run: npx @constellationdev/mcp@1.2.11 --version
3. Check .mcp.json configuration in the plugin directory
```

### If `result.success` is true:

```
Constellation Health Check
===========================
MCP Server:  OK
API Auth:    OK
Project:     <primaryLanguage> project
Index:       <files> files, <symbols> symbols

All systems operational.
```

### If `result.success` is false, check `result.error.code`:

**AUTH_ERROR:**
```
Constellation Health Check
===========================
MCP Server:  OK
API Auth:    FAILED

Issue: Authentication failed - API key missing or invalid.

Quick Fix: Run `constellation auth` to configure credentials.
```

**PROJECT_NOT_INDEXED:**
```
Constellation Health Check
===========================
MCP Server:  OK
API Auth:    OK
Project:     Not indexed

Issue: This project hasn't been indexed yet.

Quick Fix: Run `constellation index --full` in your project directory.
```

**API_UNREACHABLE:**
```
Constellation Health Check
===========================
MCP Server:  OK
API Auth:    UNREACHABLE

Issue: Cannot reach the Constellation API server.

Quick Fixes:
1. Check network connectivity
2. Verify API URL in constellation.json
3. For self-hosted: ensure API is running at configured URL
```

**Other errors:**
```
Constellation Health Check
===========================
MCP Server:  OK
API Auth:    ERROR

Code: <error.code>
Message: <error.message>

Guidance: <error.guidance if available>
```

Keep the response brief and actionable.
