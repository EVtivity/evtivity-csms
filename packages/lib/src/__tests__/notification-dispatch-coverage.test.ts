// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

const mockFetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('') });
vi.stubGlobal('fetch', mockFetch);

// --- SQL mock with .json (required by recordNotificationAttempt) ---

interface SqlCall {
  strings: TemplateStringsArray;
  values: unknown[];
}

const sqlCalls: SqlCall[] = [];
let sqlResults: unknown[][] = [];
let sqlCallIndex = 0;

function createSqlMock() {
  const sqlFn = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    sqlCalls.push({ strings, values });
    const result = sqlResults[sqlCallIndex] ?? [];
    sqlCallIndex++;
    return Promise.resolve(result);
  };
  // recordNotificationAttempt calls sql.json(metadata). Without this the
  // whole driver/system dispatch throws before any INSERT runs.
  sqlFn.json = (value: unknown) => value;
  return sqlFn as unknown;
}

function setupSqlResults(...results: unknown[][]) {
  sqlResults = results;
  sqlCallIndex = 0;
  sqlCalls.length = 0;
}

/** Every INSERT INTO notifications call captured during the dispatch. */
function notificationInserts(): SqlCall[] {
  return sqlCalls.filter((c) => c.strings.some((s) => s.includes('INSERT INTO notifications')));
}

/**
 * Decode one INSERT call into the fields recordNotificationAttempt interpolates.
 * The tagged template positions are:
 * channel, recipient, subject, body, status, eventType, <metadata via sql.json>.
 */
function decodeInsert(call: SqlCall): {
  channel: string;
  recipient: string;
  subject: string;
  body: string;
  status: string;
  eventType: string;
  metadata: Record<string, string>;
} {
  const [channel, recipient, subject, body, status, eventType, metadata] = call.values as [
    string,
    string,
    string,
    string,
    string,
    string,
    Record<string, string>,
  ];
  return { channel, recipient, subject, body, status, eventType, metadata };
}

function findInsert(channel: string): SqlCall | undefined {
  return notificationInserts().find((c) => decodeInsert(c).channel === channel);
}

// Advance the module's 60s settings cache past expiry so each test reads its
// own SQL-mocked settings instead of a sibling test's cached values.
let timeOffset = 0;
function advanceClock(): { restore: () => void } {
  const realNow = Date.now;
  timeOffset += 5 * 60 * 1000;
  const fixed = realNow() + timeOffset;
  vi.spyOn(Date, 'now').mockImplementation(() => fixed);
  return {
    restore: () => {
      Date.now = realNow;
    },
  };
}

describe('notification-dispatch (coverage: record/push/pubsub/system)', () => {
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
  // normalizeE164
  // -----------------------------------------------------------------------

  describe('normalizeE164', () => {
    it('keeps an already-+-prefixed number after stripping punctuation', async () => {
      const { normalizeE164 } = await import('../notification-dispatch.js');
      expect(normalizeE164('+1 (555) 123-4567')).toBe('+15551234567');
    });

    it('prepends +1 to a bare 10-digit US number', async () => {
      const { normalizeE164 } = await import('../notification-dispatch.js');
      expect(normalizeE164('555.123.4567')).toBe('+15551234567');
    });

    it('prepends + to an 11-digit number that starts with 1', async () => {
      const { normalizeE164 } = await import('../notification-dispatch.js');
      expect(normalizeE164('1 555 123 4567')).toBe('+15551234567');
    });

    it('returns punctuation-stripped value for non-US-shaped numbers', async () => {
      const { normalizeE164 } = await import('../notification-dispatch.js');
      expect(normalizeE164('00 44 20 7946 0958')).toBe('00442079460958');
    });
  });

  // -----------------------------------------------------------------------
  // wrapEmailHtml — bad custom template falls back to default wrapper
  // -----------------------------------------------------------------------

  describe('wrapEmailHtml fallback', () => {
    it('falls back to default wrapper when custom template fails to compile', async () => {
      const { wrapEmailHtml } = await import('../notification-dispatch.js');
      // Unclosed Handlebars block expression throws at compile time.
      const result = wrapEmailHtml('<p>Body</p>', 'Acme', '{{#if open}}no close');
      // Default wrapper used: body content present and DOCTYPE shell rendered.
      expect(result).toContain('<p>Body</p>');
      expect(result).toContain('Acme');
      expect(result).toContain('<!DOCTYPE html>');
    });
  });

  // -----------------------------------------------------------------------
  // clearNotificationSettingsCache
  // -----------------------------------------------------------------------

  describe('clearNotificationSettingsCache', () => {
    it('forces the next getNotificationSettings to re-read from the database', async () => {
      const { getNotificationSettings, clearNotificationSettingsCache } =
        await import('../notification-dispatch.js');
      const clock = advanceClock();

      setupSqlResults([{ key: 'smtp.host', value: 'first.example.com' }]);
      const first = await getNotificationSettings(sql as never);
      expect(first.smtp!.host).toBe('first.example.com');

      // Without clearing, a second read within TTL would be cached.
      clearNotificationSettingsCache();

      setupSqlResults([{ key: 'smtp.host', value: 'second.example.com' }]);
      const second = await getNotificationSettings(sql as never);
      expect(second.smtp!.host).toBe('second.example.com');

      clock.restore();
    });
  });

  // -----------------------------------------------------------------------
  // getSystemTimezoneCached
  // -----------------------------------------------------------------------

  describe('getSystemTimezoneCached', () => {
    it('reads the configured value and caches it on the second call', async () => {
      const { getSystemTimezoneCached, clearNotificationSettingsCache } =
        await import('../notification-dispatch.js');
      const clock = advanceClock();
      clearNotificationSettingsCache();

      setupSqlResults([{ value: 'Europe/Berlin' }]);
      const tz = await getSystemTimezoneCached(sql as never);
      expect(tz).toBe('Europe/Berlin');
      expect(sqlCalls.length).toBe(1);

      // Second call within TTL returns cached value without a new query.
      setupSqlResults([{ value: 'Asia/Tokyo' }]);
      const cached = await getSystemTimezoneCached(sql as never);
      expect(cached).toBe('Europe/Berlin');
      expect(sqlCalls.length).toBe(0);

      clock.restore();
    });

    it('falls back to America/New_York when no row is configured', async () => {
      const { getSystemTimezoneCached, clearNotificationSettingsCache } =
        await import('../notification-dispatch.js');
      const clock = advanceClock();
      clearNotificationSettingsCache();

      setupSqlResults([]); // no settings row
      const tz = await getSystemTimezoneCached(sql as never);
      expect(tz).toBe('America/New_York');

      clock.restore();
    });
  });

  // -----------------------------------------------------------------------
  // loadTemplateFile — cache hit
  // -----------------------------------------------------------------------

  describe('loadTemplateFile cache', () => {
    it('returns cached content on the second call without re-reading the file', async () => {
      const { loadTemplateFile } = await import('../notification-dispatch.js');
      const uniquePath = `/cache-hit-${String(Date.now())}-${String(Math.random())}.hbs`;
      mockReadFile.mockResolvedValueOnce('<p>Cached body</p>');

      const first = await loadTemplateFile(uniquePath);
      expect(first).toBe('<p>Cached body</p>');
      expect(mockReadFile).toHaveBeenCalledTimes(1);

      // Second read hits the in-process cache; readFile is not called again.
      const second = await loadTemplateFile(uniquePath);
      expect(second).toBe('<p>Cached body</p>');
      expect(mockReadFile).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // sendWebhook — private URL block and timeout abort
  // -----------------------------------------------------------------------

  describe('sendWebhook edge cases', () => {
    it('blocks delivery to a private/internal URL without calling fetch', async () => {
      const { sendWebhook } = await import('../notification-dispatch.js');
      const result = await sendWebhook('http://127.0.0.1/hook', 'Sub', 'Body', {});
      expect(result).toBe('blocked_private_url');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns timeout when the request aborts', async () => {
      const { sendWebhook } = await import('../notification-dispatch.js');
      const abortErr = new Error('The operation was aborted');
      abortErr.name = 'AbortError';
      mockFetch.mockRejectedValueOnce(abortErr);
      const result = await sendWebhook('https://hook.example.com', 'Sub', 'Body', {});
      expect(result).toBe('timeout');
    });

    it('aborts the controller via the 10s timer and returns timeout', async () => {
      vi.useFakeTimers();
      const { sendWebhook } = await import('../notification-dispatch.js');

      // fetch resolves only when its abort signal fires, so advancing the
      // fake clock past 10s triggers the setTimeout callback -> controller.abort().
      mockFetch.mockImplementationOnce(
        (_url: string, opts: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () => {
              const err = new Error('This operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      );

      const promise = sendWebhook('https://hook.example.com', 'Sub', 'Body', {});
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await promise;
      expect(result).toBe('timeout');

      vi.useRealTimers();
    });
  });

  // -----------------------------------------------------------------------
  // renderTemplate — array of template dirs
  // -----------------------------------------------------------------------

  describe('renderTemplate array templatesDir', () => {
    it('searches multiple directories and uses the first dir that has the template', async () => {
      const { renderTemplate } = await import('../notification-dispatch.js');
      setupSqlResults([]); // DB miss for 'en'
      mockReadFile.mockResolvedValueOnce('<p>From first dir {{companyName}}</p>');

      const result = await renderTemplate(
        'email',
        'test.event',
        'en',
        { companyName: 'ArrCo' },
        sql as never,
        undefined,
        ['/templates-a', '/templates-b'],
      );

      expect(result.body).toBe('<p>From first dir ArrCo</p>');
      expect(result.html).toBe('<p>From first dir ArrCo</p>');
    });

    it('falls through to the second directory when the first misses', async () => {
      const { renderTemplate } = await import('../notification-dispatch.js');
      setupSqlResults([]); // DB miss for 'en'
      // first dir miss, second dir hit
      mockReadFile
        .mockRejectedValueOnce(new Error('ENOENT'))
        .mockResolvedValueOnce('<p>From second dir</p>');

      const result = await renderTemplate(
        'email',
        'test.event',
        'en',
        { companyName: 'ArrCo' },
        sql as never,
        undefined,
        ['/templates-miss', '/templates-hit'],
      );

      expect(result.body).toBe('<p>From second dir</p>');
    });
  });

  // -----------------------------------------------------------------------
  // recordNotificationAttempt
  // -----------------------------------------------------------------------

  describe('recordNotificationAttempt', () => {
    it('inserts a row with all fields and json-encoded metadata', async () => {
      const { recordNotificationAttempt } = await import('../notification-dispatch.js');
      setupSqlResults([]);

      await recordNotificationAttempt(sql as never, {
        channel: 'email',
        recipient: 'to@test.com',
        subject: 'Sub',
        body: 'Body',
        status: 'sent',
        eventType: 'session.Started',
        metadata: { driverId: 'drv_1', failureReason: 'none' },
      });

      const inserts = notificationInserts();
      expect(inserts).toHaveLength(1);
      const decoded = decodeInsert(inserts[0]!);
      expect(decoded.channel).toBe('email');
      expect(decoded.recipient).toBe('to@test.com');
      expect(decoded.subject).toBe('Sub');
      expect(decoded.body).toBe('Body');
      expect(decoded.status).toBe('sent');
      expect(decoded.eventType).toBe('session.Started');
      expect(decoded.metadata).toEqual({ driverId: 'drv_1', failureReason: 'none' });
    });
  });

  // -----------------------------------------------------------------------
  // dispatchDriverNotification — push row + pubsub + recorded sends
  // -----------------------------------------------------------------------

  describe('dispatchDriverNotification push + pubsub', () => {
    it('records email sent, sms sent, and push rows when both channels configured', async () => {
      const { dispatchDriverNotification } = await import('../notification-dispatch.js');
      const clock = advanceClock();

      setupSqlResults(
        [{ is_enabled: true }], // driver_event_settings
        [
          {
            first_name: 'Both',
            last_name: 'Channels',
            email: 'both@test.com',
            phone: '+15551234567',
            language: 'en',
            timezone: 'UTC',
          },
        ], // drivers
        [{ email_enabled: true, sms_enabled: true }], // prefs
        [{ key: 'company.name', value: 'BothCo' }], // company.*
        [
          { key: 'smtp.host', value: 'smtp.example.com' },
          { key: 'smtp.port', value: '587' },
          { key: 'smtp.username', value: 'user' },
          { key: 'smtp.passwordEnc', value: '' },
          { key: 'smtp.from', value: 'from@example.com' },
          { key: 'twilio.accountSid', value: 'AC999' },
          { key: 'twilio.authTokenEnc', value: '' },
          { key: 'twilio.fromNumber', value: '+15550000000' },
        ], // settings
        [], // email DB template miss
        [], // INSERT email
        [], // sms DB template miss
        [], // INSERT sms
        [], // INSERT push
      );

      await dispatchDriverNotification(sql as never, 'session.Completed', 'drv_99', {
        stationId: 'CS-1',
      });

      expect(mockSendMail).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('twilio.com'),
        expect.objectContaining({ method: 'POST' }),
      );

      const email = decodeInsert(findInsert('email')!);
      expect(email.status).toBe('sent');
      expect(email.recipient).toBe('both@test.com');
      expect(email.metadata).toEqual({ driverId: 'drv_99' });

      const smsRow = decodeInsert(findInsert('sms')!);
      expect(smsRow.status).toBe('sent');
      expect(smsRow.recipient).toBe('+15551234567');

      const push = decodeInsert(findInsert('push')!);
      expect(push.status).toBe('sent');
      expect(push.recipient).toBe('drv_99');
      // push body is JSON { title, message }
      const parsed = JSON.parse(push.body) as { title: string; message: string };
      expect(parsed).toHaveProperty('title');
      expect(parsed).toHaveProperty('message');

      clock.restore();
    });

    it('publishes notification.created to portal_events when pubsub provided', async () => {
      const { dispatchDriverNotification } = await import('../notification-dispatch.js');
      const clock = advanceClock();
      const publish = vi.fn().mockResolvedValue(undefined);
      const pubsub = { publish } as unknown as import('../pubsub.js').PubSubClient;

      setupSqlResults(
        [{ is_enabled: true }],
        [
          {
            first_name: 'Pub',
            last_name: 'Sub',
            email: 'pub@test.com',
            phone: null,
            language: 'en',
            timezone: 'UTC',
          },
        ],
        [{ email_enabled: false, sms_enabled: false }],
        [{ key: 'company.name', value: 'PubCo' }],
        [], // settings: nothing configured
        [], // sms DB template miss (rendered for push)
        [], // INSERT push
      );

      await dispatchDriverNotification(
        sql as never,
        'session.Started',
        'drv_pub',
        {},
        undefined,
        pubsub,
      );

      expect(publish).toHaveBeenCalledWith(
        'portal_events',
        JSON.stringify({ type: 'notification.created', driverId: 'drv_pub' }),
      );
      // push row still written even with both channels disabled
      expect(findInsert('push')).toBeDefined();

      clock.restore();
    });

    it('swallows pubsub publish failure and still completes (fail-open)', async () => {
      const { dispatchDriverNotification } = await import('../notification-dispatch.js');
      const clock = advanceClock();
      const publish = vi.fn().mockRejectedValue(new Error('redis down'));
      const pubsub = { publish } as unknown as import('../pubsub.js').PubSubClient;

      setupSqlResults(
        [{ is_enabled: true }],
        [
          {
            first_name: 'Fail',
            last_name: 'Pub',
            email: null,
            phone: null,
            language: 'en',
            timezone: 'UTC',
          },
        ],
        [{ email_enabled: false, sms_enabled: false }],
        [{ key: 'company.name', value: 'FailPubCo' }],
        [],
        [], // sms render miss
        [], // INSERT push
      );

      await expect(
        dispatchDriverNotification(
          sql as never,
          'session.Started',
          'drv_failpub',
          {},
          undefined,
          pubsub,
        ),
      ).resolves.toBeUndefined();

      expect(publish).toHaveBeenCalled();
      // push row was recorded before the publish attempt
      expect(findInsert('push')).toBeDefined();

      clock.restore();
    });

    it('records email failure reason smtp_send_failed when send rejects', async () => {
      const { dispatchDriverNotification } = await import('../notification-dispatch.js');
      const clock = advanceClock();
      mockSendMail.mockRejectedValueOnce(new Error('connection refused'));

      setupSqlResults(
        [{ is_enabled: true }],
        [
          {
            first_name: 'Fail',
            last_name: 'Mail',
            email: 'fail@test.com',
            phone: null,
            language: 'en',
            timezone: 'UTC',
          },
        ],
        [{ email_enabled: true, sms_enabled: false }],
        [{ key: 'company.name', value: 'FailMailCo' }],
        [
          { key: 'smtp.host', value: 'smtp.example.com' },
          { key: 'smtp.port', value: '587' },
          { key: 'smtp.username', value: 'user' },
          { key: 'smtp.passwordEnc', value: '' },
          { key: 'smtp.from', value: 'from@example.com' },
        ],
        [], // email DB template miss
        [], // INSERT email
        [], // sms render miss (for push)
        [], // INSERT push
      );

      await dispatchDriverNotification(sql as never, 'driver.Welcome', 'drv_failmail', {});

      const email = decodeInsert(findInsert('email')!);
      expect(email.status).toBe('failed');
      expect(email.metadata['failureReason']).toBe('smtp_send_failed');

      clock.restore();
    });

    it('records sms failure reason twilio_send_failed when Twilio returns non-2xx', async () => {
      const { dispatchDriverNotification } = await import('../notification-dispatch.js');
      const clock = advanceClock();
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve('Twilio error'),
      });

      setupSqlResults(
        [{ is_enabled: true }],
        [
          {
            first_name: 'Fail',
            last_name: 'Sms',
            email: null,
            phone: '+15559998888',
            language: 'en',
            timezone: 'UTC',
          },
        ],
        [{ email_enabled: false, sms_enabled: true }],
        [{ key: 'company.name', value: 'FailSmsCo' }],
        [
          { key: 'twilio.accountSid', value: 'AC999' },
          { key: 'twilio.authTokenEnc', value: '' },
          { key: 'twilio.fromNumber', value: '+15550000000' },
        ],
        [], // sms DB template miss
        [], // INSERT sms
        [], // INSERT push
      );

      await dispatchDriverNotification(sql as never, 'session.Completed', 'drv_failsms', {});

      const smsRow = decodeInsert(findInsert('sms')!);
      expect(smsRow.status).toBe('failed');
      expect(smsRow.metadata['failureReason']).toBe('twilio_send_failed');

      clock.restore();
    });

    it('records credentials_decrypt_failed when SMTP creds failed to decrypt and send fails', async () => {
      const { dispatchDriverNotification } = await import('../notification-dispatch.js');
      const clock = advanceClock();
      process.env['SETTINGS_ENCRYPTION_KEY'] = 'a-key';
      mockSendMail.mockRejectedValueOnce(new Error('auth failed'));

      setupSqlResults(
        [{ is_enabled: true }],
        [
          {
            first_name: 'Cred',
            last_name: 'Fail',
            email: 'cred@test.com',
            phone: null,
            language: 'en',
            timezone: 'UTC',
          },
        ],
        [{ email_enabled: true, sms_enabled: false }],
        [{ key: 'company.name', value: 'CredCo' }],
        [
          { key: 'smtp.host', value: 'smtp.example.com' },
          { key: 'smtp.port', value: '587' },
          { key: 'smtp.username', value: 'user' },
          { key: 'smtp.passwordEnc', value: 'not-valid-ciphertext' }, // decrypt fails -> credentialError
          { key: 'smtp.from', value: 'from@example.com' },
        ],
        [], // email DB template miss
        [], // INSERT email
        [], // sms render miss (push)
        [], // INSERT push
      );

      await dispatchDriverNotification(sql as never, 'driver.Welcome', 'drv_cred', {});

      const email = decodeInsert(findInsert('email')!);
      expect(email.status).toBe('failed');
      expect(email.metadata['failureReason']).toBe('credentials_decrypt_failed');

      delete process.env['SETTINGS_ENCRYPTION_KEY'];
      clock.restore();
    });

    it('records credentials_decrypt_failed when Twilio creds failed to decrypt and send fails', async () => {
      const { dispatchDriverNotification } = await import('../notification-dispatch.js');
      const clock = advanceClock();
      process.env['SETTINGS_ENCRYPTION_KEY'] = 'a-key';
      mockFetch.mockRejectedValueOnce(new Error('auth failed'));

      setupSqlResults(
        [{ is_enabled: true }],
        [
          {
            first_name: 'Cred',
            last_name: 'Sms',
            email: null,
            phone: '+15551230000',
            language: 'en',
            timezone: 'UTC',
          },
        ],
        [{ email_enabled: false, sms_enabled: true }],
        [{ key: 'company.name', value: 'CredSmsCo' }],
        [
          { key: 'twilio.accountSid', value: 'AC123' },
          { key: 'twilio.authTokenEnc', value: 'not-valid-ciphertext' }, // decrypt fails
          { key: 'twilio.fromNumber', value: '+15550000000' },
        ],
        [], // sms DB template miss
        [], // INSERT sms
        [], // INSERT push
      );

      await dispatchDriverNotification(sql as never, 'session.Completed', 'drv_credsms', {});

      const smsRow = decodeInsert(findInsert('sms')!);
      expect(smsRow.status).toBe('failed');
      expect(smsRow.metadata['failureReason']).toBe('credentials_decrypt_failed');

      delete process.env['SETTINGS_ENCRYPTION_KEY'];
      clock.restore();
    });

    it('redacts a 6-digit code in the push body for sensitive event types', async () => {
      const { dispatchDriverNotification } = await import('../notification-dispatch.js');
      const clock = advanceClock();

      setupSqlResults(
        [{ is_enabled: true }],
        [
          {
            first_name: 'Mfa',
            last_name: 'User',
            email: null,
            phone: null,
            language: 'en',
            timezone: 'UTC',
          },
        ],
        [{ email_enabled: false, sms_enabled: false }],
        [{ key: 'company.name', value: 'SecureCo' }],
        [],
        // sms DB template carrying a 6-digit code, used for the push render
        [{ subject: 'Your code', body_html: 'Your code is 123456 now' }],
        [], // INSERT push
      );

      await dispatchDriverNotification(sql as never, 'mfa.VerificationCode', 'drv_mfa', {});

      const push = decodeInsert(findInsert('push')!);
      const parsed = JSON.parse(push.body) as { message: string };
      expect(parsed.message).toContain('<redacted>');
      expect(parsed.message).not.toContain('123456');

      clock.restore();
    });
  });

  // -----------------------------------------------------------------------
  // dispatchSystemNotification
  // -----------------------------------------------------------------------

  describe('dispatchSystemNotification', () => {
    it('skips entirely when system event type is disabled', async () => {
      const { dispatchSystemNotification } = await import('../notification-dispatch.js');
      setupSqlResults([{ is_enabled: false }]);

      await dispatchSystemNotification(
        sql as never,
        'operator.ForgotPassword',
        { email: 'op@test.com' },
        {},
      );

      // only the system_event_settings SELECT ran, no INSERTs
      expect(sqlCalls.length).toBe(1);
      expect(notificationInserts()).toHaveLength(0);
    });

    it('sends email + sms when both configured and records sent rows', async () => {
      const { dispatchSystemNotification } = await import('../notification-dispatch.js');
      const clock = advanceClock();

      setupSqlResults(
        [{ is_enabled: true }], // system_event_settings
        [{ key: 'company.name', value: 'SysCo' }], // company.*
        [
          { key: 'smtp.host', value: 'smtp.example.com' },
          { key: 'smtp.port', value: '587' },
          { key: 'smtp.username', value: 'user' },
          { key: 'smtp.passwordEnc', value: '' },
          { key: 'smtp.from', value: 'from@example.com' },
          { key: 'twilio.accountSid', value: 'AC123' },
          { key: 'twilio.authTokenEnc', value: '' },
          { key: 'twilio.fromNumber', value: '+15550000000' },
        ], // settings
        [], // email DB template miss
        [], // INSERT email
        [], // sms DB template miss
        [], // INSERT sms
      );

      await dispatchSystemNotification(
        sql as never,
        'operator.ForgotPassword',
        {
          email: 'op@test.com',
          phone: '+15551112222',
          firstName: 'Op',
          lastName: 'Erator',
          language: 'en',
          timezone: 'UTC',
        },
        { resetUrl: 'https://x' },
      );

      expect(mockSendMail).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('twilio.com'),
        expect.objectContaining({ method: 'POST' }),
      );

      const email = decodeInsert(findInsert('email')!);
      expect(email.status).toBe('sent');
      expect(email.recipient).toBe('op@test.com');

      const smsRow = decodeInsert(findInsert('sms')!);
      expect(smsRow.status).toBe('sent');
      expect(smsRow.recipient).toBe('+15551112222');

      clock.restore();
    });

    it('records recipient_missing when email and phone are absent', async () => {
      const { dispatchSystemNotification } = await import('../notification-dispatch.js');
      const clock = advanceClock();

      setupSqlResults(
        [{ is_enabled: true }],
        [{ key: 'company.name', value: 'SysCo' }],
        [], // settings: nothing configured
        [], // INSERT email
        [], // INSERT sms
      );

      await dispatchSystemNotification(sql as never, 'operator.PasswordChanged', {}, {});

      expect(mockSendMail).not.toHaveBeenCalled();
      const email = decodeInsert(findInsert('email')!);
      expect(email.status).toBe('failed');
      expect(email.metadata['failureReason']).toBe('recipient_missing');
      expect(email.recipient).toBe('');

      const smsRow = decodeInsert(findInsert('sms')!);
      expect(smsRow.metadata['failureReason']).toBe('recipient_missing');

      clock.restore();
    });

    it('records smtp_not_configured / twilio_not_configured when settings missing but recipient present', async () => {
      const { dispatchSystemNotification } = await import('../notification-dispatch.js');
      const clock = advanceClock();

      setupSqlResults(
        [{ is_enabled: true }],
        [{ key: 'company.name', value: 'SysCo' }],
        [], // settings: nothing configured
        [], // INSERT email
        [], // INSERT sms
      );

      await dispatchSystemNotification(
        sql as never,
        'operator.PasswordChanged',
        { email: 'op@test.com', phone: '+15551112222' },
        {},
      );

      const email = decodeInsert(findInsert('email')!);
      expect(email.metadata['failureReason']).toBe('smtp_not_configured');
      const smsRow = decodeInsert(findInsert('sms')!);
      expect(smsRow.metadata['failureReason']).toBe('twilio_not_configured');

      clock.restore();
    });

    it('skips SMS row entirely when operator opted out (sms_enabled=false)', async () => {
      const { dispatchSystemNotification } = await import('../notification-dispatch.js');
      const clock = advanceClock();

      setupSqlResults(
        [{ is_enabled: true }], // system_event_settings
        [{ key: 'company.name', value: 'SysCo' }], // company
        [], // settings (no smtp/twilio)
        [], // INSERT email
        [{ sms_enabled: false }], // user_notification_preferences opt-out
      );

      await dispatchSystemNotification(
        sql as never,
        'operator.PasswordChanged',
        { email: 'op@test.com', phone: '+15551112222', userId: 'usr_1' },
        {},
      );

      // email row written, but no sms row because the operator opted out
      expect(findInsert('email')).toBeDefined();
      expect(findInsert('sms')).toBeUndefined();

      clock.restore();
    });

    it('keeps SMS enabled when userId is set but no preference row exists', async () => {
      const { dispatchSystemNotification } = await import('../notification-dispatch.js');
      const clock = advanceClock();

      setupSqlResults(
        [{ is_enabled: true }],
        [{ key: 'company.name', value: 'SysCo' }],
        [
          { key: 'twilio.accountSid', value: 'AC123' },
          { key: 'twilio.authTokenEnc', value: '' },
          { key: 'twilio.fromNumber', value: '+15550000000' },
        ],
        [], // INSERT email (recipient_missing)
        [], // user_notification_preferences: no row -> stays default enabled
        [], // sms DB template miss
        [], // INSERT sms
      );

      await dispatchSystemNotification(
        sql as never,
        'operator.PasswordChanged',
        { phone: '+15551112222', userId: 'usr_norow' },
        {},
      );

      // SMS still sent because the missing pref row defaults to enabled.
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('twilio.com'),
        expect.objectContaining({ method: 'POST' }),
      );
      expect(findInsert('sms')).toBeDefined();

      clock.restore();
    });

    it('keeps SMS path when user pref row says sms_enabled=true', async () => {
      const { dispatchSystemNotification } = await import('../notification-dispatch.js');
      const clock = advanceClock();

      setupSqlResults(
        [{ is_enabled: true }],
        [{ key: 'company.name', value: 'SysCo' }],
        [
          { key: 'twilio.accountSid', value: 'AC123' },
          { key: 'twilio.authTokenEnc', value: '' },
          { key: 'twilio.fromNumber', value: '+15550000000' },
        ],
        [], // INSERT email
        [{ sms_enabled: true }], // user pref: SMS allowed
        [], // sms DB template miss
        [], // INSERT sms
      );

      await dispatchSystemNotification(
        sql as never,
        'operator.PasswordChanged',
        { email: 'op@test.com', phone: '+15551112222', userId: 'usr_2' },
        {},
      );

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('twilio.com'),
        expect.objectContaining({ method: 'POST' }),
      );
      const smsRow = decodeInsert(findInsert('sms')!);
      expect(smsRow.status).toBe('sent');

      clock.restore();
    });

    it('records smtp_send_failed when system email send rejects', async () => {
      const { dispatchSystemNotification } = await import('../notification-dispatch.js');
      const clock = advanceClock();
      mockSendMail.mockRejectedValueOnce(new Error('smtp down'));

      setupSqlResults(
        [{ is_enabled: true }],
        [{ key: 'company.name', value: 'SysCo' }],
        [
          { key: 'smtp.host', value: 'smtp.example.com' },
          { key: 'smtp.port', value: '587' },
          { key: 'smtp.username', value: 'user' },
          { key: 'smtp.passwordEnc', value: '' },
          { key: 'smtp.from', value: 'from@example.com' },
        ],
        [], // email DB template miss
        [], // INSERT email
      );

      await dispatchSystemNotification(
        sql as never,
        'operator.PasswordChanged',
        { email: 'op@test.com' },
        {},
      );

      const email = decodeInsert(findInsert('email')!);
      expect(email.status).toBe('failed');
      expect(email.metadata['failureReason']).toBe('smtp_send_failed');

      clock.restore();
    });

    it('records twilio_send_failed when system SMS send rejects', async () => {
      const { dispatchSystemNotification } = await import('../notification-dispatch.js');
      const clock = advanceClock();
      mockFetch.mockRejectedValueOnce(new Error('twilio down'));

      setupSqlResults(
        [{ is_enabled: true }],
        [{ key: 'company.name', value: 'SysCo' }],
        [
          { key: 'twilio.accountSid', value: 'AC123' },
          { key: 'twilio.authTokenEnc', value: '' },
          { key: 'twilio.fromNumber', value: '+15550000000' },
        ],
        [], // INSERT email (recipient_missing, no email provided)
        [], // sms DB template miss
        [], // INSERT sms
      );

      await dispatchSystemNotification(
        sql as never,
        'operator.PasswordChanged',
        { phone: '+15551112222' },
        {},
      );

      const smsRow = decodeInsert(findInsert('sms')!);
      expect(smsRow.status).toBe('failed');
      expect(smsRow.metadata['failureReason']).toBe('twilio_send_failed');

      clock.restore();
    });

    it('records credentials_decrypt_failed for system email when creds bad and send fails', async () => {
      const { dispatchSystemNotification } = await import('../notification-dispatch.js');
      const clock = advanceClock();
      process.env['SETTINGS_ENCRYPTION_KEY'] = 'a-key';
      mockSendMail.mockRejectedValueOnce(new Error('auth failed'));

      setupSqlResults(
        [{ is_enabled: true }],
        [{ key: 'company.name', value: 'SysCredCo' }],
        [
          { key: 'smtp.host', value: 'smtp.example.com' },
          { key: 'smtp.port', value: '587' },
          { key: 'smtp.username', value: 'user' },
          { key: 'smtp.passwordEnc', value: 'not-valid-ciphertext' },
          { key: 'smtp.from', value: 'from@example.com' },
        ],
        [], // email DB template miss
        [], // INSERT email
      );

      await dispatchSystemNotification(
        sql as never,
        'operator.PasswordChanged',
        { email: 'op@test.com' },
        {},
      );

      const email = decodeInsert(findInsert('email')!);
      expect(email.metadata['failureReason']).toBe('credentials_decrypt_failed');

      delete process.env['SETTINGS_ENCRYPTION_KEY'];
      clock.restore();
    });

    it('records credentials_decrypt_failed for system SMS when creds bad and send fails', async () => {
      const { dispatchSystemNotification } = await import('../notification-dispatch.js');
      const clock = advanceClock();
      process.env['SETTINGS_ENCRYPTION_KEY'] = 'a-key';
      mockFetch.mockRejectedValueOnce(new Error('auth failed'));

      setupSqlResults(
        [{ is_enabled: true }],
        [{ key: 'company.name', value: 'SysCredSmsCo' }],
        [
          { key: 'twilio.accountSid', value: 'AC123' },
          { key: 'twilio.authTokenEnc', value: 'not-valid-ciphertext' },
          { key: 'twilio.fromNumber', value: '+15550000000' },
        ],
        [], // INSERT email (recipient_missing)
        [], // sms DB template miss
        [], // INSERT sms
      );

      await dispatchSystemNotification(
        sql as never,
        'operator.PasswordChanged',
        { phone: '+15551112222' },
        {},
      );

      const smsRow = decodeInsert(findInsert('sms')!);
      expect(smsRow.metadata['failureReason']).toBe('credentials_decrypt_failed');

      delete process.env['SETTINGS_ENCRYPTION_KEY'];
      clock.restore();
    });

    it('wraps system email HTML when the rendered template has html', async () => {
      const { dispatchSystemNotification } = await import('../notification-dispatch.js');
      const clock = advanceClock();

      setupSqlResults(
        [{ is_enabled: true }],
        [{ key: 'company.name', value: 'WrapSysCo' }],
        [
          { key: 'smtp.host', value: 'smtp.example.com' },
          { key: 'smtp.port', value: '587' },
          { key: 'smtp.username', value: '' },
          { key: 'smtp.passwordEnc', value: '' },
          { key: 'smtp.from', value: 'from@example.com' },
          { key: 'email.wrapperTemplate', value: '<wrap>{{companyName}}:{{{content}}}</wrap>' },
        ],
        [{ subject: 'Hello', body_html: '<p>System body</p>' }], // email DB template
        [], // INSERT email
      );

      await dispatchSystemNotification(
        sql as never,
        'operator.PasswordChanged',
        { email: 'op@test.com' },
        {},
      );

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: '<wrap>WrapSysCo:<p>System body</p></wrap>',
        }),
      );

      clock.restore();
    });

    it('uses default timezone and en language when omitted', async () => {
      const { dispatchSystemNotification } = await import('../notification-dispatch.js');
      const clock = advanceClock();

      setupSqlResults(
        [{ is_enabled: true }],
        [{ key: 'company.name', value: 'SysCo' }],
        [], // settings
        [], // INSERT email
        [], // INSERT sms
      );

      await dispatchSystemNotification(
        sql as never,
        'operator.PasswordChanged',
        { email: 'op@test.com', phone: '+15551112222' },
        { occurredAt: '2026-01-01T00:00:00.000Z' },
      );

      // No throw, rows recorded with default behavior
      expect(findInsert('email')).toBeDefined();
      expect(findInsert('sms')).toBeDefined();

      clock.restore();
    });

    it('proceeds when no system_event_settings row exists (defaults enabled)', async () => {
      const { dispatchSystemNotification } = await import('../notification-dispatch.js');
      const clock = advanceClock();

      setupSqlResults(
        [], // system_event_settings: no row -> proceed
        [{ key: 'company.name', value: 'SysCo' }],
        [], // settings
        [], // INSERT email
        [], // INSERT sms
      );

      await dispatchSystemNotification(
        sql as never,
        'operator.PasswordChanged',
        { email: 'op@test.com', phone: '+15551112222' },
        {},
      );

      expect(notificationInserts().length).toBeGreaterThanOrEqual(2);

      clock.restore();
    });

    it('catches and swallows top-level errors (fail-open)', async () => {
      const { dispatchSystemNotification } = await import('../notification-dispatch.js');
      const throwingSql = (() => {
        throw new Error('db down');
      }) as unknown;

      await expect(
        dispatchSystemNotification(
          throwingSql as never,
          'operator.PasswordChanged',
          { email: 'op@test.com' },
          {},
        ),
      ).resolves.toBeUndefined();
    });
  });
});
