{
  "success": true,
  "pong": true,
  "data": {
    "metadata": { "primaryLanguage": "TypeScript", "totalFiles": 4217, "frameworks": ["NestJS"] },
    "structure": { "symbols": { "total": 31337 } }
  },
  "symbols": [
    { "id": "sym-1", "name": "validateToken", "kind": "function", "filePath": "src/auth/auth.service.ts", "line": 42 }
  ],
  "impact": {
    "symbolName": "validateToken",
    "filePath": "src/auth/auth.service.ts",
    "breakingChangeRisk": "high",
    "directDependents": 87,
    "transitiveDependents": 214,
    "affectedFiles": ["src/auth/auth.guard.ts", "src/api/users.controller.ts", "src/api/orders.controller.ts"],
    "publicApiExposure": true
  },
  "dependencies": { "direct": ["src/config/config.service.ts"], "circular": [] },
  "orphans": [{ "name": "legacyHelper", "kind": "function", "filePath": "src/legacy/helper.ts" }]
}
