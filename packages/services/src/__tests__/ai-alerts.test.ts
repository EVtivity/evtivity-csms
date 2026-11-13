// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// AI alerts: the provider quota alert (set, clear, daily notification claim,
// background gate) and the budget notices.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiProviderError } from '@evtivity/ai/core';
import type { AiAdapter, AiRequest, AiStreamEvent } from '@evtivity/ai/core';

const db = vi.hoisted(() => ({
  recordAiProviderQuotaFailure: vi.fn(),
  claimAiProviderAlertNotice: vi.fn(),
  claimAiProviderProbe: vi.fn(),
  clearAiProviderAlert: vi.fn(),
  getActiveAiProviderAlerts: vi.fn(),
  getSystemTimezone: vi.fn(),
  /** Rows the `client` tagged template answers, in call order. */
  rows: [] as (unknown[] | Error)[],
  queries: [] as string[],
}));
const lib = vi.hoisted(() => ({
  dispatchSystemNotification: vi.fn(),
  publish: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  client: (strings: TemplateStringsArray) => {
    db.queries.push(strings.join('?'));
    const next = db.rows.shift();
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? []);
  },
  recordAiProviderQuotaFailure: db.recordAiProviderQuotaFailure,
  claimAiProviderAlertNotice: db.claimAiProviderAlertNotice,
  claimAiProviderProbe: db.claimAiProviderProbe,
  clearAiProviderAlert: db.clearAiProviderAlert,
  getActiveAiProviderAlerts: db.getActiveAiProviderAlerts,
  getSystemTimezone: db.getSystemTimezone,
}));
vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  dispatchSystemNotification: lib.dispatchSystemNotification,
}));
vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({ publish: lib.publish }),
}));

import {
  AI_BUDGET_EXHAUSTED_EVENT,
  AI_BUDGET_WARNING_EVENT,
  AI_PROVIDER_QUOTA_EXCEEDED_EVENT,
  aiProviderGate,
  dispatchAiBudgetNotices,
  noteAiProviderQuotaExceeded,
  noteAiProviderSuccess,
  trackAiProviderCalls,
} from '../ai-alerts.js';

const ADMIN = {
  id: 'usr_1',
  email: 'admin@example.com',
  phone: '+15550100',
  first_name: 'Ada',
  last_name: 'Admin',
  language: 'de',
  timezone: 'Europe/Berlin',
};
const SINCE = new Date('2026-10-15T08:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  db.rows = [];
  db.queries = [];
  db.getSystemTimezone.mockResolvedValue('UTC');
  db.getActiveAiProviderAlerts.mockResolvedValue([]);
  lib.dispatchSystemNotification.mockResolvedValue({ delivered: [{ channel: 'email' }] });
  lib.publish.mockResolvedValue(undefined);
});

function published(): unknown[] {
  return lib.publish.mock.calls.map((c) => JSON.parse(c[1] as string) as unknown);
}

describe('noteAiProviderQuotaExceeded', () => {
  it('records a new alert, announces it and notifies the AI administrators once that day', async () => {
    db.recordAiProviderQuotaFailure.mockResolvedValue({ started: true, since: SINCE });
    db.claimAiProviderAlertNotice.mockResolvedValue(true);
    db.rows = [[ADMIN]];
    await noteAiProviderQuotaExceeded('deepseek', new Date('2026-10-15T09:00:00Z'));
    expect(published()).toEqual([{ eventType: 'ai.alerts.changed' }]);
    expect(db.claimAiProviderAlertNotice).toHaveBeenCalledWith('deepseek', '2026-10-15');
    // Active users with the permission and access to every site.
    expect(db.queries[0]).toContain('user_permissions');
    expect(db.queries[0]).toContain('has_all_site_access');
    expect(lib.dispatchSystemNotification).toHaveBeenCalledWith(
      expect.anything(),
      AI_PROVIDER_QUOTA_EXCEEDED_EVENT,
      expect.objectContaining({ email: 'admin@example.com', language: 'de', userId: 'usr_1' }),
      expect.objectContaining({
        provider: 'deepseek',
        providerName: 'DeepSeek',
        since: SINCE.toISOString(),
        firstName: 'Ada',
      }),
      expect.any(Array),
    );
  });

  it('sends nothing when the day is already claimed (P7), and announces only a new alert', async () => {
    db.recordAiProviderQuotaFailure.mockResolvedValue({ started: false, since: SINCE });
    db.claimAiProviderAlertNotice.mockResolvedValue(false);
    await noteAiProviderQuotaExceeded('openai');
    expect(lib.publish).not.toHaveBeenCalled();
    expect(lib.dispatchSystemNotification).not.toHaveBeenCalled();
  });

  it('is fail-open: a database error is logged, never thrown', async () => {
    db.recordAiProviderQuotaFailure.mockRejectedValue(new Error('db down'));
    await expect(noteAiProviderQuotaExceeded('gemini')).resolves.toBeUndefined();
  });

  it('keeps notifying the other recipients when one dispatch fails', async () => {
    db.recordAiProviderQuotaFailure.mockResolvedValue({ started: true, since: SINCE });
    db.claimAiProviderAlertNotice.mockResolvedValue(true);
    db.rows = [[ADMIN, { ...ADMIN, id: 'usr_2', email: 'second@example.com' }]];
    lib.dispatchSystemNotification.mockRejectedValueOnce(new Error('smtp'));
    await noteAiProviderQuotaExceeded('anthropic');
    expect(lib.dispatchSystemNotification).toHaveBeenCalledTimes(2);
  });
});

describe('noteAiProviderSuccess', () => {
  it('writes nothing while the provider has no alert', async () => {
    await noteAiProviderSuccess('deepseek');
    expect(db.clearAiProviderAlert).not.toHaveBeenCalled();
    expect(lib.publish).not.toHaveBeenCalled();
  });

  it('clears an active alert and announces it', async () => {
    db.getActiveAiProviderAlerts.mockResolvedValue([
      { provider: 'deepseek', since: SINCE, lastSeenAt: SINCE },
    ]);
    db.clearAiProviderAlert.mockResolvedValue(true);
    await noteAiProviderSuccess('deepseek');
    expect(db.clearAiProviderAlert).toHaveBeenCalledWith('deepseek');
    expect(published()).toEqual([{ eventType: 'ai.alerts.changed' }]);
  });
});

describe('alert edge cases (fail-open)', () => {
  it('keeps going when the alert change cannot be published', async () => {
    db.recordAiProviderQuotaFailure.mockResolvedValue({ started: true, since: SINCE });
    db.claimAiProviderAlertNotice.mockResolvedValue(true);
    db.rows = [
      [
        {
          ...ADMIN,
          phone: null,
          first_name: null,
          last_name: null,
          language: null,
          timezone: null,
        },
      ],
    ];
    lib.publish.mockRejectedValue(new Error('redis down'));
    await noteAiProviderQuotaExceeded('deepseek', new Date('2026-10-15T09:00:00Z'));
    expect(lib.dispatchSystemNotification).toHaveBeenCalledTimes(1);
    const [, , recipient, vars] = lib.dispatchSystemNotification.mock.calls[0] as unknown[];
    expect(recipient).toMatchObject({
      phone: undefined,
      firstName: undefined,
      language: undefined,
    });
    expect(vars).toMatchObject({ firstName: '', lastName: '' });
  });

  it('does not announce a clear another process already made', async () => {
    db.getActiveAiProviderAlerts.mockResolvedValue([
      { provider: 'deepseek', since: SINCE, lastSeenAt: SINCE },
    ]);
    db.clearAiProviderAlert.mockResolvedValue(false);
    await noteAiProviderSuccess('deepseek');
    expect(lib.publish).not.toHaveBeenCalled();
  });

  it('never throws when the alert state cannot be read on success', async () => {
    db.getActiveAiProviderAlerts.mockRejectedValue(new Error('db down'));
    await expect(noteAiProviderSuccess('deepseek')).resolves.toBeUndefined();
    expect(db.clearAiProviderAlert).not.toHaveBeenCalled();
  });

  it('logs a budget notice whose site read fails and sends the next one', async () => {
    db.rows = [new Error('db down'), [ADMIN]];
    await dispatchAiBudgetNotices([
      {
        scope: 'site',
        siteId: 'sit_1',
        period: '2026-10',
        level: 'warn',
        percent: 80,
        usedTokens: 8,
        limitTokens: 10,
      },
      {
        scope: 'company',
        siteId: null,
        period: '2026-10',
        level: 'warn',
        percent: 80,
        usedTokens: 8,
        limitTokens: 10,
      },
    ]);
    expect(lib.dispatchSystemNotification).toHaveBeenCalledTimes(1);
    expect(lib.dispatchSystemNotification.mock.calls[0]?.[3]).toMatchObject({ scope: 'company' });
  });

  it('names no site when the site is gone', async () => {
    db.rows = [[], [ADMIN]];
    await dispatchAiBudgetNotices([
      {
        scope: 'site',
        siteId: 'sit_x',
        period: '2026-10',
        level: 'exceeded',
        percent: 100,
        usedTokens: 1,
        limitTokens: 1,
      },
    ]);
    expect(lib.dispatchSystemNotification.mock.calls[0]?.[3]).toMatchObject({ siteName: '' });
  });
});

describe('aiProviderGate', () => {
  it('is open without an alert, probe for the claimed probe, paused otherwise', async () => {
    expect(await aiProviderGate('deepseek')).toBe('open');
    db.getActiveAiProviderAlerts.mockResolvedValue([
      { provider: 'deepseek', since: SINCE, lastSeenAt: SINCE },
    ]);
    db.claimAiProviderProbe.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await aiProviderGate('deepseek')).toBe('probe');
    expect(await aiProviderGate('deepseek')).toBe('paused');
    expect(await aiProviderGate('openai')).toBe('open');
  });

  it('answers open when the alert state cannot be read (fail-open)', async () => {
    db.getActiveAiProviderAlerts.mockRejectedValue(new Error('db down'));
    expect(await aiProviderGate('deepseek')).toBe('open');
  });
});

describe('trackAiProviderCalls', () => {
  const REQ: AiRequest = {
    model: 'm',
    system: [],
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }],
    tools: [],
    effort: 'low',
  };
  function failing(code: 'quota_exceeded' | 'rate_limited'): AiAdapter {
    const adapter: AiAdapter = {
      provider: 'deepseek',
      capabilities: () => ({}) as ReturnType<AiAdapter['capabilities']>,
      // eslint-disable-next-line require-yield
      async *stream(): AsyncIterable<AiStreamEvent> {
        throw new AiProviderError({ code, provider: 'deepseek', message: 'refused' });
      },
      complete: () => Promise.reject(new Error('unused')),
    };
    return adapter;
  }

  it('records a quota_exceeded failure and rethrows it', async () => {
    db.recordAiProviderQuotaFailure.mockResolvedValue({ started: true, since: SINCE });
    db.claimAiProviderAlertNotice.mockResolvedValue(false);
    await expect(
      trackAiProviderCalls(failing('quota_exceeded')).complete(REQ, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'quota_exceeded' });
    await vi.waitFor(() => {
      expect(db.recordAiProviderQuotaFailure).toHaveBeenCalledWith('deepseek', expect.any(Date));
    });
  });

  it('clears the provider alert state after a completed call', async () => {
    const ok: AiAdapter = {
      provider: 'deepseek',
      capabilities: () => ({}) as ReturnType<AiAdapter['capabilities']>,
      async *stream(): AsyncIterable<AiStreamEvent> {
        yield { type: 'text_delta', text: 'hi' };
        yield { type: 'finish', reason: 'end' };
      },
      complete: () => Promise.reject(new Error('unused')),
    };
    db.getActiveAiProviderAlerts.mockResolvedValue([
      { provider: 'deepseek', since: SINCE, lastSeenAt: SINCE },
    ]);
    db.clearAiProviderAlert.mockResolvedValue(true);
    const wrapped = trackAiProviderCalls(ok);
    const events: AiStreamEvent[] = [];
    for await (const event of wrapped.stream(REQ, new AbortController().signal)) events.push(event);
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'finish']);
    await vi.waitFor(() => {
      expect(db.clearAiProviderAlert).toHaveBeenCalledWith('deepseek');
    });
  });

  it('leaves a rate limit alone: it recovers by waiting', async () => {
    await expect(
      trackAiProviderCalls(failing('rate_limited')).complete(REQ, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'rate_limited' });
    expect(db.recordAiProviderQuotaFailure).not.toHaveBeenCalled();
  });
});

describe('dispatchAiBudgetNotices', () => {
  it('sends ai.BudgetWarning for a company warn and ai.BudgetExhausted with the site name', async () => {
    db.rows = [[ADMIN], [{ name: 'Harbor Garage' }], [ADMIN]];
    await dispatchAiBudgetNotices([
      {
        scope: 'company',
        siteId: null,
        period: '2026-10',
        level: 'warn',
        percent: 80,
        usedTokens: 800,
        limitTokens: 1000,
      },
      {
        scope: 'site',
        siteId: 'sit_1',
        period: '2026-10',
        level: 'exceeded',
        percent: 100,
        usedTokens: 500,
        limitTokens: 500,
      },
    ]);
    const calls = lib.dispatchSystemNotification.mock.calls;
    expect(calls.map((c) => c[1])).toEqual([AI_BUDGET_WARNING_EVENT, AI_BUDGET_EXHAUSTED_EVENT]);
    expect(calls[0]?.[3]).toMatchObject({ scope: 'company', siteName: '', percent: 80 });
    expect(calls[1]?.[3]).toMatchObject({
      scope: 'site',
      siteName: 'Harbor Garage',
      usedTokens: 500,
      limitTokens: 500,
    });
  });

  it('sends nothing for no notices', async () => {
    await dispatchAiBudgetNotices([]);
    expect(lib.dispatchSystemNotification).not.toHaveBeenCalled();
  });
});
