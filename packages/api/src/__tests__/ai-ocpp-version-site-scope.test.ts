// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';

// The AI OCPP version check with the real findCommandStation: a site-restricted
// user gets the same refusal for an unsited, a foreign and an unknown station,
// and the refusal never names the station's OCPP version.

const { stations } = vi.hoisted(() => ({
  stations: new Map<string, { id: string; siteId: string | null; ocppProtocol: string }>([
    ['CS-OWN', { id: 'sta_own', siteId: 'sit_a', ocppProtocol: 'ocpp2.1' }],
    ['CS-FOREIGN', { id: 'sta_foreign', siteId: 'sit_b', ocppProtocol: 'ocpp2.1' }],
    ['CS-UNSITED', { id: 'sta_unsited', siteId: null, ocppProtocol: 'ocpp2.1' }],
  ]),
}));

vi.mock('drizzle-orm', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  eq: (_col: unknown, value: unknown) => value,
}));

vi.mock('@evtivity/database', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  let lookup: unknown;
  const chain = {
    select: () => chain,
    from: () => chain,
    where: (value: unknown) => {
      lookup = value;
      return chain;
    },
    then: (resolve: (rows: unknown[]) => unknown) => {
      const row = stations.get(lookup as string);
      return Promise.resolve(row == null ? [] : [row]).then(resolve);
    },
  };
  return { ...actual, db: chain };
});

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn(async () => ['sit_a']),
}));

import { AI_TOOL_CATALOG } from '../services/ai/tools/catalog.js';
import { chatbotToolset } from '../services/ai/surfaces/toolsets.js';
import { toolOcppVersion } from '../services/ai/tools/ocpp-version.js';
import { checkOcppCommandVersion } from '../services/ai/tools/ocpp-command-check.js';

const OCPP = chatbotToolset(
  [...new Set(AI_TOOL_CATALOG.filter((t) => toolOcppVersion(t) !== null).map((t) => t.category))],
  AI_TOOL_CATALOG,
);

function reset16(stationId: string) {
  const entry = OCPP.byName.get('ocppv16_reset');
  if (entry === undefined) throw new Error('no chatbot tool ocppv16_reset');
  return { entry, args: { stationId, type: 'Soft' } };
}

const restricted = { userId: 'usr_site_a', hasPermission: async () => true };

describe('AI OCPP version check for a site-restricted user (real station lookup)', () => {
  it('refuses an unsited, a foreign and an unknown station alike, without the version', async () => {
    const results = await Promise.all(
      ['CS-UNSITED', 'CS-FOREIGN', 'CS-UNKNOWN'].map((id) =>
        checkOcppCommandVersion(restricted, reset16(id)),
      ),
    );
    const normalized = results.map((r, i) =>
      JSON.stringify(r).replaceAll(['CS-UNSITED', 'CS-FOREIGN', 'CS-UNKNOWN'][i] ?? '', 'X'),
    );
    expect(new Set(normalized).size).toBe(1);
    expect(results[0]).toMatchObject({ ok: false, refusal: { reason: 'station_not_found' } });
    for (const result of results) {
      const body = JSON.stringify(result);
      expect(body).not.toMatch(/ocpp2\.1|OCPP 2\.1|ocppProtocol/);
    }
  });

  it('maps the command for a station in its own site (control)', async () => {
    const result = await checkOcppCommandVersion(restricted, reset16('CS-OWN'));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.entry.tool.name).toBe('ocppv21_reset');
    expect(result.note).toContain('uses OCPP 2.1');
  });
});
