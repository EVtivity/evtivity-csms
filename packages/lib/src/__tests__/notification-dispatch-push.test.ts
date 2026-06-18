// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn(() => ({ sendMail: vi.fn().mockResolvedValue({}) })) },
}));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn().mockRejectedValue(new Error('ENOENT')) }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const TOKEN_A = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const TOKEN_DEAD = 'ExponentPushToken[deaddeaddeaddeaddeaddd]';

// Content-aware sql mock: returns rows based on the query text rather than call
// order, so the native-push SELECT/DELETE/UPDATE are deterministic regardless
// of how many settings/template queries run before them.
interface SqlCall {
  text: string;
  values: unknown[];
}
const calls: SqlCall[] = [];
let pushTokens: string[] = [];

function createSqlMock() {
  const sqlFn = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.join('?');
    calls.push({ text, values });
    if (text.includes('driver_event_settings')) return Promise.resolve([{ is_enabled: true }]);
    if (text.includes('FROM drivers WHERE id')) {
      return Promise.resolve([
        {
          first_name: 'Mo',
          last_name: 'Bile',
          email: null,
          phone: null,
          language: 'en',
          timezone: 'UTC',
        },
      ]);
    }
    if (text.includes('driver_notification_preferences')) {
      return Promise.resolve([{ email_enabled: false, sms_enabled: false, push_enabled: true }]);
    }
    if (text.includes('SELECT token FROM driver_push_tokens')) {
      return Promise.resolve(pushTokens.map((t) => ({ token: t })));
    }
    return Promise.resolve([]);
  };
  sqlFn.json = (value: unknown) => value;
  return sqlFn as unknown;
}

function callsMatching(fragment: string): SqlCall[] {
  return calls.filter((c) => c.text.includes(fragment));
}

describe('dispatchDriverNotification native push', () => {
  let sql: ReturnType<typeof createSqlMock>;

  beforeEach(() => {
    calls.length = 0;
    pushTokens = [];
    vi.clearAllMocks();
    delete process.env['SETTINGS_ENCRYPTION_KEY'];
    sql = createSqlMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends an Expo push to each registered token and stamps last_used_at', async () => {
    pushTokens = [TOKEN_A];
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ status: 'ok', id: 'r1' }] }),
      text: async () => '',
    });
    const { dispatchDriverNotification } = await import('../notification-dispatch.js');

    await dispatchDriverNotification(sql as never, 'session.Started', 'driver-1', {});

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]?.[0]).toContain('exp.host');
    const sent = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string) as Array<{ to: string }>;
    expect(sent[0]?.to).toBe(TOKEN_A);
    expect(callsMatching('UPDATE driver_push_tokens')).toHaveLength(1);
    expect(callsMatching('DELETE FROM driver_push_tokens')).toHaveLength(0);
  });

  it('prunes a token Expo reports as DeviceNotRegistered', async () => {
    pushTokens = [TOKEN_DEAD];
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }],
      }),
      text: async () => '',
    });
    const { dispatchDriverNotification } = await import('../notification-dispatch.js');

    await dispatchDriverNotification(sql as never, 'session.Started', 'driver-2', {});

    const del = callsMatching('DELETE FROM driver_push_tokens');
    expect(del).toHaveLength(1);
    expect(del[0]?.values[0]).toEqual([TOKEN_DEAD]);
    expect(callsMatching('UPDATE driver_push_tokens')).toHaveLength(0);
  });

  it('does not send native push when no tokens are registered', async () => {
    pushTokens = [];
    const { dispatchDriverNotification } = await import('../notification-dispatch.js');

    await dispatchDriverNotification(sql as never, 'session.Started', 'driver-3', {});

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips native push when push_enabled is false', async () => {
    pushTokens = [TOKEN_A];
    const sqlOff = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      calls.push({ text, values });
      if (text.includes('driver_event_settings')) return Promise.resolve([{ is_enabled: true }]);
      if (text.includes('FROM drivers WHERE id')) {
        return Promise.resolve([
          { first_name: 'Mo', last_name: 'B', email: null, phone: null, language: 'en' },
        ]);
      }
      if (text.includes('driver_notification_preferences')) {
        return Promise.resolve([{ email_enabled: false, sms_enabled: false, push_enabled: false }]);
      }
      return Promise.resolve([]);
    }) as unknown as { json: (v: unknown) => unknown };
    sqlOff.json = (v) => v;

    const { dispatchDriverNotification } = await import('../notification-dispatch.js');
    await dispatchDriverNotification(sqlOff as never, 'session.Started', 'driver-4', {});

    expect(mockFetch).not.toHaveBeenCalled();
    expect(callsMatching('SELECT token FROM driver_push_tokens')).toHaveLength(0);
  });
});
