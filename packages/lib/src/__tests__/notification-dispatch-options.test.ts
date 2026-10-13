// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// The options of dispatchDriverNotification (attachments, sms: false) and the
// always-on member invoice events.

const mockSendMail = vi.fn().mockResolvedValue({});
vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn(() => ({ sendMail: mockSendMail })) },
}));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn().mockRejectedValue(new Error('ENOENT')) }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const PUSH_TOKEN = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';

interface SqlCall {
  text: string;
  values: unknown[];
}
const calls: SqlCall[] = [];

// Content-aware: every channel off in the stored settings and preferences, so
// a delivery shows that a required event ignores them.
function createSqlMock() {
  const sqlFn = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.join('?');
    calls.push({ text, values });
    if (text.includes('driver_event_settings')) return Promise.resolve([{ is_enabled: false }]);
    if (text.includes('FROM drivers WHERE id')) {
      return Promise.resolve([
        {
          first_name: 'Mia',
          last_name: 'Member',
          email: 'mia@example.com',
          phone: '+4915112345678',
          language: 'en',
          timezone: 'UTC',
        },
      ]);
    }
    if (text.includes('driver_notification_preferences')) {
      return Promise.resolve([{ email_enabled: false, sms_enabled: false, push_enabled: false }]);
    }
    if (text.includes("LIKE 'smtp.%'")) {
      return Promise.resolve([
        { key: 'smtp.host', value: 'mail.example.com' },
        { key: 'smtp.from', value: 'billing@example.com' },
        { key: 'twilio.accountSid', value: 'AC123' },
        { key: 'twilio.fromNumber', value: '+15550000000' },
      ]);
    }
    if (text.includes('SELECT token FROM driver_push_tokens')) {
      return Promise.resolve([{ token: PUSH_TOKEN }]);
    }
    return Promise.resolve([]);
  };
  sqlFn.json = (value: unknown) => value;
  return sqlFn as unknown;
}

function notificationRows(channel: string): SqlCall[] {
  return calls.filter(
    (c) => c.text.includes('INSERT INTO notifications') && c.values[0] === channel,
  );
}

let dispatchModule: typeof import('../notification-dispatch.js');
beforeAll(async () => {
  dispatchModule = await import('../notification-dispatch.js');
}, 30_000);

describe('dispatchDriverNotification options', () => {
  beforeEach(() => {
    calls.length = 0;
    vi.clearAllMocks();
    mockSendMail.mockResolvedValue({});
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ status: 'ok', id: 'r1' }] }),
      text: async () => '',
    });
    delete process.env['SETTINGS_ENCRYPTION_KEY'];
  });

  it('attaches files to the email, sends no SMS with sms: false and pushes the invoice id', async () => {
    const pdf = Buffer.from('%PDF-1.7');
    const result = await dispatchModule.dispatchDriverNotification(
      createSqlMock() as never,
      'invoice.MemberInvoice',
      'driver-1',
      { invoiceId: 'inv_1', invoiceNumber: 'INV-202610-0001' },
      [],
      undefined,
      {
        attachments: [
          { filename: 'INV-202610-0001.pdf', content: pdf, contentType: 'application/pdf' },
        ],
        sms: false,
      },
    );

    // A required event: delivered although the event setting and every preference are off.
    expect(result.delivered).toEqual([{ channel: 'email', recipient: 'mia@example.com' }]);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const mail = mockSendMail.mock.calls[0]?.[0] as { attachments?: unknown[] };
    expect(mail.attachments).toEqual([
      { filename: 'INV-202610-0001.pdf', content: pdf, contentType: 'application/pdf' },
    ]);
    // No SMS sent and no SMS attempt recorded; the push row and the native push still go.
    expect(mockFetch.mock.calls.some((c) => String(c[0]).includes('twilio'))).toBe(false);
    expect(notificationRows('sms')).toHaveLength(0);
    expect(notificationRows('push')).toHaveLength(1);
    const pushCall = mockFetch.mock.calls.find((c) => String(c[0]).includes('exp.host'));
    const pushed = JSON.parse(pushCall?.[1]?.body as string) as Array<{
      data: Record<string, unknown>;
    }>;
    expect(pushed[0]?.data).toEqual({ eventType: 'invoice.MemberInvoice', invoiceId: 'inv_1' });
  });

  it('sends the email without attachments and the SMS when no options are given', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({}),
      text: async () => '',
    });
    await dispatchModule.dispatchDriverNotification(
      createSqlMock() as never,
      'invoice.MemberOverdue',
      'driver-1',
      {},
      [],
    );

    const mail = mockSendMail.mock.calls[0]?.[0] as { attachments?: unknown[] };
    expect(mail.attachments).toBeUndefined();
    expect(mockFetch.mock.calls.some((c) => String(c[0]).includes('twilio'))).toBe(true);
    expect(notificationRows('sms')).toHaveLength(1);
  });
});
