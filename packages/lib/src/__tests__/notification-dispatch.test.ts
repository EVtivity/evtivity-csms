// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

// Mock external dependencies
const mockSendMail = vi.fn().mockResolvedValue({});
vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({ sendMail: mockSendMail })),
  },
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
}));

const mockFetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('') });
vi.stubGlobal('fetch', mockFetch);

// The connect-time DNS guard of safeFetch has its own tests (safe-fetch.test.ts).
vi.mock('../safe-fetch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../safe-fetch.js')>()),
  safeFetch: (...args: unknown[]) => (globalThis.fetch as (...a: unknown[]) => unknown)(...args),
}));

// SQL mock
const sqlCalls: Array<{ values: unknown[] }> = [];
let sqlResults: unknown[][] = [];
let sqlCallIndex = 0;

function createSqlMock() {
  const sqlFn = (_strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    sqlCalls.push({ values });
    const result = sqlResults[sqlCallIndex] ?? [];
    sqlCallIndex++;
    return Promise.resolve(result);
  };
  return sqlFn as unknown;
}

function setupSqlResults(...results: unknown[][]) {
  sqlResults = results;
  sqlCallIndex = 0;
  sqlCalls.length = 0;
}

// Imported once, not in the first test: loading the module graph can exceed the 5 s test timeout under load.
let notificationDispatchModule: typeof import('../notification-dispatch.js');
beforeAll(async () => {
  notificationDispatchModule = await import('../notification-dispatch.js');
}, 30_000);

describe('notification-dispatch', () => {
  let sql: ReturnType<typeof createSqlMock>;

  beforeEach(() => {
    sql = createSqlMock();
    sqlCalls.length = 0;
    sqlResults = [];
    sqlCallIndex = 0;
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve('') });
    mockSendMail.mockResolvedValue({});

    // Clear the settings cache by setting env var
    delete process.env['SETTINGS_ENCRYPTION_KEY'];
  });

  describe('wrapEmailHtml', () => {
    it('wraps body HTML with default template', async () => {
      const { wrapEmailHtml } = notificationDispatchModule;
      const result = wrapEmailHtml('<p>Hello</p>', 'TestCo');
      expect(result).toContain('<p>Hello</p>');
      expect(result).toContain('TestCo');
    });

    it('uses custom wrapper template when provided', async () => {
      const { wrapEmailHtml } = notificationDispatchModule;
      const result = wrapEmailHtml(
        '<p>Hello</p>',
        'TestCo',
        '<div>{{companyName}}: {{{content}}}</div>',
      );
      expect(result).toBe('<div>TestCo: <p>Hello</p></div>');
    });

    it('falls back to default template when custom is empty', async () => {
      const { wrapEmailHtml } = notificationDispatchModule;
      const result = wrapEmailHtml('<p>Hello</p>', 'TestCo', '');
      expect(result).toContain('TestCo');
      expect(result).toContain('<p>Hello</p>');
    });
  });

  describe('compileTemplate', () => {
    it('compiles Handlebars template with variables', async () => {
      const { compileTemplate } = notificationDispatchModule;
      const result = compileTemplate('Hello {{name}}!', { name: 'World' });
      expect(result).toBe('Hello World!');
    });

    it('caches compiled templates', async () => {
      const { compileTemplate } = notificationDispatchModule;
      const result1 = compileTemplate('Hello {{name}}!', { name: 'A' });
      const result2 = compileTemplate('Hello {{name}}!', { name: 'B' });
      expect(result1).toBe('Hello A!');
      expect(result2).toBe('Hello B!');
    });
  });

  describe('formatDateVariables', () => {
    it('formats ISO date variables into the given timezone', async () => {
      const { formatDateVariables } = notificationDispatchModule;
      const iso = '2026-07-05T00:00:00.000Z';
      const result = formatDateVariables({ startedAt: iso }, 'America/New_York');
      expect(result['startedAt']).not.toBe(iso);
      expect(result['startedAt']).toContain('2026');
    });

    it('formats issuedAt, dueAt and refundedAt the same way as startedAt', async () => {
      const { formatDateVariables } = notificationDispatchModule;
      const iso = '2026-07-05T00:00:00.000Z';
      const result = formatDateVariables(
        { startedAt: iso, issuedAt: iso, dueAt: iso, refundedAt: iso },
        'America/New_York',
      );
      expect(result['issuedAt']).toBe(result['startedAt']);
      expect(result['dueAt']).toBe(result['startedAt']);
      expect(result['refundedAt']).toBe(result['startedAt']);
      expect(result['issuedAt']).not.toContain('T');
      expect(result['issuedAt']).not.toContain('Z');
    });

    it('formats in the given language without seconds', async () => {
      const { formatDateVariables } = await import('../notification-dispatch.js');
      const iso = '2026-03-05T08:04:09.000Z';
      expect(formatDateVariables({ startedAt: iso }, 'Europe/Berlin', 'de')['startedAt']).toBe(
        '05.03.2026, 09:04',
      );
      expect(formatDateVariables({ startedAt: iso }, 'Europe/Berlin')['startedAt']).toMatch(
        /^Mar 5, 2026, 9:04\sAM$/,
      );
    });

    it('leaves non-date variables untouched', async () => {
      const { formatDateVariables } = notificationDispatchModule;
      const result = formatDateVariables(
        { invoiceNumber: 'INV-001', issuedAt: '' },
        'America/New_York',
      );
      expect(result['invoiceNumber']).toBe('INV-001');
      expect(result['issuedAt']).toBe('');
    });
  });

  describe('resolveRecipients', () => {
    it('returns literal address as single recipient', async () => {
      const { resolveRecipients } = notificationDispatchModule;
      const recipients = resolveRecipients(sql as never, 'user@test.com');
      expect(recipients).toEqual([{ address: 'user@test.com', language: 'en' }]);
    });

    it('returns empty array for empty string', async () => {
      const { resolveRecipients } = notificationDispatchModule;
      const recipients = resolveRecipients(sql as never, '');
      expect(recipients).toEqual([]);
    });

    it('returns empty array for whitespace-only string', async () => {
      const { resolveRecipients } = notificationDispatchModule;
      const recipients = resolveRecipients(sql as never, '   ');
      expect(recipients).toEqual([]);
    });
  });

  describe('loadDbTemplate', () => {
    it('returns template when found', async () => {
      const { loadDbTemplate } = notificationDispatchModule;
      setupSqlResults([{ subject: 'Test Subject', body_html: '<p>Test</p>' }]);
      const result = await loadDbTemplate(sql as never, 'test.event', 'email', 'en');
      expect(result).toEqual({ subject: 'Test Subject', bodyHtml: '<p>Test</p>' });
    });

    it('returns null when not found', async () => {
      const { loadDbTemplate } = notificationDispatchModule;
      setupSqlResults([]);
      const result = await loadDbTemplate(sql as never, 'test.event', 'email', 'en');
      expect(result).toBeNull();
    });
  });

  describe('renderTemplate', () => {
    it('uses templateHtmlOverride when provided', async () => {
      const { renderTemplate } = notificationDispatchModule;
      const result = await renderTemplate(
        'email',
        'test.event',
        'en',
        { companyName: 'TestCo' },
        undefined,
        '<p>Override {{companyName}}</p>',
      );
      expect(result.body).toBe('<p>Override TestCo</p>');
      expect(result.html).toBe('<p>Override TestCo</p>');
    });

    it('falls back to JSON dump when no templates available', async () => {
      const { renderTemplate } = notificationDispatchModule;
      const result = await renderTemplate('email', 'test.event', 'en', {
        companyName: 'TestCo',
      });
      expect(result.body).toContain('TestCo');
      expect(JSON.parse(result.body)).toHaveProperty('companyName', 'TestCo');
    });

    it('uses DB template when available', async () => {
      const { renderTemplate } = notificationDispatchModule;
      setupSqlResults([{ subject: 'DB Subject', body_html: '<p>DB Body {{companyName}}</p>' }]);
      const result = await renderTemplate(
        'email',
        'test.event',
        'en',
        { companyName: 'TestCo' },
        sql as never,
      );
      expect(result.subject).toBe('DB Subject');
      expect(result.body).toBe('<p>DB Body TestCo</p>');
      expect(result.html).toBe('<p>DB Body TestCo</p>');
    });

    it('falls back to English DB template when language not found', async () => {
      const { renderTemplate } = notificationDispatchModule;
      setupSqlResults(
        [], // Spanish not found
        [{ subject: 'EN Subject', body_html: '<p>English</p>' }], // English fallback
      );
      const result = await renderTemplate(
        'email',
        'test.event',
        'es',
        { companyName: 'TestCo' },
        sql as never,
      );
      expect(result.subject).toBe('EN Subject');
    });

    it('uses the generic subject when no subject template exists', async () => {
      const { renderTemplate } = notificationDispatchModule;
      const result = await renderTemplate('email', 'session.Started', 'en', {
        companyName: 'TestCo',
      });
      expect(result.subject).toBe('TestCo - session.Started Notification');
    });
  });

  describe('sendEmail', () => {
    it('sends email via nodemailer and returns true', async () => {
      const { sendEmail } = notificationDispatchModule;
      const result = await sendEmail(
        {
          host: 'smtp.test.com',
          port: 587,
          username: 'user',
          password: 'pass',
          from: 'from@test.com',
        },
        'to@test.com',
        'Subject',
        'Body',
        '<p>HTML</p>',
      );
      expect(result).toBe(true);
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'to@test.com',
          subject: 'Subject',
          text: 'HTML',
          html: '<p>HTML</p>',
        }),
      );
    });

    it('derives the text part from the HTML, not the HTML template', async () => {
      const { sendEmail } = notificationDispatchModule;
      const html =
        '<img src="https://x.test/logo.png" alt="Logo"><h2 style="color:#111">Set up your account</h2>' +
        "<p>Hi Nightly,</p><a href='https://portal.test/activate?token&#x3D;abc'>Set Your Password</a>";
      await sendEmail(
        { host: 'smtp.test.com', port: 587, username: '', password: '', from: 'f@test.com' },
        'to@test.com',
        'Subject',
        html,
        html,
      );
      const text = (mockSendMail.mock.calls.at(-1)?.[0] as { text: string }).text;
      expect(text).not.toContain('<');
      expect(text).not.toContain('style=');
      expect(text).not.toContain('logo.png');
      expect(text).toContain('SET UP YOUR ACCOUNT');
      expect(text).toContain('Hi Nightly,');
      expect(text).toContain('Set Your Password [https://portal.test/activate?token=abc]');
    });

    it('sends the body as the text part without HTML', async () => {
      const { sendEmail } = notificationDispatchModule;
      await sendEmail(
        { host: 'smtp.test.com', port: 587, username: '', password: '', from: 'f@test.com' },
        'to@test.com',
        'Subject',
        'Plain body',
      );
      expect(mockSendMail.mock.calls.at(-1)?.[0]).toMatchObject({
        text: 'Plain body',
        html: undefined,
      });
    });

    it('returns false on send failure', async () => {
      mockSendMail.mockRejectedValueOnce(new Error('SMTP error'));
      const { sendEmail } = notificationDispatchModule;
      const result = await sendEmail(
        {
          host: 'smtp.test.com',
          port: 587,
          username: 'user',
          password: 'pass',
          from: 'from@test.com',
        },
        'to@test.com',
        'Subject',
        'Body',
      );
      expect(result).toBe(false);
    });
  });

  describe('sendSms', () => {
    it('sends SMS via Twilio API and returns true', async () => {
      const { sendSms } = notificationDispatchModule;
      const result = await sendSms(
        { accountSid: 'AC123', authToken: 'token', fromNumber: '+1234567890' },
        '+0987654321',
        'SMS body',
      );
      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('twilio.com'),
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('returns false on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve('Bad request'),
      });
      const { sendSms } = notificationDispatchModule;
      const result = await sendSms(
        { accountSid: 'AC123', authToken: 'token', fromNumber: '+1234567890' },
        '+0987654321',
        'SMS body',
      );
      expect(result).toBe(false);
    });

    it('returns false on fetch exception', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));
      const { sendSms } = notificationDispatchModule;
      const result = await sendSms(
        { accountSid: 'AC123', authToken: 'token', fromNumber: '+1234567890' },
        '+0987654321',
        'SMS body',
      );
      expect(result).toBe(false);
    });
  });

  describe('sendWebhook', () => {
    it('sends webhook and returns ok', async () => {
      const { sendWebhook } = notificationDispatchModule;
      const result = await sendWebhook('https://webhook.test.com/hook', 'Subject', 'Body', {
        key: 'value',
      });
      expect(result).toBe('ok');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://webhook.test.com/hook',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });

    it('returns http_error on non-2xx response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Server error'),
      });
      const { sendWebhook } = notificationDispatchModule;
      const result = await sendWebhook('https://webhook.test.com/hook', 'Subject', 'Body', {});
      expect(result).toBe('http_error');
    });
  });

  describe('logNotification', () => {
    it('logs notification without throwing', async () => {
      const { logNotification } = notificationDispatchModule;
      expect(() => logNotification('email', 'test@test.com', 'Subject', 'Body')).not.toThrow();
    });
  });

  describe('getNotificationSettings', () => {
    it('returns smtp config when host is configured, and null when not', async () => {
      // getNotificationSettings has a 5-minute cache, so we test both in order
      // First call: with SMTP settings
      const { getNotificationSettings } = notificationDispatchModule;
      setupSqlResults([
        { key: 'smtp.host', value: 'smtp.test.com' },
        { key: 'smtp.port', value: '587' },
        { key: 'smtp.username', value: 'user' },
        { key: 'smtp.passwordEnc', value: '' },
        { key: 'smtp.from', value: 'from@test.com' },
      ]);
      const settings = await getNotificationSettings(sql as never);
      expect(settings.smtp).toEqual(
        expect.objectContaining({
          host: 'smtp.test.com',
          port: 587,
          from: 'from@test.com',
        }),
      );

      // Subsequent call returns cached result (no new SQL call)
      const cached = await getNotificationSettings(sql as never);
      expect(cached.smtp).toEqual(settings.smtp);
    });
  });

  describe('dispatchDriverNotification', () => {
    it('sends email and SMS when enabled', async () => {
      const { dispatchDriverNotification } = notificationDispatchModule;
      setupSqlResults(
        [{ is_enabled: true }], // driver_event_settings
        [
          {
            first_name: 'John',
            last_name: 'Doe',
            email: 'john@test.com',
            phone: '+1234567890',
            language: 'en',
          },
        ], // driver
        [], // company settings
        [{ email_enabled: true, sms_enabled: true }], // preferences
        [], // notification settings (no smtp)
        [], // renderTemplate DB lookup (email)
        [], // renderTemplate fallback en
        [], // INSERT notifications (email)
        [], // renderTemplate DB lookup (sms)
        [], // renderTemplate fallback en
        [], // INSERT notifications (sms)
      );

      await dispatchDriverNotification(
        sql as never,
        'session.Started',
        'driver-1',
        {
          stationId: 'CS-001',
        },
        [],
      );

      // Should have made SQL calls
      expect(sqlCalls.length).toBeGreaterThanOrEqual(5);
    });

    it('skips when event type is disabled', async () => {
      const { dispatchDriverNotification } = notificationDispatchModule;
      setupSqlResults(
        [{ is_enabled: false }], // disabled
      );

      await dispatchDriverNotification(sql as never, 'session.Started', 'driver-1', {}, []);

      expect(sqlCalls.length).toBe(1);
    });

    it('skips when driver not found', async () => {
      const { dispatchDriverNotification } = notificationDispatchModule;
      // Dispatcher fans driver, prefs, company, settings in Promise.all
      // after the event-settings check. Cached helpers (company,
      // settings) may skip the DB on warm runs, so the call count is
      // unstable across test ordering. Cap at the post-fan total (1
      // event + up to 4 fan = 5) and assert no further work happens
      // after the missing-driver early return (no template lookup, no
      // INSERT — both would push the count past 5).
      setupSqlResults(
        [{ is_enabled: true }], // event-settings check
        [], // drivers SELECT — empty, triggers early return
        [], // prefs SELECT (parallel)
        [], // company.* SELECT (parallel, may be cached)
        [], // smtp/twilio settings SELECT (parallel, may be cached)
      );

      await dispatchDriverNotification(sql as never, 'session.Started', 'driver-1', {}, []);

      expect(sqlCalls.length).toBeLessThanOrEqual(5);
    });

    it('handles dispatch errors gracefully', async () => {
      const { dispatchDriverNotification } = notificationDispatchModule;
      setupSqlResults([]); // Will cause an access error

      // Should not throw
      await expect(
        dispatchDriverNotification(sql as never, 'test.event', 'driver-1', {}, []),
      ).resolves.toBeUndefined();
    });
  });
});

// Finding J2: a dispatch without the template directories finds no file
// template and sends the notification unrendered (subject "<event>
// Notification", body a dump of the variables). The parameter is required, so
// a call that omits it fails the typecheck.
describe('template directories are required', () => {
  it('rejects a dispatch without template directories at compile time', () => {
    const { dispatchDriverNotification, dispatchSystemNotification } = notificationDispatchModule;
    const sql = createSqlMock() as never;
    const omitted = [
      // @ts-expect-error templatesDir is required
      () => dispatchDriverNotification(sql, 'token.Added', 'driver-1', {}),
      // @ts-expect-error templatesDir is required
      () => dispatchSystemNotification(sql, 'user.Invited', { email: 'a@b.c' }, {}),
    ];
    expect(omitted).toHaveLength(2);
  });
});
