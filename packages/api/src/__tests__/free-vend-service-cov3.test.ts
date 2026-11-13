// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The free vend switch: turning it on creates the free vend templates and
// the restore templates from the values the stations report, turning it off
// pushes the restore templates (created with the defaults when missing), and
// each switch audits the site, clears the cache, tells OCPI partners only on
// a real change and pushes each template to the site's stations.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import {
  FREE_VEND_OCPP_21_VARIABLES,
  freeVendRestoreKeys16,
  freeVendRestoreVariables21,
} from '@evtivity/lib';

const q = vi.hoisted(() => ({
  selects: [] as unknown[],
  returns: [] as unknown[],
  inserts: [] as unknown[],
  sets: [] as unknown[],
  writeAudit: vi.fn(),
  clearFreeVendCache: vi.fn(),
  push: vi.fn(),
  ocpi: vi.fn(),
}));

function chain(): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  for (const method of ['from', 'innerJoin', 'where', 'for', 'groupBy', 'orderBy', 'limit']) {
    b[method] = () => b;
  }
  b['then'] = (res: (v: unknown) => unknown) => Promise.resolve(q.selects.shift() ?? []).then(res);
  return b;
}

vi.mock('@evtivity/database', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const tx = {
    select: () => chain(),
    insert: () => ({
      values: (v: unknown) => {
        q.inserts.push(v);
        return { returning: () => Promise.resolve(q.returns.shift() ?? []) };
      },
    }),
    update: () => ({
      set: (s: unknown) => {
        q.sets.push(s);
        return { where: () => ({ returning: () => Promise.resolve(q.returns.shift() ?? []) }) };
      },
    }),
  };
  return {
    ...actual,
    db: { transaction: (fn: (t: unknown) => unknown) => fn(tx) },
    writeAudit: q.writeAudit,
    clearFreeVendCache: q.clearFreeVendCache,
  };
});
vi.mock('../lib/config-push.js', () => ({ pushTemplateToSiteStations: q.push }));
vi.mock('../lib/ocpi-location-push.js', () => ({ publishOcpiLocationPush: q.ocpi }));

import { setSiteFreeVend } from '../services/free-vend.service.js';

const log = pino({ level: 'silent' });
const actor = {
  actor: 'operator' as const,
  actorUserId: 'usr_1',
  actorDriverId: null,
  actorApiKeyId: null,
  actorLabel: null,
};

type Site = Parameters<typeof setSiteFreeVend>[0];

function site(overrides: Record<string, unknown> = {}): Site {
  return {
    id: 'sit_1',
    name: 'Depot',
    freeVendEnabled: false,
    freeVendTemplateId21: null,
    freeVendTemplateId16: null,
    freeVendRestoreTemplateId21: null,
    freeVendRestoreTemplateId16: null,
    ...overrides,
  } as unknown as Site;
}

const notes = () => q.writeAudit.mock.calls.map((c) => (c[1] as { notes: string }).notes);

beforeEach(() => {
  q.selects.length = 0;
  q.returns.length = 0;
  q.inserts.length = 0;
  q.sets.length = 0;
  q.push.mockReset().mockImplementation((id: string) => Promise.resolve(`push-${id}`));
});

describe('setSiteFreeVend on', () => {
  it('creates the free vend and restore templates from the reported values', async () => {
    const current = site();
    q.selects.push(
      [current],
      [{ value: 'false', n: 3 }], // 1.6 LocalPreAuthorize
      [], // 1.6 LocalAuthorizeOffline not reported
      [{ value: 'EVConnected', n: 2 }], // 2.1 TxStartPoint
    );
    q.returns.push(
      [{ id: 'ctm_free21' }],
      [{ id: 'ctm_free16' }],
      [{ id: 'ctm_rest21' }],
      [{ id: 'ctm_rest16' }],
      [{ ...current, freeVendEnabled: true }],
    );
    const result = await setSiteFreeVend(current, true, actor, log);
    expect(result).toEqual({ pushId21: 'push-ctm_free21', pushId16: 'push-ctm_free16' });
    expect(q.inserts).toHaveLength(4);
    expect(q.inserts[0]).toMatchObject({
      name: 'Free Vend - Depot (OCPP 2.1)',
      ocppVersion: '2.1',
      variables: FREE_VEND_OCPP_21_VARIABLES,
      targetFilter: { siteId: 'sit_1' },
    });
    expect(q.inserts[1]).toMatchObject({
      name: 'Free Vend - Depot (OCPP 1.6)',
      ocppVersion: '1.6',
    });
    expect(q.inserts[2]).toMatchObject({
      name: 'Free Vend Off - Depot (OCPP 2.1)',
      variables: freeVendRestoreVariables21('EVConnected'),
    });
    expect(q.inserts[3]).toMatchObject({
      name: 'Free Vend Off - Depot (OCPP 1.6)',
      variables: freeVendRestoreKeys16({ LocalPreAuthorize: 'false', LocalAuthorizeOffline: null }),
    });
    expect(q.sets[0]).toMatchObject({
      freeVendEnabled: true,
      freeVendTemplateId21: 'ctm_free21',
      freeVendTemplateId16: 'ctm_free16',
      freeVendRestoreTemplateId21: 'ctm_rest21',
      freeVendRestoreTemplateId16: 'ctm_rest16',
    });
    expect(notes()).toEqual([
      'auto-created for free-vend on site sit_1',
      'auto-created for free-vend on site sit_1',
      'auto-created for free-vend on site sit_1',
      'auto-created for free-vend on site sit_1',
      'free-vend enabled',
    ]);
    expect(q.clearFreeVendCache).toHaveBeenCalled();
    expect(q.ocpi).toHaveBeenCalledWith('sit_1', null, log);
    expect(q.push).toHaveBeenCalledWith('ctm_free21', 'sit_1');
    expect(q.push).toHaveBeenCalledWith('ctm_free16', 'sit_1');
  });

  it('keeps existing templates and replaces the restore values that changed', async () => {
    const current = site({
      freeVendTemplateId21: 'ctm_free21',
      freeVendTemplateId16: 'ctm_free16',
      freeVendRestoreTemplateId21: 'ctm_rest21',
      freeVendRestoreTemplateId16: 'ctm_rest16',
    });
    const same16 = freeVendRestoreKeys16({});
    q.selects.push(
      [current],
      [{ id: 'ctm_free21', variables: [] }],
      [{ id: 'ctm_free16', variables: [] }],
      [],
      [],
      [],
      [{ id: 'ctm_rest21', variables: [{ component: 'old' }] }],
      [{ id: 'ctm_rest16', variables: same16 }],
    );
    q.returns.push([], [current]);
    const result = await setSiteFreeVend(current, true, actor, log);
    expect(result.pushId21).toBe('push-ctm_free21');
    expect(q.inserts).toHaveLength(0);
    // Only the 2.1 restore template changed; its update returned no row, so the audit keeps the read one.
    expect(q.sets[0]).toEqual({
      variables: freeVendRestoreVariables21(null),
      updatedAt: expect.any(Date),
    });
    expect(q.writeAudit.mock.calls[0]?.[1]).toMatchObject({
      entityId: 'ctm_rest21',
      action: 'updated',
      after: { id: 'ctm_rest21', variables: [{ component: 'old' }] },
      notes: 'restore values captured for free-vend on site sit_1',
    });
    expect(notes()).toHaveLength(2);
  });

  it('keeps the stored restore values while free vend is already on, no OCPI push', async () => {
    const current = site({
      freeVendEnabled: true,
      freeVendTemplateId21: 'ctm_gone',
      freeVendTemplateId16: 'ctm_free16',
    });
    q.selects.push([current], [], [{ id: 'ctm_free16', variables: [] }]);
    q.returns.push([{ id: 'ctm_new21' }], []);
    await setSiteFreeVend(current, true, actor, log);
    // A stored id whose template was deleted gets a new one.
    expect(q.inserts).toHaveLength(1);
    expect(q.sets[0]).toMatchObject({ freeVendTemplateId21: 'ctm_new21' });
    expect(q.sets[0]).not.toHaveProperty('freeVendRestoreTemplateId21');
    expect(q.writeAudit.mock.calls.at(-1)?.[1]).toMatchObject({
      after: current,
      notes: 'free-vend enabled',
    });
    expect(q.ocpi).not.toHaveBeenCalled();
  });

  it('uses the passed site when the lock read returns none, and pushes nothing for a failed insert', async () => {
    const current = site({ freeVendEnabled: true });
    q.selects.push([]);
    q.returns.push([], [], []);
    const result = await setSiteFreeVend(current, true, actor, log);
    expect(result).toEqual({ pushId21: '', pushId16: '' });
    expect(q.push).not.toHaveBeenCalled();
    expect(q.sets[0]).toMatchObject({ freeVendTemplateId21: null, freeVendTemplateId16: null });
  });
});

describe('setSiteFreeVend off', () => {
  it('pushes the restore templates, creating them with the defaults when missing', async () => {
    const current = site({ freeVendEnabled: true, freeVendRestoreTemplateId16: 'ctm_rest16' });
    q.selects.push([current], [{ id: 'ctm_rest16', variables: [{ component: 'x' }] }]);
    q.returns.push([{ id: 'ctm_rest21' }], [{ ...current, freeVendEnabled: false }]);
    const result = await setSiteFreeVend(current, false, actor, log);
    expect(result).toEqual({ pushId21: 'push-ctm_rest21', pushId16: 'push-ctm_rest16' });
    expect(q.inserts[0]).toMatchObject({
      name: 'Free Vend Off - Depot (OCPP 2.1)',
      variables: freeVendRestoreVariables21(null),
    });
    // The existing 1.6 template is not rewritten when turning off.
    expect(q.sets).toHaveLength(1);
    expect(q.sets[0]).toMatchObject({
      freeVendEnabled: false,
      freeVendRestoreTemplateId21: 'ctm_rest21',
      freeVendRestoreTemplateId16: 'ctm_rest16',
    });
    expect(notes().at(-1)).toBe('free-vend disabled');
    expect(q.ocpi).toHaveBeenCalledTimes(1);
  });
});
