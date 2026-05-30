// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';

// Single hash function for any token stored in refresh_tokens — both
// session refresh tokens and API keys. Storing only the SHA-256 hex means
// a compromise of the database does not expose live credentials, and
// constant-time lookup via the indexed tokenHash column stays cheap.
// Anything mutating the algorithm must update this file alone.
export function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}
