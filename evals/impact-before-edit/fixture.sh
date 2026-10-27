#!/usr/bin/env bash
set -euo pipefail
mkdir -p src/auth src/api
cat > src/auth/auth.service.ts <<'TS'
export function validateToken(token: string): boolean {
	return token.startsWith('Bearer ');
}
TS
cat > src/auth/auth.guard.ts <<'TS'
import { validateToken } from './auth.service';

export const guard = (header: string): boolean => validateToken(header);
TS
cat > src/api/users.controller.ts <<'TS'
import { validateToken } from '../auth/auth.service';

export const canListUsers = (header: string): boolean => validateToken(header);
TS
