// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';

// Every portal source file except tests.
const SOURCES = import.meta.glob<string>(['../../**/*.{ts,tsx}', '!**/__tests__/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

// Glob keys are relative to this file, so the hook is '../use-portal-features.ts'.
const SHARED_HOOK = /^\.\.\/use-portal-features\.ts$/;

// The portal reads GET /v1/portal/features through usePortalFeatures only,
// so every reader shares one request, one cache key and one cache time.
describe('portal features reads', () => {
  it('go through usePortalFeatures only', () => {
    const offenders: string[] = [];
    let hookSeen = false;
    for (const [file, source] of Object.entries(SOURCES)) {
      if (SHARED_HOOK.test(file)) {
        hookSeen = true;
        continue;
      }
      if (/api\.get\s*(<[^>]*>)?\s*\(\s*['"`]\/v1\/portal\/features['"`]/.test(source)) {
        offenders.push(`${file}: api.get('/v1/portal/features')`);
      }
      if (/['"`]portal-features['"`]/.test(source)) {
        offenders.push(`${file}: 'portal-features' key literal`);
      }
    }
    expect(hookSeen).toBe(true);
    expect(offenders).toEqual([]);
  });
});
