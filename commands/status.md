---
description: Check Constellation API connectivity and authentication status
allowed-tools: mcp__plugin_constellation_constellation__code_intel
---

**IMPORTANT: Do NOT invoke any skills or other commands. Directly call the MCP tool specified below.**

Check the Constellation API connection status by calling the `mcp__plugin_constellation_constellation__code_intel` tool with this code parameter:

```javascript
const result = await api.ping();
return result;
```

Start the reply with the line `✦ >_CONSTELLATION://CODE_INTEL · status`. Statuses are a glyph and a lowercase word (`✓ ok`, `⏱ <word>` in progress, `⚠ <word>` a warning, `✗ <word>`, `·` for not checked), and fields on one line are joined with ` · `.

**If successful** (result.pong === true), report:

```
✦ >_CONSTELLATION://CODE_INTEL · status
Connection   ✓ ok
Auth         ✓ ok
ℹ Run /constellation:diagnose to check the project's index.
```

**If error** (result.success is false), report the error as `✗ CODE · headline · next step` under the brand line:

| Error Code | Line |
|------------|------|
| `AUTH_ERROR` | `✗ AUTH_ERROR · Your access key wasn't accepted · const auth` |
| `PROJECT_NOT_REGISTERED` | `✗ PROJECT_NOT_REGISTERED · This project isn't registered with Constellation · check the project ID in constellation.json and your organization access` |
| `PROJECT_INACTIVE` | `✗ PROJECT_INACTIVE · This project has been deactivated · check the project at app.constellationdev.io` |
| `API_UNREACHABLE` | `✗ API_UNREACHABLE · Constellation's API can't be reached · check your network and the apiUrl in constellation.json` |
| Other codes | `✗ <error.code> · <error.message without its [CODE] prefix> · <the first command in error.guidance (written with the CLI's `const` shorthand, as in `const auth`)>`, with any other guidance indented below |
| Missing error object | `✗ INVALID_RESPONSE · Unexpected response structure · run /constellation:diagnose`, then the raw result |

**If the tool call fails entirely**, report:

```
✦ >_CONSTELLATION://CODE_INTEL · status
✗ MCP_UNAVAILABLE · The Constellation MCP server isn't connected · restart Claude Code or run /constellation:diagnose
```

Keep the response brief and actionable.
