// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  FREE_VEND_OCPP_21_VARIABLES,
  freeVendRestoreKeys16,
  freeVendRestoreVariables21,
  normalizeIccid,
} from '@evtivity/lib';
import {
  DAY_MS,
  DEMO_FEATURE_DAYS,
  FREE_VEND_DEMO,
  PNC_DEMO,
  PNC_DEMO_STATION_IDS,
  PNC_STATION_CONFIGURATION,
  SIM_DEMO,
  SIM_DEMO_STATION_IDS,
  demoRandom,
  demoTransactionId,
  freeVendSessionPlan,
  freeVendTemplates,
  pncContractPlan,
  pncSessionPlan,
  simAlertPlan,
  simSessionPlan,
  simStatusOf,
} from '../seed-demo-features.js';
import { demoStationProtocol } from '../seed-station-defs.js';

const now = new Date('2026-10-26T15:00:00Z');
const ID = /^[a-z]{3}_[0-9a-z]{12}$/;

/** The demo seed index of station CS-<n>. */
function indexOf(stationId: string): number {
  return Number(stationId.slice(3)) - 3;
}

describe('demo station picks', () => {
  it('puts Plug and Charge on OCPP 2.1 SP3 demo stations', () => {
    for (const id of PNC_DEMO_STATION_IDS) {
      const index = indexOf(id);
      expect(demoStationProtocol(index)).toBe('ocpp2.1');
      expect(index).toBeGreaterThanOrEqual(950);
      expect(index).toBeLessThan(1000);
    }
  });

  it('puts the SIMs on OCPP 2.x SP3 demo stations past the active session and PnC ones', () => {
    for (const id of SIM_DEMO_STATION_IDS) {
      const index = indexOf(id);
      expect(demoStationProtocol(index)).not.toBe('ocpp1.6');
      // The first 20 SP3 stations hold the seeded active sessions (950-969).
      expect(index).toBeGreaterThanOrEqual(970);
      expect(index).toBeLessThan(990);
      expect(PNC_DEMO_STATION_IDS as readonly string[]).not.toContain(id);
    }
  });

  it('gives the free vend stations ids outside the 2000 demo stations', () => {
    for (const s of FREE_VEND_DEMO.stations) {
      expect(indexOf(s.stationId)).toBeGreaterThanOrEqual(2000);
      for (const id of [s.id, s.evseDbId, s.connectorDbId, s.cssStationId, s.cssEvseId]) {
        expect(id).toMatch(ID);
      }
    }
    expect(FREE_VEND_DEMO.siteId).toMatch(ID);
  });
});

describe('demoRandom and demoTransactionId', () => {
  it('repeats the same sequence for a seed', () => {
    const a = demoRandom(7);
    const b = demoRandom(7);
    const values = Array.from({ length: 5 }, () => a());
    expect(values).toEqual(Array.from({ length: 5 }, () => b()));
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('sends a UUID on 2.x and an integer on 1.6, apart per group', () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(demoTransactionId('pnc', 3, false)).toMatch(uuid);
    expect(demoTransactionId('freeVend', 3, false)).toMatch(uuid);
    expect(demoTransactionId('pnc', 3, false)).not.toBe(demoTransactionId('freeVend', 3, false));
    expect(demoTransactionId('freeVend', 3, true)).toMatch(/^\d+$/);
    expect(demoTransactionId('pnc', 3, true)).not.toBe(demoTransactionId('freeVend', 3, true));
  });
});

describe('Plug and Charge plan', () => {
  const contracts = pncContractPlan(now);
  const sessions = pncSessionPlan(now, PNC_DEMO_STATION_IDS.length, contracts);

  it('makes eMAID tokens in the local contract format with fixed ids, one revoked', () => {
    expect(contracts).toHaveLength(PNC_DEMO.contractCount);
    for (const c of contracts) {
      expect(c.tokenId).toMatch(ID);
      // CC + PPP + C + 8 characters, as the local contract CA issues them.
      expect(c.emaid).toMatch(/^[A-Z]{2}[A-Z0-9]{3}C[A-Z0-9]{8}$/);
      expect(c.pcid).toMatch(/^[A-Z0-9]+$/);
      expect(c.createdAt.getTime()).toBeLessThan(now.getTime() - DEMO_FEATURE_DAYS * DAY_MS);
    }
    expect(contracts.filter((c) => c.revoked)).toHaveLength(1);
    expect(new Set(contracts.map((c) => c.emaid)).size).toBe(contracts.length);
  });

  it('spreads the sessions over the last 30 days, all ended before the seed', () => {
    expect(sessions).toHaveLength(PNC_DEMO.sessionCount);
    const days = new Set(sessions.map((s) => s.startedAt.toISOString().slice(0, 10)));
    expect(days.size).toBeGreaterThanOrEqual(25);
    for (const s of sessions) {
      expect(s.id).toMatch(ID);
      expect(s.startedAt.getTime()).toBeGreaterThan(
        now.getTime() - (DEMO_FEATURE_DAYS + 1) * DAY_MS,
      );
      expect(s.endedAt.getTime()).toBeLessThan(now.getTime());
      expect(s.endedAt.getTime()).toBeGreaterThan(s.startedAt.getTime());
      expect(s.energyWh).toBeGreaterThanOrEqual(15_000);
      expect(s.costCents).toBeGreaterThan(0);
    }
    expect(new Set(sessions.map((s) => s.stationIndex))).toEqual(new Set([0, 1]));
  });

  it('starts no session with a revoked contract after its revocation', () => {
    for (const s of sessions) {
      const contract = contracts[s.contractIndex];
      if (contract?.revokedAt != null) {
        expect(s.endedAt.getTime()).toBeLessThanOrEqual(contract.revokedAt.getTime());
      }
    }
  });

  it('plans the same sessions on a rerun', () => {
    expect(pncSessionPlan(now, 2, contracts)).toEqual(sessions);
  });

  it('reports Plug and Charge on in the ISO 15118 controller', () => {
    expect(PNC_STATION_CONFIGURATION).toContainEqual({ variable: 'PnCEnabled', value: 'true' });
  });
});

describe('free vend plan', () => {
  it('plans zero cost sessions over the last 30 days on both stations', () => {
    const sessions = freeVendSessionPlan(now, FREE_VEND_DEMO.stations.length);
    expect(sessions).toHaveLength(FREE_VEND_DEMO.sessionCount);
    for (const s of sessions) {
      expect(s.id).toMatch(ID);
      expect(s.costCents).toBe(0);
      expect(s.endedAt.getTime()).toBeLessThan(now.getTime());
      expect(s.startedAt.getTime()).toBeGreaterThan(
        now.getTime() - (DEMO_FEATURE_DAYS + 1) * DAY_MS,
      );
    }
    expect(new Set(sessions.map((s) => s.stationIndex))).toEqual(new Set([0, 1]));
  });

  it('creates the four templates free vend makes, with its values', () => {
    const templates = freeVendTemplates(FREE_VEND_DEMO.siteName);
    expect(templates.map((t) => t.id)).toEqual([
      FREE_VEND_DEMO.template21Id,
      FREE_VEND_DEMO.template16Id,
      FREE_VEND_DEMO.restore21Id,
      FREE_VEND_DEMO.restore16Id,
    ]);
    expect(templates[0]?.variables).toEqual(FREE_VEND_OCPP_21_VARIABLES);
    expect(templates[2]?.variables).toEqual(freeVendRestoreVariables21(null));
    expect(templates[3]?.variables).toEqual(freeVendRestoreKeys16({}));
    expect(templates.map((t) => t.ocppVersion)).toEqual(['2.1', '1.6', '2.1', '1.6']);
    for (const t of templates) expect(t.id).toMatch(ID);
  });
});

describe('SIM plan', () => {
  it('plans increasing session ids outside the reporting delay', () => {
    for (const simNumber of [1, 2, 3, 4]) {
      const sessions = simSessionPlan(now, simNumber);
      expect(sessions.length).toBeGreaterThan(SIM_DEMO.sessionDays * 2);
      const ids = sessions.map((s) => s.providerSessionId);
      expect([...ids].sort()).toEqual(ids);
      expect(new Set(ids).size).toBe(ids.length);
      for (const s of sessions) {
        expect(s.endedAt.getTime()).toBeLessThan(now.getTime() - 6 * 3_600_000);
        expect(s.startedAt.getTime()).toBeGreaterThanOrEqual(
          now.getTime() - SIM_DEMO.sessionDays * DAY_MS,
        );
      }
    }
    // Session ids are unique across SIMs (one provider-wide index).
    const all = [1, 2, 3, 4].flatMap((n) => simSessionPlan(now, n).map((s) => s.providerSessionId));
    expect(new Set(all).size).toBe(all.length);
  });

  it('stores the allow-listed status, the second SIM above the usage warning', () => {
    const status = simStatusOf(now, 2, now);
    expect(status).toMatchObject({ state: 'active', providerState: 'LIVE', apn: 'hologram' });
    expect(status.usage?.limitBytes).not.toBeNull();
    expect((status.usage?.bytes ?? 0) / (status.usage?.limitBytes ?? 1)).toBeGreaterThanOrEqual(
      0.8,
    );
    expect(simStatusOf(now, 1, null).openSessionBeganAt).not.toBeNull();
    expect(simStatusOf(now, 2, null).openSessionBeganAt).toBeNull();
  });

  it('plans alerts of known kinds with unique ids', () => {
    const kinds = new Set([
      'data_limit',
      'data_warning',
      'device_changed',
      'device_model_changed',
      'first_device',
    ]);
    const alerts = [1, 2, 3, 4].flatMap((n) => simAlertPlan(now, n));
    for (const a of alerts) expect(kinds.has(a.kind)).toBe(true);
    expect(new Set(alerts.map((a) => a.providerAlertId)).size).toBe(alerts.length);
  });

  it('keeps the spare and inactive SIMs valid and apart from the station ICCIDs', () => {
    for (const sim of [SIM_DEMO.spare, SIM_DEMO.inactive]) {
      expect(sim.id).toMatch(ID);
      expect(normalizeIccid(sim.iccid)).toBe(sim.iccid);
      // Demo station ICCIDs have 19 digits, so a 20 digit one never matches a station.
      expect(sim.iccid).toHaveLength(20);
      expect(sim.imsi).toMatch(/^\d{15}$/);
    }
  });
});
