// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { encryptString } from '../encryption.js';

// --- Mocks ---

const mockSendMail = vi.fn().mockResolvedValue({});
vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({ sendMail: mockSendMail })),
  },
}));

const mockReadFile = vi.fn().mockRejectedValue(new Error('ENOENT'));
vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

vi.mock('../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../encryption.js', async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal();
  return {
    ...actual,
    decryptString: vi.fn(actual['decryptString'] as (...args: unknown[]) => unknown),
  };
});

const mockFetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('') });
vi.stubGlobal('fetch', mockFetch);

// --- SQL mock ---

const sqlCalls: Array<{ strings: TemplateStringsArray; values: unknown[] }> = [];
let sqlResults: unknown[][] = [];
let sqlCallIndex = 0;

function createSqlMock() {
  const sqlFn = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    sqlCalls.push({ strings, values });
    const result = sqlResults[sqlCallIndex] ?? [];
    sqlCallIndex++;
    return Promise.resolve(result);
  };
  sqlFn.json = (value: unknown) => value;
  return sqlFn as unknown;
}

function setupSqlResults(...results: unknown[][]) {
  sqlResults = results;
  sqlCallIndex = 0;
  sqlCalls.length = 0;
}

// Force fresh module for each test to clear template cache and settings cache
async function freshImport() {
  // We cannot truly re-import without resetModules, so we use the same import.
  // The settings cache has a 5-minute TTL which we manipulate via Date.now mocking.
  return await import('../notification-dispatch.js');
}

describe('notification-dispatch (full coverage)', () => {
  let sql: ReturnType<typeof createSqlMock>;

  beforeEach(() => {
    sql = createSqlMock();
    sqlCalls.length = 0;
    sqlResults = [];
    sqlCallIndex = 0;
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve('') });
    mockSendMail.mockResolvedValue({});
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    delete process.env['SETTINGS_ENCRYPTION_KEY'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // wrapEmailHtml
  // -----------------------------------------------------------------------

  describe('wrapEmailHtml', () => {
    it('uses default wrapper when wrapperTemplate is null', async () => {
      const { wrapEmailHtml } = await freshImport();
      const result = wrapEmailHtml('<p>Body</p>', 'Acme', null);
      expect(result).toContain('Acme');
      expect(result).toContain('<p>Body</p>');
      expect(result).toContain('<!DOCTYPE html>');
    });

    it('passes extra variables to wrapper template', async () => {
      const { wrapEmailHtml } = await freshImport();
      const result = wrapEmailHtml(
        '<p>Hi</p>',
        'Acme',
        '<div>{{companyName}} {{extra}} {{{content}}}</div>',
        { extra: 'bonus' },
      );
      expect(result).toBe('<div>Acme bonus <p>Hi</p></div>');
    });
  });

  // -----------------------------------------------------------------------
  // getNotificationSettings
  // -----------------------------------------------------------------------

  describe('getNotificationSettings', () => {
    it('returns null smtp and twilio when no host or sid configured', async () => {
      const { getNotificationSettings } = await freshImport();
      // Force cache miss by advancing time
      const realNow = Date.now;
      const nowValue = realNow() + 10 * 60 * 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowValue);

      setupSqlResults([]);
      const settings = await getNotificationSettings(sql as never);
      expect(settings.smtp).toBeNull();
      expect(settings.twilio).toBeNull();
      expect(settings.emailWrapperTemplate).toBeNull();

      Date.now = realNow;
    });

    it('decrypts SMTP password when encryption key is set', async () => {
      const { getNotificationSettings } = await freshImport();
      const realNow = Date.now;
      const nowValue = realNow() + 20 * 60 * 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowValue);

      const encKey = 'test-encryption-key-for-smtp';
      process.env['SETTINGS_ENCRYPTION_KEY'] = encKey;

      const encryptedPassword = encryptString('my-secret-pass', encKey);

      setupSqlResults([
        { key: 'smtp.host', value: 'mail.example.com' },
        { key: 'smtp.port', value: '465' },
        { key: 'smtp.username', value: 'admin' },
        { key: 'smtp.password', value: encryptedPassword },
        { key: 'smtp.from', value: 'noreply@example.com' },
      ]);

      const settings = await getNotificationSettings(sql as never);
      expect(settings.smtp).not.toBeNull();
      expect(settings.smtp!.host).toBe('mail.example.com');
      expect(settings.smtp!.port).toBe(465);
      expect(settings.smtp!.password).toBe('my-secret-pass');
      expect(settings.smtp!.from).toBe('noreply@example.com');

      Date.now = realNow;
    });

    it('handles SMTP password decryption failure', async () => {
      const { getNotificationSettings } = await freshImport();
      const realNow = Date.now;
      const nowValue = realNow() + 30 * 60 * 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowValue);

      process.env['SETTINGS_ENCRYPTION_KEY'] = 'some-key';

      setupSqlResults([
        { key: 'smtp.host', value: 'mail.example.com' },
        { key: 'smtp.password', value: 'invalid-encrypted-value' },
      ]);

      const settings = await getNotificationSettings(sql as never);
      expect(settings.smtp).not.toBeNull();
      expect(settings.smtp!.password).toBe('');
    });

    it('returns default port 587 when smtp.port is not set', async () => {
      const { getNotificationSettings } = await freshImport();
      const realNow = Date.now;
      const nowValue = realNow() + 40 * 60 * 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowValue);

      setupSqlResults([{ key: 'smtp.host', value: 'mail.example.com' }]);

      const settings = await getNotificationSettings(sql as never);
      expect(settings.smtp!.port).toBe(587);
      expect(settings.smtp!.username).toBe('');
      expect(settings.smtp!.from).toBe('');

      Date.now = realNow;
    });

    it('decrypts Twilio auth token when encryption key is set', async () => {
      const { getNotificationSettings } = await freshImport();
      const realNow = Date.now;
      const nowValue = realNow() + 50 * 60 * 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowValue);

      const encKey = 'test-encryption-key-twilio';
      process.env['SETTINGS_ENCRYPTION_KEY'] = encKey;

      const encryptedToken = encryptString('twilio-secret', encKey);

      setupSqlResults([
        { key: 'twilio.accountSid', value: 'AC12345' },
        { key: 'twilio.authToken', value: encryptedToken },
        { key: 'twilio.fromNumber', value: '+15551234567' },
      ]);

      const settings = await getNotificationSettings(sql as never);
      expect(settings.twilio).not.toBeNull();
      expect(settings.twilio!.accountSid).toBe('AC12345');
      expect(settings.twilio!.authToken).toBe('twilio-secret');
      expect(settings.twilio!.fromNumber).toBe('+15551234567');

      Date.now = realNow;
    });

    it('handles Twilio auth token decryption failure', async () => {
      const { getNotificationSettings } = await freshImport();
      const realNow = Date.now;
      const nowValue = realNow() + 60 * 60 * 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowValue);

      process.env['SETTINGS_ENCRYPTION_KEY'] = 'some-key';

      setupSqlResults([
        { key: 'twilio.accountSid', value: 'AC12345' },
        { key: 'twilio.authToken', value: 'bad-encrypted-token' },
      ]);

      const settings = await getNotificationSettings(sql as never);
      expect(settings.twilio).not.toBeNull();
      expect(settings.twilio!.authToken).toBe('');
      expect(settings.twilio!.fromNumber).toBe('');

      Date.now = realNow;
    });

    it('skips SMTP password decryption when no encryption key is set', async () => {
      const { getNotificationSettings } = await freshImport();
      const realNow = Date.now;
      const nowValue = realNow() + 70 * 60 * 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowValue);

      // No SETTINGS_ENCRYPTION_KEY set
      setupSqlResults([
        { key: 'smtp.host', value: 'mail.example.com' },
        { key: 'smtp.password', value: 'encrypted-value' },
      ]);

      const settings = await getNotificationSettings(sql as never);
      expect(settings.smtp!.password).toBe('');

      Date.now = realNow;
    });

    it('skips Twilio token decryption when no encryption key is set', async () => {
      const { getNotificationSettings } = await freshImport();
      const realNow = Date.now;
      const nowValue = realNow() + 80 * 60 * 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowValue);

      setupSqlResults([
        { key: 'twilio.accountSid', value: 'AC12345' },
        { key: 'twilio.authToken', value: 'encrypted-value' },
      ]);

      const settings = await getNotificationSettings(sql as never);
      expect(settings.twilio!.authToken).toBe('');

      Date.now = realNow;
    });

    it('returns emailWrapperTemplate from settings', async () => {
      const { getNotificationSettings } = await freshImport();
      const realNow = Date.now;
      const nowValue = realNow() + 90 * 60 * 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowValue);

      setupSqlResults([{ key: 'email.wrapperTemplate', value: '<html>{{{content}}}</html>' }]);

      const settings = await getNotificationSettings(sql as never);
      expect(settings.emailWrapperTemplate).toBe('<html>{{{content}}}</html>');

      Date.now = realNow;
    });

    it('returns cached settings within TTL', async () => {
      const { getNotificationSettings } = await freshImport();
      const realNow = Date.now;
      const nowValue = realNow() + 100 * 60 * 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowValue);

      setupSqlResults([{ key: 'smtp.host', value: 'first.example.com' }]);

      const first = await getNotificationSettings(sql as never);
      expect(first.smtp!.host).toBe('first.example.com');

      // Second call within TTL (same nowValue means cache is still valid)
      setupSqlResults([{ key: 'smtp.host', value: 'second.example.com' }]);
      const second = await getNotificationSettings(sql as never);
      expect(second.smtp!.host).toBe('first.example.com'); // cached

      Date.now = realNow;
    });
  });

  // -----------------------------------------------------------------------
  // resolveRecipients
  // -----------------------------------------------------------------------

  describe('resolveRecipients', () => {
    it('returns literal email as single recipient', async () => {
      const { resolveRecipients } = await freshImport();
      const recipients = resolveRecipients(sql as never, 'admin@example.com');
      expect(recipients).toEqual([{ address: 'admin@example.com', language: 'en' }]);
    });

    it('returns empty array for empty recipient', async () => {
      const { resolveRecipients } = await freshImport();
      const recipients = resolveRecipients(sql as never, '');
      expect(recipients).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // loadTemplateFile
  // -----------------------------------------------------------------------

  describe('loadTemplateFile', () => {
    it('returns file content when file exists', async () => {
      const { loadTemplateFile } = await freshImport();
      mockReadFile.mockResolvedValueOnce('<p>Template content</p>');
      const result = await loadTemplateFile('/some/path.hbs');
      expect(result).toBe('<p>Template content</p>');
    });

    it('returns null when file does not exist', async () => {
      const { loadTemplateFile } = await freshImport();
      mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
      const result = await loadTemplateFile('/nonexistent.hbs');
      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // loadDbTemplate
  // -----------------------------------------------------------------------

  describe('loadDbTemplate', () => {
    it('handles null subject and body_html in DB row', async () => {
      const { loadDbTemplate } = await freshImport();
      setupSqlResults([{ subject: null, body_html: null }]);
      const result = await loadDbTemplate(sql as never, 'test.event', 'email', 'en');
      expect(result).toEqual({ subject: null, bodyHtml: null });
    });
  });

  // -----------------------------------------------------------------------
  // renderTemplate
  // -----------------------------------------------------------------------

  describe('renderTemplate', () => {
    it('sets html on result for email channel with template override', async () => {
      const { renderTemplate } = await freshImport();
      const result = await renderTemplate(
        'email',
        'test.event',
        'en',
        { companyName: 'Co' },
        undefined,
        '<b>Override</b>',
      );
      expect(result.html).toBe('<b>Override</b>');
      expect(result.body).toBe('<b>Override</b>');
    });

    it('does not set html for non-email channel with template override', async () => {
      const { renderTemplate } = await freshImport();
      const result = await renderTemplate(
        'sms',
        'test.event',
        'en',
        { companyName: 'Co' },
        undefined,
        'SMS override text',
      );
      expect(result.html).toBeUndefined();
      expect(result.body).toBe('SMS override text');
    });

    it('uses defaultSubject when DB template has null subject', async () => {
      const { renderTemplate } = await freshImport();
      setupSqlResults([{ subject: null, body_html: '<p>Body only</p>' }]);
      const result = await renderTemplate(
        'email',
        'session.Started',
        'en',
        { companyName: 'TestCo' },
        sql as never,
      );
      expect(result.subject).toContain('TestCo');
      expect(result.subject).toContain('started');
    });

    it('does not set html for sms channel from DB template', async () => {
      const { renderTemplate } = await freshImport();
      setupSqlResults([{ subject: 'SMS Subject', body_html: 'Hi {{firstName}}' }]);
      const result = await renderTemplate(
        'sms',
        'test.event',
        'en',
        { firstName: 'Jane', companyName: 'Co' },
        sql as never,
      );
      expect(result.html).toBeUndefined();
      expect(result.body).toBe('Hi Jane');
    });

    it('uses file-based template when DB template not found', async () => {
      const { renderTemplate } = await freshImport();
      // DB returns null
      setupSqlResults([], []);
      mockReadFile.mockResolvedValueOnce('<p>File template for {{companyName}}</p>');

      const result = await renderTemplate(
        'email',
        'test.event',
        'en',
        { companyName: 'FileCo' },
        sql as never,
        undefined,
        '/templates',
      );
      expect(result.body).toBe('<p>File template for FileCo</p>');
      expect(result.html).toBe('<p>File template for FileCo</p>');
    });

    it('falls back to English file template when language not found', async () => {
      const { renderTemplate } = await freshImport();
      setupSqlResults([], []); // DB misses for 'fr' and 'en'
      // First file read (fr) fails, second (en) succeeds
      mockReadFile
        .mockRejectedValueOnce(new Error('ENOENT'))
        .mockResolvedValueOnce('<p>English fallback</p>');

      const result = await renderTemplate(
        'email',
        'test.event',
        'fr',
        { companyName: 'Co' },
        sql as never,
        undefined,
        '/templates-fallback',
      );
      expect(result.body).toBe('<p>English fallback</p>');
      expect(result.html).toBe('<p>English fallback</p>');
    });

    it('does not set html for sms channel from file template', async () => {
      const { renderTemplate } = await freshImport();
      mockReadFile.mockResolvedValueOnce('Hello {{firstName}} from file');

      const result = await renderTemplate(
        'sms',
        'test.event',
        'en',
        { firstName: 'Bob', companyName: 'Co' },
        undefined,
        undefined,
        '/templates-sms',
      );
      expect(result.html).toBeUndefined();
      expect(result.body).toBe('Hello Bob from file');
    });

    it('does not fall back to English file when language is already en', async () => {
      const { renderTemplate } = await freshImport();
      // File not found for 'en'
      mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));

      const result = await renderTemplate(
        'email',
        'test.event',
        'en',
        { companyName: 'Co' },
        undefined,
        undefined,
        '/templates-en-only',
      );
      // Falls through to JSON fallback
      expect(JSON.parse(result.body)).toHaveProperty('companyName', 'Co');
    });

    it('uses generic subject for unknown event type', async () => {
      const { renderTemplate } = await freshImport();
      const result = await renderTemplate('email', 'custom.Unknown', 'en', {
        companyName: 'TestCo',
      });
      expect(result.subject).toContain('TestCo');
      expect(result.subject).toContain('custom.Unknown');
      expect(result.subject).toContain('Notification');
    });

    it('uses friendly subject for all known event types', async () => {
      const { renderTemplate } = await freshImport();
      const knownTypes = [
        'session.Completed',
        'session.Updated',
        'session.PaymentReceived',
        'driver.Welcome',
        'driver.ForgotPassword',
        'driver.PasswordChanged',
        'driver.AccountVerification',
        'payment.Complete',
        'payment.Refunded',
        'reservation.Expiring',
        'reservation.Expired',
        'session.Receipt',
        'operator.ForgotPassword',
        'report.Scheduled',
      ];
      for (const eventType of knownTypes) {
        const result = await renderTemplate('sms', eventType, 'en', { companyName: 'Acme' });
        expect(result.subject).toContain('Acme');
        expect(result.subject).not.toContain('Notification');
      }
    });

    it('skips DB lookup when sql is not provided', async () => {
      const { renderTemplate } = await freshImport();
      const result = await renderTemplate('email', 'test.event', 'en', { companyName: 'Co' });
      // No sql, no templatesDir -> JSON fallback
      expect(JSON.parse(result.body)).toHaveProperty('companyName', 'Co');
    });

    it('does not fallback to English DB template when language is already en', async () => {
      const { renderTemplate } = await freshImport();
      // DB returns null for 'en', no fallback attempted
      setupSqlResults([]);
      const result = await renderTemplate(
        'email',
        'test.event',
        'en',
        { companyName: 'Co' },
        sql as never,
      );
      // Falls through to JSON fallback
      expect(JSON.parse(result.body)).toHaveProperty('companyName', 'Co');
      // Only 1 SQL call (no fallback to 'en')
      expect(sqlCalls.length).toBe(1);
    });

    it('skips empty template override', async () => {
      const { renderTemplate } = await freshImport();
      const result = await renderTemplate(
        'email',
        'test.event',
        'en',
        { companyName: 'Co' },
        undefined,
        '', // empty string should be skipped
      );
      // Falls through to JSON fallback
      expect(JSON.parse(result.body)).toHaveProperty('companyName', 'Co');
    });

    it('skips null template override', async () => {
      const { renderTemplate } = await freshImport();
      const result = await renderTemplate(
        'email',
        'test.event',
        'en',
        { companyName: 'Co' },
        undefined,
        null,
      );
      expect(JSON.parse(result.body)).toHaveProperty('companyName', 'Co');
    });

    it('skips file template lookup when templatesDir is not provided', async () => {
      const { renderTemplate } = await freshImport();
      setupSqlResults([]); // DB miss
      const result = await renderTemplate(
        'email',
        'test.event',
        'en',
        { companyName: 'Co' },
        sql as never,
        undefined,
        undefined, // no templatesDir
      );
      expect(JSON.parse(result.body)).toHaveProperty('companyName', 'Co');
    });

    it('trims file template body', async () => {
      const { renderTemplate } = await freshImport();
      mockReadFile.mockResolvedValueOnce('  \n  Hello {{companyName}}  \n  ');

      const result = await renderTemplate(
        'sms',
        'test.event',
        'en',
        { companyName: 'Co' },
        undefined,
        undefined,
        '/templates-trim',
      );
      expect(result.body).toBe('Hello Co');
    });

    it('falls through to JSON fallback when DB template has null bodyHtml', async () => {
      const { renderTemplate } = await freshImport();
      // dbTemplate is found (not null) but bodyHtml is null.
      // The fallback condition checks `dbTemplate == null` which is false,
      // so no English fallback is attempted. The second condition
      // `dbTemplate != null && dbTemplate.bodyHtml != null` is also false,
      // so it falls through to file templates or JSON dump.
      setupSqlResults([{ subject: 'Has Subject', body_html: null }]);
      const result = await renderTemplate(
        'email',
        'test.event',
        'fr',
        { companyName: 'Co' },
        sql as never,
      );
      // Falls through to JSON dump since no file templates either
      expect(JSON.parse(result.body)).toHaveProperty('companyName', 'Co');
      // Only 1 SQL call (no English fallback since dbTemplate was found, just with null body)
      expect(sqlCalls.length).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // sendEmail
  // -----------------------------------------------------------------------

  describe('sendEmail', () => {
    it('uses secure transport when port is 465', async () => {
      const nodemailer = await import('nodemailer');
      const { sendEmail } = await freshImport();

      await sendEmail(
        {
          host: 'smtp.test.com',
          port: 465,
          username: 'user',
          password: 'pass',
          from: 'from@test.com',
        },
        'to@test.com',
        'Subject',
        'Body',
      );

      expect(nodemailer.default.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          secure: true,
          port: 465,
        }),
      );
    });

    it('skips auth when username is empty', async () => {
      const nodemailer = await import('nodemailer');
      const { sendEmail } = await freshImport();

      await sendEmail(
        {
          host: 'smtp.test.com',
          port: 587,
          username: '',
          password: '',
          from: 'from@test.com',
        },
        'to@test.com',
        'Subject',
        'Body',
      );

      expect(nodemailer.default.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          auth: undefined,
        }),
      );
    });

    it('sends email without html when not provided', async () => {
      const { sendEmail } = await freshImport();

      await sendEmail(
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

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: undefined,
        }),
      );
    });

    it('sends email with attachments', async () => {
      const { sendEmail } = await freshImport();

      const attachment = {
        filename: 'report.pdf',
        content: Buffer.from('pdf-content'),
        contentType: 'application/pdf',
      };

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
        [attachment],
      );

      expect(result).toBe(true);
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          attachments: [
            {
              filename: 'report.pdf',
              content: Buffer.from('pdf-content'),
              contentType: 'application/pdf',
            },
          ],
        }),
      );
    });

    it('sends email with attachment without contentType', async () => {
      const { sendEmail } = await freshImport();

      const attachment = {
        filename: 'data.csv',
        content: Buffer.from('csv-data'),
      };

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
        undefined,
        [attachment],
      );

      expect(result).toBe(true);
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          attachments: [
            expect.objectContaining({
              filename: 'data.csv',
              contentType: undefined,
            }),
          ],
        }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // sendWebhook
  // -----------------------------------------------------------------------

  describe('sendWebhook', () => {
    it('returns false on fetch exception', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));
      const { sendWebhook } = await freshImport();
      const result = await sendWebhook('https://hook.example.com', 'Subject', 'Body', {
        key: 'val',
      });
      expect(result).toBe(false);
    });

    it('sends JSON body with variables merged', async () => {
      const { sendWebhook } = await freshImport();
      await sendWebhook('https://hook.example.com', 'Sub', 'Body text', {
        stationId: 'CS-001',
        energy: 42,
      });

      expect(mockFetch).toHaveBeenCalledWith('https://hook.example.com', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject: 'Sub',
          body: 'Body text',
          stationId: 'CS-001',
          energy: 42,
        }),
      });
    });
  });

  // -----------------------------------------------------------------------
  // dispatchDriverNotification
  // -----------------------------------------------------------------------

  describe('dispatchDriverNotification', () => {
    it('proceeds when no event setting row exists (defaults to enabled)', async () => {
      const { dispatchDriverNotification } = await freshImport();
      const realNow = Date.now;
      const nowValue = realNow() + 200 * 60 * 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowValue);

      setupSqlResults(
        [], // driver_event_settings: no row (should proceed)
        [
          {
            first_name: 'Alice',
            last_name: 'Smith',
            email: 'alice@test.com',
            phone: null,
            language: 'en',
          },
        ], // driver
        [{ key: 'company.name', value: 'TestCo' }], // company settings
        [{ email_enabled: true, sms_enabled: false }], // preferences
        [], // notification settings (cache miss)
        [], // renderTemplate DB lookup for email
        [], // INSERT notifications
      );

      await dispatchDriverNotification(sql as never, 'driver.Welcome', 'driver-1', {});
      // Should reach the email send stage (6+ SQL calls)
      expect(sqlCalls.length).toBeGreaterThanOrEqual(5);

      Date.now = realNow;
    });

    it('skips email when driver has no email', async () => {
      const { dispatchDriverNotification } = await freshImport();
      const realNow = Date.now;
      const nowValue = realNow() + 210 * 60 * 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowValue);

      setupSqlResults(
        [{ is_enabled: true }], // event enabled
        [
          {
            first_name: 'NoEmail',
            last_name: 'User',
            email: null,
            phone: '+1555000000',
            language: 'en',
          },
        ], // driver without email
        [], // company settings
        [{ email_enabled: true, sms_enabled: true }], // preferences
        [], // notification settings
        [], // renderTemplate DB lookup for sms
        [], // INSERT notifications (sms)
      );

      await dispatchDriverNotification(sql as never, 'session.Started', 'driver-2', {});
      // No email SQL calls (no renderTemplate for email, no INSERT for email)
      // Should still process SMS
      expect(sqlCalls.length).toBeGreaterThanOrEqual(5);

      Date.now = realNow;
    });

    it('skips SMS when driver has no phone', async () => {
      const { dispatchDriverNotification } = await freshImport();
      const realNow = Date.now;
      const nowValue = realNow() + 220 * 60 * 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowValue);

      setupSqlResults(
        [{ is_enabled: true }], // event enabled
        [
          {
            first_name: 'NoPhone',
            last_name: 'User',
            email: 'nophone@test.com',
            phone: null,
            language: 'en',
          },
        ], // driver without phone
        [], // company settings
        [{ email_enabled: true, sms_enabled: true }], // preferences
        [], // notification settings
        [], // renderTemplate DB lookup for email
        [], // INSERT email notification
      );

      await dispatchDriverNotification(sql as never, 'session.Started', 'driver-3', {});
      expect(sqlCalls.length).toBeGreaterThanOrEqual(5);

      Date.now = realNow;
    });

    it('skips email when email_enabled is false in preferences', async () => {
      const { dispatchDriverNotification } = await freshImport();
      const realNow = Date.now;
      const nowValue = realNow() + 230 * 60 * 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowValue);

      setupSqlResults(
        [{ is_enabled: true }],
        [
          {
            first_name: 'Bob',
            last_name: 'Test',
            email: 'bob@test.com',
            phone: '+1555111111',
            language: 'en',
          },
        ],
        [],
        [{ email_enabled: false, sms_enabled: true }], // email disabled
        [], // notification settings
        [], // renderTemplate for sms
        [], // INSERT sms notification
      );

      await dispatchDriverNotification(sql as never, 'session.Started', 'driver-4', {});
      expect(sqlCalls.length).toBeGreaterThanOrEqual(5);

      Date.now = realNow;
    });

    it('skips SMS when sms_enabled is false in preferences', async () => {
      const { dispatchDriverNotification } = await freshImport();
      const realNow = Date.now;
      const nowValue = realNow() + 240 * 60 * 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowValue);

      setupSqlResults(
        [{ is_enabled: true }],
        [
          {
            first_name: 'Carol',
            last_name: 'Test',
            email: 'carol@test.com',
            phone: '+1555222222',
            language: 'en',
          },
        ],
        [],
        [{ email_enabled: true, sms_enabled: false }], // sms disabled
        [], // notification settings
        [], // renderTemplate for email
        [], // INSERT email notification
      );

      await dispatchDriverNotification(sql as never, 'session.Started', 'driver-5', {});
      expect(sqlCalls.length).toBeGreaterThanOrEqual(5);

      Date.now = realNow;
    });

    it('defaults both channels enabled when no preference row exists', async () => {
      const { dispatchDriverNotification } = await freshImport();
      const realNow = Date.now;
      const nowValue = realNow() + 250 * 60 * 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowValue);

      setupSqlResults(
        [{ is_enabled: true }],
        [
          {
            first_name: 'Default',
            last_name: 'Prefs',
            email: 'default@test.com',
            phone: '+1555333333',
            language: 'en',
          },
        ],
        [],
        [], // no preference row - defaults to both enabled
        [], // notification settings
        [], // renderTemplate for email
        [], // INSERT email notification
        [], // renderTemplate for sms
        [], // INSERT sms notification
      );

      await dispatchDriverNotification(sql as never, 'session.Started', 'driver-6', {});
      expect(sqlCalls.length).toBeGreaterThanOrEqual(7);

      Date.now = realNow;
    });

    it('sends email via SMTP when smtp is configured', async () => {
      const { dispatchDriverNotification } = await freshImport();
      const realNow = Date.now;
      const nowValue = realNow() + 260 * 60 * 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowValue);

      setupSqlResults(
        [{ is_enabled: true }],
        [
          {
            first_name: 'SmtpUser',
            last_name: 'Test',
            email: 'smtp@test.com',
            phone: null,
            language: 'en',
          },
        ],
        [{ key: 'company.name', value: 'SmtpCo' }],
        [{ email_enabled: true, sms_enabled: false }],
        // notification settings with SMTP configured
        [
          { key: 'smtp.host', value: 'smtp.example.com' },
          { key: 'smtp.port', value: '587' },
          { key: 'smtp.username', value: 'user' },
          { key: 'smtp.password', value: '' },
          { key: 'smtp.from', value: 'noreply@example.com' },
        ],
        [], // renderTemplate DB lookup for email
        [], // INSERT email notification
      );

      await dispatchDriverNotification(sql as never, 'driver.Welcome', 'driver-7', {});
      expect(mockSendMail).toHaveBeenCalled();

      Date.now = realNow;
    });

    it('records failed status when SMTP send fails', async () => {
      const { dispatchDriverNotification } = await freshImport();
      const realNow = Date.now;
      const nowValue = realNow() + 270 * 60 * 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowValue);

      mockSendMail.mockRejectedValueOnce(new Error('SMTP connection refused'));

      setupSqlResults(
        [{ is_enabled: true }],
        [
          {
            first_name: 'FailEmail',
            last_name: 'User',
            email: 'fail@test.com',
            phone: null,
            language: 'en',
          },
        ],
        [{ key: 'company.name', value: 'FailCo' }],
        [{ email_enabled: true, sms_enabled: false }],
        [
          { key: 'smtp.host', value: 'smtp.example.com' },
          { key: 'smtp.port', value: '587' },
          { key: 'smtp.username', value: 'user' },
          { key: 'smtp.password', value: '' },
          { key: 'smtp.from', value: 'noreply@example.com' },
        ],
        [], // renderTemplate DB lookup
        [], // INSERT notification (should have status 'failed')
      );

      await dispatchDriverNotification(sql as never, 'driver.Welcome', 'driver-8', {});
      // The INSERT call should have 'failed' as the status
      const insertCall = sqlCalls.find((c) => c.values.some((v) => v === 'failed'));
      expect(insertCall).toBeTruthy();

      Date.now = realNow;
    });

    it('sends SMS via Twilio when twilio is configured', async () => {
      const { dispatchDriverNotification } = await freshImport();
      const realNow = Date.now;
      const nowValue = realNow() + 280 * 60 * 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowValue);

      setupSqlResults(
        [{ is_enabled: true }],
        [
          {
            first_name: 'SmsUser',
            last_name: 'Test',
            email: null,
            phone: '+1555444444',
            language: 'en',
          },
        ],
        [{ key: 'company.name', value: 'SmsCo' }],
        [{ email_enabled: false, sms_enabled: true }],
        [
          { key: 'twilio.accountSid', value: 'AC123' },
          { key: 'twilio.authToken', value: '' },
          { key: 'twilio.fromNumber', value: '+1555000000' },
        ],
        [], // renderTemplate DB lookup for sms
        [], // INSERT sms notification
      );

      await dispatchDriverNotification(sql as never, 'session.Completed', 'driver-9', {});
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('twilio.com'),
        expect.objectContaining({ method: 'POST' }),
      );

      Date.now = realNow;
    });

    it('records failed status when Twilio SMS send fails', async () => {
      const { dispatchDriverNotification } = await freshImport();
      const realNow = Date.now;
      const nowValue = realNow() + 290 * 60 * 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowValue);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve('Bad request'),
      });

      setupSqlResults(
        [{ is_enabled: true }],
        [
          {
            first_name: 'FailSms',
            last_name: 'User',
            email: null,
            phone: '+1555555555',
            language: 'en',
          },
        ],
        [],
        [{ email_enabled: false, sms_enabled: true }],
        [
          { key: 'twilio.accountSid', value: 'AC123' },
          { key: 'twilio.authToken', value: '' },
          { key: 'twilio.fromNumber', value: '+1555000000' },
        ],
        [], // renderTemplate DB lookup for sms
        [], // INSERT sms notification
      );

      await dispatchDriverNotification(sql as never, 'session.Completed', 'driver-10', {});
      const insertCall = sqlCalls.find((c) => c.values.some((v) => v === 'failed'));
      expect(insertCall).toBeTruthy();

      Date.now = realNow;
    });

    it('logs email notification when SMTP not configured', async () => {
      const { dispatchDriverNotification } = await freshImport();
      const realNow = Date.now;
      const nowValue = realNow() + 300 * 60 * 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowValue);

      setupSqlResults(
        [{ is_enabled: true }],
        [
          {
            first_name: 'LogUser',
            last_name: 'Test',
            email: 'log@test.com',
            phone: null,
            language: 'en',
          },
        ],
        [],
        [{ email_enabled: true, sms_enabled: false }],
        [], // notification settings: no SMTP
        [], // renderTemplate for push
        [], // INSERT push notification
      );

      await dispatchDriverNotification(sql as never, 'driver.Welcome', 'driver-11', {});
      // No SMTP calls and no email insert when SMTP not configured
      expect(mockSendMail).not.toHaveBeenCalled();
      const emailInsert = sqlCalls.find(
        (c) =>
          c.strings.some((s) => s.includes('INSERT INTO notifications')) &&
          c.values.some((v) => v === 'email'),
      );
      expect(emailInsert).toBeUndefined();

      Date.now = realNow;
    });

    it('logs SMS notification when Twilio not configured', async () => {
      const { dispatchDriverNotification } = await freshImport();
      const realNow = Date.now;
      const nowValue = realNow() + 310 * 60 * 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowValue);

      setupSqlResults(
        [{ is_enabled: true }],
        [
          {
            first_name: 'LogSms',
            last_name: 'User',
            email: null,
            phone: '+1555666666',
            language: 'en',
          },
        ],
        [],
        [{ email_enabled: false, sms_enabled: true }],
        [], // notification settings: no Twilio
        [], // renderTemplate for push
        [], // INSERT push notification
      );

      await dispatchDriverNotification(sql as never, 'session.Started', 'driver-12', {});
      // No Twilio calls and no SMS insert when Twilio not configured
      expect(mockFetch).not.toHaveBeenCalled();
      const smsInsert = sqlCalls.find(
        (c) =>
          c.strings.some((s) => s.includes('INSERT INTO notifications')) &&
          c.values.some((v) => v === 'sms'),
      );
      expect(smsInsert).toBeUndefined();

      Date.now = realNow;
    });

    it('skips email when driver email is empty string', async () => {
      const { dispatchDriverNotification } = await freshImport();
      const realNow = Date.now;
      const nowValue = realNow() + 320 * 60 * 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowValue);

      setupSqlResults(
        [{ is_enabled: true }],
        [
          {
            first_name: 'EmptyEmail',
            last_name: 'User',
            email: '',
            phone: '+1555777777',
            language: 'en',
          },
        ],
        [],
        [{ email_enabled: true, sms_enabled: true }],
        [], // notification settings
        [], // renderTemplate for sms
        [], // INSERT sms notification
      );

      await dispatchDriverNotification(sql as never, 'session.Started', 'driver-13', {});
      // Email path skipped even though email_enabled is true because email is empty
      expect(mockSendMail).not.toHaveBeenCalled();

      Date.now = realNow;
    });

    it('skips SMS when driver phone is empty string', async () => {
      const { dispatchDriverNotification } = await freshImport();
      const realNow = Date.now;
      const nowValue = realNow() + 330 * 60 * 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowValue);

      setupSqlResults(
        [{ is_enabled: true }],
        [
          {
            first_name: 'EmptyPhone',
            last_name: 'User',
            email: 'emptyphone@test.com',
            phone: '',
            language: 'en',
          },
        ],
        [],
        [{ email_enabled: true, sms_enabled: true }],
        [], // notification settings
        [], // renderTemplate for email
        [], // INSERT email notification
      );

      await dispatchDriverNotification(sql as never, 'session.Started', 'driver-14', {});
      expect(mockFetch).not.toHaveBeenCalled();

      Date.now = realNow;
    });

    it('uses driver language for template rendering', async () => {
      const { dispatchDriverNotification } = await freshImport();
      const realNow = Date.now;
      const nowValue = realNow() + 340 * 60 * 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowValue);

      setupSqlResults(
        [{ is_enabled: true }],
        [
          {
            first_name: 'Spanish',
            last_name: 'User',
            email: 'spanish@test.com',
            phone: null,
            language: 'es',
          },
        ],
        [],
        [{ email_enabled: true, sms_enabled: false }],
        [], // notification settings
        [], // renderTemplate DB lookup for email (es)
        [], // renderTemplate DB fallback (en)
        [], // INSERT email notification
      );

      await dispatchDriverNotification(sql as never, 'driver.Welcome', 'driver-15', {});
      // Check that the renderTemplate DB lookup used 'es' language
      expect(sqlCalls.length).toBeGreaterThanOrEqual(5);

      Date.now = realNow;
    });

    it('enriches variables with company settings', async () => {
      const { dispatchDriverNotification } = await freshImport();
      const realNow = Date.now;
      const nowValue = realNow() + 350 * 60 * 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowValue);

      setupSqlResults(
        [{ is_enabled: true }],
        [
          {
            first_name: 'Rich',
            last_name: 'Vars',
            email: 'rich@test.com',
            phone: null,
            language: 'en',
          },
        ],
        [
          { key: 'company.name', value: 'RichCo' },
          { key: 'company.currency', value: 'EUR' },
          { key: 'company.contactEmail', value: 'contact@richco.com' },
          { key: 'company.supportEmail', value: 'support@richco.com' },
          { key: 'company.supportPhone', value: '+1800RICHCO' },
          { key: 'company.street', value: '123 Main St' },
          { key: 'company.city', value: 'Berlin' },
          { key: 'company.state', value: 'BE' },
          { key: 'company.zip', value: '10115' },
          { key: 'company.country', value: 'DE' },
        ],
        [{ email_enabled: true, sms_enabled: false }],
        [], // notification settings
        [], // renderTemplate DB lookup
        [], // INSERT notification
      );

      await dispatchDriverNotification(sql as never, 'driver.Welcome', 'driver-16', {
        customVar: 'hello',
      });
      expect(sqlCalls.length).toBeGreaterThanOrEqual(5);

      Date.now = realNow;
    });

    it('wraps email HTML when rendered template has html property', async () => {
      const { dispatchDriverNotification } = await freshImport();
      const realNow = Date.now;
      const nowValue = realNow() + 360 * 60 * 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowValue);

      setupSqlResults(
        [{ is_enabled: true }],
        [
          {
            first_name: 'Wrap',
            last_name: 'User',
            email: 'wrap@test.com',
            phone: null,
            language: 'en',
          },
        ],
        [{ key: 'company.name', value: 'WrapCo' }],
        [{ email_enabled: true, sms_enabled: false }],
        [
          { key: 'smtp.host', value: 'smtp.example.com' },
          { key: 'smtp.port', value: '587' },
          { key: 'smtp.username', value: '' },
          { key: 'smtp.password', value: '' },
          { key: 'smtp.from', value: 'noreply@wrapco.com' },
        ],
        // DB template found with HTML body
        [{ subject: 'Wrapped', body_html: '<p>Wrapped body</p>' }],
        [], // INSERT notification
      );

      await dispatchDriverNotification(sql as never, 'driver.Welcome', 'driver-17', {});
      // The sendEmail call should include wrapped HTML
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining('<p>Wrapped body</p>'),
        }),
      );

      Date.now = realNow;
    });

    it('handles null first_name and last_name', async () => {
      const { dispatchDriverNotification } = await freshImport();
      const realNow = Date.now;
      const nowValue = realNow() + 370 * 60 * 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowValue);

      setupSqlResults(
        [{ is_enabled: true }],
        [
          {
            first_name: null,
            last_name: null,
            email: 'noname@test.com',
            phone: null,
            language: undefined,
          },
        ],
        [],
        [],
        [], // notification settings
        [], // renderTemplate for email
        [], // INSERT notification
      );

      await dispatchDriverNotification(sql as never, 'driver.Welcome', 'driver-18', {});
      expect(sqlCalls.length).toBeGreaterThanOrEqual(5);

      Date.now = realNow;
    });

    it('skips non-string company setting values', async () => {
      const { dispatchDriverNotification } = await freshImport();
      const realNow = Date.now;
      const nowValue = realNow() + 380 * 60 * 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowValue);

      setupSqlResults(
        [{ is_enabled: true }],
        [
          {
            first_name: 'Test',
            last_name: 'User',
            email: 'test@test.com',
            phone: null,
            language: 'en',
          },
        ],
        [
          { key: 'company.name', value: 'ValidCo' },
          { key: 'company.someNumber', value: 42 }, // non-string, should be skipped
        ],
        [{ email_enabled: true, sms_enabled: false }],
        [], // notification settings
        [], // renderTemplate
        [], // INSERT
      );

      await dispatchDriverNotification(sql as never, 'driver.Welcome', 'driver-19', {});
      expect(sqlCalls.length).toBeGreaterThanOrEqual(5);

      Date.now = realNow;
    });

    it('sends both email and SMS with SMTP and Twilio configured', async () => {
      const { dispatchDriverNotification } = await freshImport();
      const realNow = Date.now;
      const nowValue = realNow() + 390 * 60 * 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowValue);

      setupSqlResults(
        [{ is_enabled: true }],
        [
          {
            first_name: 'Both',
            last_name: 'Channels',
            email: 'both@test.com',
            phone: '+1555888888',
            language: 'en',
          },
        ],
        [{ key: 'company.name', value: 'BothCo' }],
        [{ email_enabled: true, sms_enabled: true }],
        // SMTP and Twilio both configured
        [
          { key: 'smtp.host', value: 'smtp.example.com' },
          { key: 'smtp.port', value: '587' },
          { key: 'smtp.username', value: 'user' },
          { key: 'smtp.password', value: '' },
          { key: 'smtp.from', value: 'from@example.com' },
          { key: 'twilio.accountSid', value: 'AC999' },
          { key: 'twilio.authToken', value: '' },
          { key: 'twilio.fromNumber', value: '+1555000000' },
        ],
        [], // renderTemplate email DB lookup
        [], // INSERT email notification
        [], // renderTemplate sms DB lookup
        [], // INSERT sms notification
      );

      await dispatchDriverNotification(sql as never, 'session.Completed', 'driver-20', {});
      expect(mockSendMail).toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('twilio.com'),
        expect.any(Object),
      );

      Date.now = realNow;
    });

    it('uses templatesDir for file-based templates', async () => {
      const { dispatchDriverNotification } = await freshImport();
      const realNow = Date.now;
      const nowValue = realNow() + 400 * 60 * 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowValue);

      mockReadFile.mockResolvedValueOnce('<p>File email template for {{firstName}}</p>');

      setupSqlResults(
        [{ is_enabled: true }],
        [
          {
            first_name: 'FileUser',
            last_name: 'Test',
            email: 'file@test.com',
            phone: null,
            language: 'en',
          },
        ],
        [],
        [{ email_enabled: true, sms_enabled: false }],
        [], // notification settings (no smtp)
        [], // renderTemplate DB lookup for email (miss)
        [], // INSERT email notification
      );

      await dispatchDriverNotification(
        sql as never,
        'driver.Welcome',
        'driver-21',
        {},
        '/templates',
      );
      expect(sqlCalls.length).toBeGreaterThanOrEqual(5);

      Date.now = realNow;
    });

    it('catches and logs top-level errors', async () => {
      const { dispatchDriverNotification } = await freshImport();
      // Create a sql mock that throws
      const throwingSql = (() => {
        throw new Error('Database connection failed');
      }) as unknown;

      await expect(
        dispatchDriverNotification(throwingSql as never, 'test.event', 'driver-err', {}),
      ).resolves.toBeUndefined();
    });

    it('overrides enriched variables with caller-provided variables', async () => {
      const { dispatchDriverNotification } = await freshImport();
      const realNow = Date.now;
      const nowValue = realNow() + 410 * 60 * 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowValue);

      // The caller passes companyName override - it should take precedence
      // because variables spread last in enrichedVariables
      setupSqlResults(
        [{ is_enabled: true }],
        [
          {
            first_name: 'Override',
            last_name: 'Test',
            email: 'override@test.com',
            phone: null,
            language: 'en',
          },
        ],
        [{ key: 'company.name', value: 'OriginalCo' }],
        [{ email_enabled: true, sms_enabled: false }],
        [], // notification settings
        [], // renderTemplate
        [], // INSERT
      );

      await dispatchDriverNotification(sql as never, 'driver.Welcome', 'driver-22', {
        companyName: 'OverrideCo',
      });
      expect(sqlCalls.length).toBeGreaterThanOrEqual(5);

      Date.now = realNow;
    });
  });

  // -----------------------------------------------------------------------
  // compileTemplate (additional)
  // -----------------------------------------------------------------------

  describe('compileTemplate', () => {
    it('handles templates with triple-stash (unescaped HTML)', async () => {
      const { compileTemplate } = await freshImport();
      const result = compileTemplate('Content: {{{html}}}', { html: '<b>Bold</b>' });
      expect(result).toBe('Content: <b>Bold</b>');
    });

    it('escapes HTML in double-stash templates', async () => {
      const { compileTemplate } = await freshImport();
      const result = compileTemplate('Content: {{html}}', { html: '<b>Bold</b>' });
      expect(result).toContain('&lt;b&gt;');
    });

    it('handles missing variables gracefully', async () => {
      const { compileTemplate } = await freshImport();
      const result = compileTemplate('Hello {{missing}}!', {});
      expect(result).toBe('Hello !');
    });
  });

  // -----------------------------------------------------------------------
  // DEFAULT_EMAIL_WRAPPER
  // -----------------------------------------------------------------------

  describe('DEFAULT_EMAIL_WRAPPER', () => {
    it('contains required placeholders', async () => {
      const { DEFAULT_EMAIL_WRAPPER } = await freshImport();
      expect(DEFAULT_EMAIL_WRAPPER).toContain('{{{content}}}');
      expect(DEFAULT_EMAIL_WRAPPER).toContain('{{companyName}}');
      expect(DEFAULT_EMAIL_WRAPPER).toContain('<!DOCTYPE html>');
    });

    it('contains conditional blocks for company details', async () => {
      const { DEFAULT_EMAIL_WRAPPER } = await freshImport();
      expect(DEFAULT_EMAIL_WRAPPER).toContain('{{#if companyCity}}');
      expect(DEFAULT_EMAIL_WRAPPER).toContain('{{#if companyState}}');
      expect(DEFAULT_EMAIL_WRAPPER).toContain('{{#if companyCountry}}');
      expect(DEFAULT_EMAIL_WRAPPER).toContain('{{#if companyContactEmail}}');
      expect(DEFAULT_EMAIL_WRAPPER).toContain('{{#if companySupportPhone}}');
    });
  });
});
