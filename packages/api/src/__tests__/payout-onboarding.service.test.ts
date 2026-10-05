// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';

const { state, dispatchMock, writeAuditMock, findSitePayoutAccountMock } = vi.hoisted(() => ({
  state: {
    selectResults: [] as unknown[][],
    returningResults: [] as unknown[][],
    updates: [] as Record<string, unknown>[],
    inserts: [] as Record<string, unknown>[],
    order: [] as string[],
  },
  dispatchMock: vi.fn(() => Promise.resolve(undefined)),
  writeAuditMock: vi.fn(() => Promise.resolve(undefined)),
  findSitePayoutAccountMock: vi.fn(),
}));

vi.mock('../lib/config.js', () => ({ config: { PORTAL_URL: 'https://portal.test' } }));
vi.mock('@evtivity/services/template-dirs', () => ({ ALL_TEMPLATES_DIRS: ['templates'] }));
vi.mock('@evtivity/lib', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, dispatchSystemNotification: dispatchMock };
});
vi.mock('@evtivity/payments', () => ({ findSitePayoutAccount: findSitePayoutAccountMock }));

vi.mock('@evtivity/database', () => {
  const selectChain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'orderBy', 'limit']) selectChain[m] = () => selectChain;
  selectChain['then'] = (resolve: (v: unknown) => void) => {
    resolve(state.selectResults.shift() ?? []);
  };
  const updateChain = {
    set: (v: Record<string, unknown>) => {
      state.updates.push(v);
      state.order.push('update');
      return updateChain;
    },
    where: () => ({
      returning: () => Promise.resolve(state.returningResults.shift() ?? []),
      then: (resolve: (v: unknown) => void) => {
        resolve(undefined);
      },
    }),
  };
  const db = {
    select: () => selectChain,
    update: () => updateChain,
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        state.inserts.push(v);
        state.order.push('insert');
        return Promise.resolve(undefined);
      },
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  return {
    db,
    client: {},
    sites: {},
    sitePayoutInvites: {},
    siteAuditLog: {},
    writeAudit: writeAuditMock,
  };
});

import {
  createPayoutInvite,
  openPayoutInvite,
  payoutOnboardingReturnUrl,
  payoutOnboardingUrl,
  resolvePayoutInvite,
  revokePayoutInvites,
} from '../services/payout-onboarding.service.js';

const ctx = {
  actor: {
    actor: 'operator' as const,
    actorUserId: 'usr_1',
    actorDriverId: null,
    actorApiKeyId: null,
    actorLabel: null,
  },
  log: { warn: vi.fn() },
};

const site = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'sit_1',
  name: 'Main Street',
  contactName: 'Pat Host',
  contactEmail: 'host@example.com',
  ...overrides,
});

function tokenOf(url: string): string {
  return new URL(url).searchParams.get('token') ?? '';
}

beforeEach(() => {
  state.selectResults.length = 0;
  state.returningResults.length = 0;
  state.updates.length = 0;
  state.inserts.length = 0;
  state.order.length = 0;
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue(undefined);
  writeAuditMock.mockClear();
  findSitePayoutAccountMock.mockReset();
  findSitePayoutAccountMock.mockResolvedValue({ accountId: 'acct_1', status: 'onboarding' });
  ctx.log.warn.mockClear();
});

describe('createPayoutInvite', () => {
  it('rejects an unknown site with SITE_NOT_FOUND', async () => {
    state.selectResults.push([]);
    await expect(createPayoutInvite('sit_x', { send: 'none' }, ctx)).rejects.toMatchObject({
      statusCode: 404,
      code: 'SITE_NOT_FOUND',
    });
  });

  it('requires a payout account (PAYOUT_ACCOUNT_NOT_READY)', async () => {
    state.selectResults.push([site()]);
    findSitePayoutAccountMock.mockResolvedValue({ accountId: null, status: null });
    await expect(createPayoutInvite('sit_1', { send: 'none' }, ctx)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PAYOUT_ACCOUNT_NOT_READY',
    });
    expect(state.inserts).toHaveLength(0);
  });

  it('requires a site contact email to send the link', async () => {
    state.selectResults.push([site({ contactEmail: null })]);
    await expect(createPayoutInvite('sit_1', { send: 'email' }, ctx)).rejects.toMatchObject({
      statusCode: 400,
      code: 'EMAIL_REQUIRED',
    });
    expect(state.inserts).toHaveLength(0);
  });

  it('creates a 7-day link, revoking older links, and stores only the hash', async () => {
    state.selectResults.push([site()]);
    const before = Date.now();

    const invite = await createPayoutInvite('sit_1', { send: 'none' }, ctx);

    expect(invite.url).toMatch(/^https:\/\/portal\.test\/payout-onboarding\?token=[0-9a-f]{64}$/);
    expect(invite.sentTo).toBeNull();
    const days = (invite.expiresAt.getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThan(7.01);
    // Revoke the open links, then insert the new one.
    expect(state.order).toEqual(['update', 'insert']);
    expect(state.updates[0]).toHaveProperty('revokedAt');
    const token = tokenOf(invite.url);
    expect(state.inserts[0]).toEqual({
      siteId: 'sit_1',
      tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      sentTo: null,
      createdByUserId: 'usr_1',
      expiresAt: invite.expiresAt,
    });
    expect(JSON.stringify(state.inserts)).not.toContain(token);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(writeAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        entityId: 'sit_1',
        action: 'payment_config_changed',
        actor: 'operator',
        after: { payoutOnboardingInvite: { expiresAt: invite.expiresAt, sentTo: null } },
        notes: 'Payout onboarding link created',
      }),
      expect.anything(),
      ctx.log,
    );
  });

  it('emails the link to the site contact', async () => {
    state.selectResults.push([site()]);

    const invite = await createPayoutInvite('sit_1', { send: 'email' }, ctx);

    expect(invite.sentTo).toBe('host@example.com');
    expect(state.inserts[0]).toMatchObject({ sentTo: 'host@example.com' });
    expect(dispatchMock).toHaveBeenCalledWith(
      {},
      'site.PayoutOnboarding',
      { email: 'host@example.com', firstName: 'Pat Host' },
      {
        siteName: 'Main Street',
        contactName: 'Pat Host',
        onboardingUrl: invite.url,
        expiresInDays: 7,
      },
      ['templates'],
    );
  });

  it('still returns the link when the email fails (fail open)', async () => {
    state.selectResults.push([site()]);
    dispatchMock.mockRejectedValue(new Error('smtp down'));

    const invite = await createPayoutInvite('sit_1', { send: 'email' }, ctx);

    expect(invite.sentTo).toBe('host@example.com');
    expect(ctx.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 'sit_1' }),
      'Payout onboarding email failed',
    );
  });
});

describe('resolvePayoutInvite', () => {
  it('returns the site of an open link and marks it used', async () => {
    state.returningResults.push([{ siteId: 'sit_1' }]);
    expect(await resolvePayoutInvite('tok')).toEqual({ siteId: 'sit_1' });
    expect(state.updates[0]).toHaveProperty('lastUsedAt');
  });

  it('rejects an unknown, revoked or expired link with INVALID_TOKEN', async () => {
    state.returningResults.push([]);
    await expect(resolvePayoutInvite('tok')).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_TOKEN',
    });
  });
});

describe('revokePayoutInvites and openPayoutInvite', () => {
  it('revokes the open links of a site', async () => {
    state.returningResults.push([{ id: 1 }, { id: 2 }]);
    expect(await revokePayoutInvites('sit_1')).toBe(2);
  });

  it('returns the newest open link without the token', async () => {
    const expiresAt = new Date('2026-10-10T00:00:00Z');
    state.selectResults.push([{ expiresAt, sentTo: 'host@example.com', lastUsedAt: null }]);
    expect(await openPayoutInvite('sit_1')).toEqual({
      expiresAt,
      sentTo: 'host@example.com',
      lastUsedAt: null,
    });
    state.selectResults.push([]);
    expect(await openPayoutInvite('sit_1')).toBeNull();
  });
});

describe('onboarding URLs', () => {
  it('builds the page and return URLs on the portal', () => {
    expect(payoutOnboardingUrl('abc')).toBe('https://portal.test/payout-onboarding?token=abc');
    expect(payoutOnboardingReturnUrl('abc')).toBe(
      'https://portal.test/payout-onboarding/return?token=abc',
    );
  });
});
