// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { OCPI_PULL_MODULES } from '@evtivity/lib';
import { OCPI_MODULES } from '../modules.js';
import { buildModuleEndpoints } from '../routes/versions.js';
import { pullCdrs, pullLocations, pullTariffs } from '../services/pull.service.js';
import { config } from '../lib/config.js';

// The versions endpoint list as served before the module registry existed.
// The registry must reproduce it exactly, in the same order.
const ENDPOINTS_BEFORE_REGISTRY = [
  { identifier: 'credentials', role: 'SENDER', path: 'credentials' },
  { identifier: 'credentials', role: 'RECEIVER', path: 'credentials' },
  { identifier: 'locations', role: 'SENDER', path: 'cpo/locations' },
  { identifier: 'locations', role: 'RECEIVER', path: 'emsp/locations' },
  { identifier: 'sessions', role: 'SENDER', path: 'cpo/sessions' },
  { identifier: 'sessions', role: 'RECEIVER', path: 'emsp/sessions' },
  { identifier: 'cdrs', role: 'SENDER', path: 'cpo/cdrs' },
  { identifier: 'cdrs', role: 'RECEIVER', path: 'emsp/cdrs' },
  { identifier: 'tariffs', role: 'SENDER', path: 'cpo/tariffs' },
  { identifier: 'tariffs', role: 'RECEIVER', path: 'emsp/tariffs' },
  { identifier: 'tokens', role: 'SENDER', path: 'emsp/tokens' },
  { identifier: 'tokens', role: 'RECEIVER', path: 'cpo/tokens' },
  { identifier: 'commands', role: 'RECEIVER', path: 'cpo/commands' },
  { identifier: 'hubclientinfo', role: 'RECEIVER', path: 'hubclientinfo' },
] as const;

describe('OCPI module registry', () => {
  it('gives every module a unique identifier', () => {
    const ids = OCPI_MODULES.map((m) => m.identifier);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('marks exactly the shared pull modules as pullable', () => {
    const pullable = OCPI_MODULES.filter((m) => m.pull != null).map((m) => m.identifier);
    expect([...pullable].sort()).toEqual([...OCPI_PULL_MODULES].sort());
  });

  it('wires each pullable module to its pull function', () => {
    const pulls = Object.fromEntries(OCPI_MODULES.map((m) => [m.identifier, m.pull]));
    expect(pulls).toMatchObject({
      locations: pullLocations,
      tariffs: pullTariffs,
      cdrs: pullCdrs,
    });
  });

  it('registers routes for every module', () => {
    for (const m of OCPI_MODULES) {
      expect(m.routes.length, m.identifier).toBeGreaterThan(0);
    }
  });

  it.each(['2.2.1', '2.3.0'] as const)(
    'serves the same %s endpoint list as before the registry',
    (version) => {
      const prefix = `${config.OCPI_BASE_URL}/ocpi/${version}`;
      expect(buildModuleEndpoints(version)).toEqual(
        ENDPOINTS_BEFORE_REGISTRY.map(({ identifier, role, path }) => ({
          identifier,
          role,
          url: `${prefix}/${path}`,
        })),
      );
    },
  );
});
