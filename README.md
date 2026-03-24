# <img src="https://constellationdev.io/clawd-icon.svg" height="30"> Constellation Plugin for Claude Code

[![MCP Server](https://img.shields.io/badge/mcp-@constellationdev/mcp-black.svg?logo=modelcontextprotocol)](https://github.com/ShiftinBits/constellation-mcp) [![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-3DA639?logo=opensourceinitiative&logoColor=white)](LICENSE)

While Constellation's MCP server provides raw code intelligence capabilities, this plugin enhances your Claude Code experience with:

| Feature | Benefit |
|---------|---------|
| **Slash Commands** | Quick access to common workflows |
| **Contextual Skills** | Claude automatically loads relevant knowledge when needed |
| **Proactive Agents** | Claude suggests analysis before you make risky changes |
| **Safety Hooks** | Reminders to check impact before modifying code |

## Features

### Commands

Execute powerful analysis with simple slash commands:

| Command | Description |
|---------|-------------|
| `/constellation:status` | Check API connectivity and project indexing status |
| `/constellation:diagnose` | Quick health check for connectivity and authentication |
| `/constellation:impact <symbol> <file>` | Analyze blast radius before changing a symbol |
| `/constellation:deps <file> [--reverse]` | Map dependencies or find what depends on a file |
| `/constellation:unused` | Discover orphaned exports and dead code |
| `/constellation:architecture` | Get a high-level overview of your codebase structure |

### Skills

Claude automatically activates specialized knowledge based on your questions:

| Skill | Triggers When You Ask About... |
|-------|-------------------------------|
| **constellation-troubleshooting** | Error codes, connectivity issues, debugging problems |

### Agents

Specialized AI agents for autonomous analysis:

| Agent | Purpose |
|-------|---------|
| **source-scout** | Explores and navigates codebase, discovers symbols and architectural patterns |
| **impact-investigator** | Proactively assesses risk before refactoring, renaming, or deleting code |
| **dependency-detective** | Detects circular dependencies and unhealthy coupling patterns |

**Example Trigger:**
```
You: "Rename AuthService to AuthenticationService"
Claude: "Before renaming, let me analyze the potential impact..."
[Launches impact-investigator agent]
```

### Hooks

Event hooks enable intelligent, transparent assistance:

| Hook | Event | Behavior |
|------|-------|----------|
| **Availability Check** | `SessionStart` | Silently checks Constellation connectivity at session start |
| **Context Preservation** | `PreCompact` | Preserve any Constellation insights in compacted summary |

## Installation

### Prerequisites

1. **Constellation Account** (see [Constellation](https://app.constellationdev.io))
2. **Project indexed** in Constellation
3. **Access key** configured

### Quick Start

```bash
# Add the marketplace to Claude
claude plugin marketplace add ShiftinBits/constellation-claude

# Install the Constellation Claude plugin
claude plugin install constellation@constellation-plugins
```

## Usage Examples

### Check Your Setup

```
> /constellation:status

Status: Connected
Project: my-awesome-app
Files Indexed: 1,247
Symbols: 8,932
Languages: TypeScript, JavaScript
```

### Analyze Before Refactoring

```
> /constellation:impact validateUser src/auth/validator.ts

Symbol: validateUser (function)
Risk Level: MEDIUM
Files Affected: 12
Symbols Affected: 34
Test Coverage: 67%

Recommendations:
- Update unit tests in auth.spec.ts
- Check integration with UserController
```

### Find Dead Code

```
> /constellation:unused --kind function

Found 7 orphaned functions:
├── src/utils/legacy.ts
│   ├── formatLegacyDate (line 23)
│   └── parseLegacyConfig (line 45)
├── src/helpers/deprecated.ts
│   └── oldValidation (line 12)
...
```

### Understand Dependencies

```
> /constellation:deps src/services/payment.service.ts

Dependencies (12):
├── Internal (8)
│   ├── src/models/payment.model.ts
│   ├── src/utils/currency.ts
│   └── ...
└── External (4)
    ├── stripe
    ├── lodash
    └── ...

No circular dependencies detected.
```

## Troubleshooting

### Common Issues

| Issue | Solution |
|-------|----------|
| `AUTH_ERROR` | Check `CONSTELLATION_ACCESS_KEY` is set correctly, use `constellation auth` CLI command to set |
| `PROJECT_NOT_INDEXED` | Run `constellation index --full` in your project |
| Commands not appearing | Restart Claude Code or check plugin path |

## Documentation

- [Constellation Documentation](https://docs.constellationdev.io) — Full platform documentation
- [MCP Server](https://github.com/shiftinbits/constellation-mcp) — Underlying MCP server
- [Claude Code Plugins](https://docs.anthropic.com/claude-code/plugins) — Plugin development guide

## License

GNU Affero General Public License v3.0 (AGPL-3.0)

Copyright © 2026 ShiftinBits Inc.

See [LICENSE](LICENSE) file for details.
