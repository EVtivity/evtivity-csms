// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { permissionCatalog } from '@evtivity/lib/permissions';
import { AUDIT_ENTITY_TYPES } from '../audit-labels';
import { AUDIT_ENTITY_ROUTES, auditEntityRoute } from '../audit-entity-routes';
import appSource from '../../App.tsx?raw';

const routePaths = [...appSource.matchAll(/path="([^"]+)"/g)].map((m) => `/${m[1] ?? ''}`);

/** Whether `path` matches a route of App.tsx (`:param` segments match any one segment). */
function matchesAppRoute(path: string): boolean {
  const [pathname] = path.split('?');
  const segments = (pathname ?? '').split('/');
  return routePaths.some((route) => {
    const parts = route.split('/');
    if (parts.length !== segments.length) return false;
    return parts.every((part, i) => part.startsWith(':') || part === segments[i]);
  });
}

describe('AUDIT_ENTITY_ROUTES', () => {
  it('maps every audited entity type, to a route or explicitly to none', () => {
    expect(Object.keys(AUDIT_ENTITY_ROUTES).sort()).toEqual([...AUDIT_ENTITY_TYPES].sort());
  });

  it('points each route at a page of App.tsx and a known permission', () => {
    for (const [type, route] of Object.entries(AUDIT_ENTITY_ROUTES)) {
      if (route == null) continue;
      const path = route.path('abc_123');
      expect(matchesAppRoute(path), `${type} -> ${path}`).toBe(true);
      expect(permissionCatalog.isKnown(route.permission), `${type} permission`).toBe(true);
    }
  });

  it('encodes the id and answers null for an unknown type', () => {
    expect(auditEntityRoute('station')?.path('a/b')).toBe('/stations/a%2Fb');
    expect(auditEntityRoute('nope')).toBeNull();
  });
});
