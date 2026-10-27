---
name: constellation-troubleshooting
description: Diagnose and fix Constellation plugin problems such as API connection failures, authentication errors, indexing problems and MCP server startup issues.
when_to_use: Trigger when the user asks about "Constellation errors", "fix Constellation", "debug Constellation", "Constellation not working", "API connection issues", "indexing problems", "MCP server", "Failed to reconnect", mentions any Constellation error codes (AUTH_ERROR, PROJECT_NOT_INDEXED, etc.), or when Constellation commands fail.
allowed-tools: mcp__plugin_constellation_constellation__code_intel
---

# Constellation Troubleshooting

Quick diagnostic procedures for Constellation plugin issues.

## Quick Diagnosis Flowchart

```
Issue Reported
     |
     v
Can the code_intel tool be called?
     |                    |
    YES                   NO
     |                    |
     v                    v
  API Error          MCP Server Issue
 (has code)         (see MCP Diagnosis)
     |
     v
Check error.code:
- AUTH_ERROR --> Authentication section
- PROJECT_NOT_INDEXED --> Indexing section
- SYMBOL_NOT_FOUND --> Query Issues section
- API_UNREACHABLE --> Connectivity section
- CWD_NOT_INDEXED --> Multi-project cwd section
```

When you report an error to the user, start with `✦ >_CONSTELLATION://CODE_INTEL · <topic>` and put the error on one line as `✗ CODE · headline · next step`, for example `✗ PROJECT_NOT_INDEXED · This project hasn't been indexed yet · const index`. Write every CLI command with its `const` shorthand (`const auth`, `const index`), even where the error guidance spells out `constellation`.

In the terminal and the desktop app, the Constellation onboarding band above the prompt offers **Sign in** and **Index this project** buttons (on Windows it names the command to run in a terminal instead). The manual steps below still apply.

## MCP Server Issues

**Symptom:** "Failed to reconnect to plugin:constellation:constellation" or tool calls fail entirely.

**Cause:** The MCP server isn't starting or is crashing.

**Quick Fixes:**

1. **Restart Claude Code**: MCP connections initialize at startup

2. **Verify MCP configuration:**

   The server is built into the Constellation plugin. Its plugin-level `.mcp.json` is the one place the `@constellationdev/mcp` version is set; the entry should look like this, with `<version>` standing for that pinned version:

   ```json
   {
     "mcpServers": {
       "constellation": {
         "type": "stdio",
         "command": "npx",
         "args": ["-y", "@constellationdev/mcp@<version>"],
         "env": {
           "CONSTELLATION_ACCESS_KEY": "${CONSTELLATION_ACCESS_KEY}"
         }
       }
     }
   }
   ```

## Authentication Issues (AUTH_ERROR)

**Symptom:** "Authentication failed" or "Invalid API key"

**Quick Fixes:**

1. **Configure credentials:**

   ```bash
   const auth
   ```

2. **Check if access key is properly set:**

   In the event of `AUTH_ERROR` failures the MCP server provides details in the `error.guidance[0]` value of the response object, indicating the current state of the `CONSTELLATION_ACCESS_KEY` environment variable.

3. **If key is expired:** Regenerate in Constellation web UI under Settings > API Keys

## Indexing Issues (PROJECT_NOT_INDEXED)

**Symptom:** "Project not indexed" or empty results

**Quick Fixes:**

1. **Index the project:**

   ```bash
   cd /path/to/your/project
   const index
   ```

2. **Force reindex if stale:**

   ```bash
   const index --full --force
   ```

## Connectivity Issues (API_UNREACHABLE)

**Symptom:** Timeout or connection refused

**Quick Fixes:**

1. **Check network connectivity**

2. **Check Constellation status at https://status.constellationdev.io/**

## Multi-project cwd (CWD_NOT_INDEXED)

**Symptom:** `CWD_NOT_INDEXED` before any query runs.

**Cause:** `cwd` resolves to a git root with no `constellation.json`, typically a monorepo root.

**Fix:** Read `error.context.candidates` for the discovered project roots and re-run `code_intel` with `cwd` set to one of them.

## Query Issues (SYMBOL_NOT_FOUND, FILE_NOT_FOUND)

These are typically **not errors**: the item simply wasn't found in the index.

**Troubleshooting:**

1. Try partial/broader search terms
2. Check spelling and case sensitivity
3. Verify the file extension is in configured languages
4. Re-index if the file was recently added

## Diagnostic Command

Run `/constellation:diagnose` for a quick health check that tests:

- MCP server connectivity
- API authentication
- Project indexing status

See `references/error-codes.md` for complete error code documentation.
