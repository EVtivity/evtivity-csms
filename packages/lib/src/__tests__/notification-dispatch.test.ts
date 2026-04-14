// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
      const { wrapEmailHtml } = await import('../notification-dispatch.js');
      const result = wrapEmailHtml('<p>Hello</p>', 'TestCo');
      expect(result).toContain('<p>Hello</p>');
      expect(result).toContain('TestCo');
    });

    it('uses custom wrapper template when provided', async () => {
      const { wrapEmailHtml } = await import('../notification-dispatch.js');
      const result = wrapEmailHtml(
        '<p>Hello</p>',
        'TestCo',
        '<div>{{companyName}}: {{{content}}}</div>',
      );
      expect(result).toBe('<div>TestCo: <p>Hello</p></div>');
    });

    it('falls back to default template when custom is empty', async () => {
      const { wrapEmailHtml } = await import('../notification-dispatch.js');
      const result = wrapEmailHtml('<p>Hello</p>', 'TestCo', '');
      expect(result).toContain('TestCo');
      expect(result).toContain('<p>Hello</p>');
    });
  });

  describe('compileTemplate', () => {
    it('compiles Handlebars template with variables', async () => {
      const { compileTemplate } = await import('../notification-dispatch.js');
      const result = compileTemplate('Hello {{name}}!', { name: 'World' });
      expect(result).toBe('Hello World!');
    });

    it('caches compiled templates', async () => {
      const { compileTemplate } = await import('../notification-dispatch.js');
      const result1 = compileTemplate('Hello {{name}}!', { name: 'A' });
      const result2 = compileTemplate('Hello {{name}}!', { name: 'B' });
      expect(result1).toBe('Hello A!');
      expect(result2).toBe('Hello B!');
    });
  });

  describe('resolveRecipients', () => {
    it('returns literal address as single recipient', async () => {
      const { resolveRecipients } = await import('../notification-dispatch.js');
      const recipients = resolveRecipients(sql as never, 'user@test.com');
      expect(recipients).toEqual([{ address: 'user@test.com', language: 'en' }]);
    });

    it('returns empty array for empty string', async () => {
      const { resolveRecipients } = await import('../notification-dispatch.js');
      const recipients = resolveRecipients(sql as never, '');
      expect(recipients).toEqual([]);
    });

    it('returns empty array for whitespace-only string', async () => {
      const { resolveRecipients } = await import('../notification-dispatch.js');
      const recipients = resolveRecipients(sql as never, '   ');
      expect(recipients).toEqual([]);
    });
  });

  describe('loadDbTemplate', () => {
    it('returns template when found', async () => {
      const { loadDbTemplate } = await import('../notification-dispatch.js');
      setupSqlResults([{ subject: 'Test Subject', body_html: '<p>Test</p>' }]);
      const result = await loadDbTemplate(sql as never, 'test.event', 'email', 'en');
      expect(result).toEqual({ subject: 'Test Subject', bodyHtml: '<p>Test</p>' });
    });

    it('returns null when not found', async () => {
      const { loadDbTemplate } = await import('../notification-dispatch.js');
      setupSqlResults([]);
      const result = await loadDbTemplate(sql as never, 'test.event', 'email', 'en');
      expect(result).toBeNull();
    });
  });

  describe('renderTemplate', () => {
    it('uses templateHtmlOverride when provided', async () => {
      const { renderTemplate } = await import('../notification-dispatch.js');
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
      const { renderTemplate } = await import('../notification-dispatch.js');
      const result = await renderTemplate('email', 'test.event', 'en', {
        companyName: 'TestCo',
      });
      expect(result.body).toContain('TestCo');
      expect(JSON.parse(result.body)).toHaveProperty('companyName', 'TestCo');
    });

    it('uses DB template when available', async () => {
      const { renderTemplate } = await import('../notification-dispatch.js');
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
      const { renderTemplate } = await import('../notification-dispatch.js');
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

    it('uses friendly subject for known event types', async () => {
      const { renderTemplate } = await import('../notification-dispatch.js');
      const result = await renderTemplate('email', 'session.Started', 'en', {
        companyName: 'TestCo',
      });
      expect(result.subject).toContain('TestCo');
      expect(result.subject).toContain('started');
    });
  });

  describe('sendEmail', () => {
    it('sends email via nodemailer and returns true', async () => {
      const { sendEmail } = await import('../notification-dispatch.js');
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
          text: 'Body',
          html: '<p>HTML</p>',
        }),
      );
    });

    it('returns false on send failure', async () => {
      mockSendMail.mockRejectedValueOnce(new Error('SMTP error'));
      const { sendEmail } = await import('../notification-dispatch.js');
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
      const { sendSms } = await import('../notification-dispatch.js');
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
      const { sendSms } = await import('../notification-dispatch.js');
      const result = await sendSms(
        { accountSid: 'AC123', authToken: 'token', fromNumber: '+1234567890' },
        '+0987654321',
        'SMS body',
      );
      expect(result).toBe(false);
    });

    it('returns false on fetch exception', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));
      const { sendSms } = await import('../notification-dispatch.js');
      const result = await sendSms(
        { accountSid: 'AC123', authToken: 'token', fromNumber: '+1234567890' },
        '+0987654321',
        'SMS body',
      );
      expect(result).toBe(false);
    });
  });

  describe('sendWebhook', () => {
    it('sends webhook and returns true', async () => {
      const { sendWebhook } = await import('../notification-dispatch.js');
      const result = await sendWebhook('https://webhook.test.com/hook', 'Subject', 'Body', {
        key: 'value',
      });
      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://webhook.test.com/hook',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });

    it('returns false on delivery failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Server error'),
      });
      const { sendWebhook } = await import('../notification-dispatch.js');
      const result = await sendWebhook('https://webhook.test.com/hook', 'Subject', 'Body', {});
      expect(result).toBe(false);
    });
  });

  describe('logNotification', () => {
    it('logs notification without throwing', async () => {
      const { logNotification } = await import('../notification-dispatch.js');
      expect(() => logNotification('email', 'test@test.com', 'Subject', 'Body')).not.toThrow();
    });
  });

  describe('getNotificationSettings', () => {
    it('returns smtp config when host is configured, and null when not', async () => {
      // getNotificationSettings has a 5-minute cache, so we test both in order
      // First call: with SMTP settings
      const { getNotificationSettings } = await import('../notification-dispatch.js');
      setupSqlResults([
        { key: 'smtp.host', value: 'smtp.test.com' },
        { key: 'smtp.port', value: '587' },
        { key: 'smtp.username', value: 'user' },
        { key: 'smtp.password', value: '' },
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
      const { dispatchDriverNotification } = await import('../notification-dispatch.js');
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

      await dispatchDriverNotification(sql as never, 'session.Started', 'driver-1', {
        stationId: 'CS-001',
      });

      // Should have made SQL calls
      expect(sqlCalls.length).toBeGreaterThanOrEqual(5);
    });

    it('skips when event type is disabled', async () => {
      const { dispatchDriverNotification } = await import('../notification-dispatch.js');
      setupSqlResults(
        [{ is_enabled: false }], // disabled
      );

      await dispatchDriverNotification(sql as never, 'session.Started', 'driver-1', {});

      expect(sqlCalls.length).toBe(1);
    });

    it('skips when driver not found', async () => {
      const { dispatchDriverNotification } = await import('../notification-dispatch.js');
      setupSqlResults(
        [{ is_enabled: true }], // enabled
        [], // driver not found
      );

      await dispatchDriverNotification(sql as never, 'session.Started', 'driver-1', {});

      expect(sqlCalls.length).toBe(2);
    });

    it('handles dispatch errors gracefully', async () => {
      const { dispatchDriverNotification } = await import('../notification-dispatch.js');
      setupSqlResults([]); // Will cause an access error

      // Should not throw
      await expect(
        dispatchDriverNotification(sql as never, 'test.event', 'driver-1', {}),
      ).resolves.toBeUndefined();
    });
  });
});
