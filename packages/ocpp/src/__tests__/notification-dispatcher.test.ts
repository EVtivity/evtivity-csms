// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import type { DomainEvent } from '@evtivity/lib';

const mockGetNotificationSettings = vi.fn();
const mockResolveRecipients = vi.fn();
const mockRenderTemplate = vi.fn();
const mockSendEmail = vi.fn();
const mockSendWebhook = vi.fn();
const mockLogNotification = vi.fn();
const mockWrapEmailHtml = vi.fn();
const mockDispatchDriverNotification = vi.fn();
const mockRecordNotificationAttempt = vi.fn();
const mockClearContractValidationCaCache = vi.fn();
const mockClearStationMessageCache = vi.fn();
const mockClearStationMessageSettingsCache = vi.fn();
const mockGetWebhookAllowedPrivateHosts = vi.fn().mockResolvedValue([]);

vi.mock('@evtivity/database', () => ({
  clearStationMessageSettingsCache: () => {
    mockClearStationMessageSettingsCache();
  },
  getWebhookAllowedPrivateHosts: () => mockGetWebhookAllowedPrivateHosts(),
}));
const mockClearLocalContractCaCache = vi.fn();
const mockClearOemTrustCache = vi.fn();

vi.mock('../services/pki/contract-certificate-validation.js', () => ({
  clearContractValidationCaCache: () => {
    mockClearContractValidationCaCache();
  },
}));

vi.mock('../services/pki/local-ca-store.js', () => ({
  clearLocalContractCaCache: () => {
    mockClearLocalContractCaCache();
  },
}));

vi.mock('../services/pki/local-contract-provider.js', () => ({
  clearOemTrustCache: () => {
    mockClearOemTrustCache();
  },
}));

vi.mock('@evtivity/lib', async () => {
  const actual = await vi.importActual<typeof import('@evtivity/lib')>('@evtivity/lib');
  return {
    ...actual,
    getNotificationSettings: mockGetNotificationSettings,
    resolveRecipients: mockResolveRecipients,
    renderTemplate: mockRenderTemplate,
    sendEmail: mockSendEmail,
    sendWebhook: mockSendWebhook,
    logNotification: mockLogNotification,
    wrapEmailHtml: mockWrapEmailHtml,
    recordNotificationAttempt: mockRecordNotificationAttempt,
    dispatchDriverNotification: mockDispatchDriverNotification,
    clearStationMessageCache: () => {
      mockClearStationMessageCache();
    },
    createLogger: () => ({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    }),
  };
});

// SQL mock - tracks calls and returns sequential results
const sqlCalls: unknown[][] = [];
let sqlResults: unknown[][] = [];
let sqlCallIndex = 0;

vi.mock('postgres', () => {
  const factory = () => {
    const fn = (_strings: TemplateStringsArray, ...values: unknown[]) => {
      sqlCalls.push(values);
      const result = sqlResults[sqlCallIndex] ?? [];
      sqlCallIndex++;
      return Promise.resolve(result);
    };
    return fn;
  };
  return { default: factory };
});

function setupSqlResults(...results: unknown[][]) {
  sqlResults = results;
  sqlCallIndex = 0;
  sqlCalls.length = 0;
}

function makeEvent(eventType: string): DomainEvent {
  return {
    eventType,
    aggregateType: 'ChargingStation',
    aggregateId: 'CS-001',
    payload: { stationId: 'CS-001' },
    occurredAt: new Date(),
  };
}

function createSqlMock() {
  const fn = (_strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push(values);
    const result = sqlResults[sqlCallIndex] ?? [];
    sqlCallIndex++;
    return Promise.resolve(result);
  };
  return fn;
}

// Imported once, not in the first test: loading the module graph can exceed the 5 s test timeout under load.
let notificationDispatcherModule: typeof import('../server/notification-dispatcher.js');
beforeAll(async () => {
  notificationDispatcherModule = await import('../server/notification-dispatcher.js');
}, 30_000);

describe('dispatchOcppNotification', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    sqlCalls.length = 0;
    sqlResults = [];
    sqlCallIndex = 0;
    mockRecordNotificationAttempt.mockResolvedValue(undefined);
    // Clear the in-memory settings cache between tests
    const mod = notificationDispatcherModule;
    mod.clearOcppEventSettingsCache();
  });

  it('dispatches email notification when setting row exists', async () => {
    const { dispatchOcppNotification } = notificationDispatcherModule;

    // Cache loads all ocpp_event_settings rows (row existence = active)
    setupSqlResults(
      [
        {
          event_type: 'ocpp.StatusNotification',
          recipient: 'admin@test.com',
          channel: 'email',
          template_html: null,
          language: 'en',
        },
      ],
      [], // company settings
      [], // system timezone
      [], // notification insert
    );

    mockGetNotificationSettings.mockResolvedValue({
      smtp: { host: 'smtp.test.com', port: 587, username: '', password: '', from: 'test@test.com' },
      twilio: null,
      emailWrapperTemplate: null,
    });
    mockResolveRecipients.mockReturnValue([{ address: 'admin@test.com', language: 'en' }]);
    mockRenderTemplate.mockResolvedValue({ subject: 'Test', body: 'Body', html: '<p>Body</p>' });
    mockWrapEmailHtml.mockReturnValue('<div><p>Body</p></div>');
    mockSendEmail.mockResolvedValue(true);

    const sql = createSqlMock();
    await dispatchOcppNotification(sql as never, makeEvent('ocpp.StatusNotification'));

    expect(mockSendEmail).toHaveBeenCalled();
  });

  it('skips when no setting row exists for the event type', async () => {
    const { dispatchOcppNotification } = notificationDispatcherModule;
    // Cache load returns no rows
    setupSqlResults([]);

    const sql = createSqlMock();
    await dispatchOcppNotification(sql as never, makeEvent('ocpp.Unknown'));

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockSendWebhook).not.toHaveBeenCalled();
  });

  it('dispatches webhook when channel is webhook', async () => {
    const { dispatchOcppNotification } = notificationDispatcherModule;

    setupSqlResults(
      [
        {
          event_type: 'ocpp.StatusNotification',
          recipient: 'https://hook.test.com',
          channel: 'webhook',
          template_html: null,
          language: 'en',
        },
      ],
      [], // company settings
      [], // system timezone
      [], // notification insert
    );

    mockGetNotificationSettings.mockResolvedValue({
      smtp: null,
      twilio: null,
      emailWrapperTemplate: null,
    });
    mockResolveRecipients.mockReturnValue([{ address: 'https://hook.test.com', language: 'en' }]);
    mockRenderTemplate.mockResolvedValue({ subject: 'Test', body: 'Body' });
    mockSendWebhook.mockResolvedValue('ok');

    const sql = createSqlMock();
    mockGetWebhookAllowedPrivateHosts.mockResolvedValueOnce(['n8n']);
    await dispatchOcppNotification(sql as never, makeEvent('ocpp.StatusNotification'));

    expect(mockSendWebhook).toHaveBeenCalledWith(
      'https://hook.test.com',
      'Test',
      'Body',
      expect.any(Object),
      ['n8n'],
    );
  });

  it('falls back to log when SMTP not configured', async () => {
    const { dispatchOcppNotification } = notificationDispatcherModule;

    setupSqlResults(
      [
        {
          event_type: 'ocpp.StatusNotification',
          recipient: 'admin@test.com',
          channel: 'email',
          template_html: null,
          language: 'en',
        },
      ],
      [], // company settings
      [], // system timezone
      [], // notification insert
    );

    mockGetNotificationSettings.mockResolvedValue({
      smtp: null,
      twilio: null,
      emailWrapperTemplate: null,
    });
    mockResolveRecipients.mockReturnValue([{ address: 'admin@test.com', language: 'en' }]);
    mockRenderTemplate.mockResolvedValue({ subject: 'Test', body: 'Body' });

    const sql = createSqlMock();
    await dispatchOcppNotification(sql as never, makeEvent('ocpp.StatusNotification'));

    expect(mockLogNotification).toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('dispatches to both email and webhook when both rows exist', async () => {
    const { dispatchOcppNotification } = notificationDispatcherModule;

    setupSqlResults(
      [
        {
          event_type: 'ocpp.StatusNotification',
          recipient: 'admin@test.com',
          channel: 'email',
          template_html: null,
          language: 'en',
        },
        {
          event_type: 'ocpp.StatusNotification',
          recipient: 'https://hook.test.com',
          channel: 'webhook',
          template_html: null,
          language: 'en',
        },
      ],
      [], // company settings (email)
      [], // system timezone (email)
      [], // notification insert (email)
      [], // company settings (webhook)
      [], // system timezone (webhook)
      [], // notification insert (webhook)
    );

    mockGetNotificationSettings.mockResolvedValue({
      smtp: { host: 'smtp.test.com', port: 587, username: '', password: '', from: 'test@test.com' },
      twilio: null,
      emailWrapperTemplate: null,
    });
    mockResolveRecipients.mockReturnValue([{ address: 'admin@test.com', language: 'en' }]);
    mockRenderTemplate.mockResolvedValue({ subject: 'Test', body: 'Body', html: '<p>Body</p>' });
    mockWrapEmailHtml.mockReturnValue('<div><p>Body</p></div>');
    mockSendEmail.mockResolvedValue(true);
    mockSendWebhook.mockResolvedValue('ok');

    const sql = createSqlMock();
    await dispatchOcppNotification(sql as never, makeEvent('ocpp.StatusNotification'));

    expect(mockSendEmail).toHaveBeenCalled();
    expect(mockSendWebhook).toHaveBeenCalled();
  });

  it('serves the second dispatch from the in-memory settings cache', async () => {
    const { dispatchOcppNotification } = notificationDispatcherModule;

    setupSqlResults([
      {
        event_type: 'ocpp.StatusNotification',
        recipient: 'admin@test.com',
        channel: 'webhook',
        template_html: null,
        language: 'en',
      },
    ]);
    mockGetNotificationSettings.mockResolvedValue({
      smtp: null,
      twilio: null,
      emailWrapperTemplate: null,
    });
    mockResolveRecipients.mockReturnValue([{ address: 'https://hook.test.com', language: 'en' }]);
    mockRenderTemplate.mockResolvedValue({ subject: 'S', body: 'B' });
    mockSendWebhook.mockResolvedValue('ok');

    const sql = createSqlMock();
    await dispatchOcppNotification(sql as never, makeEvent('ocpp.StatusNotification'));
    const sqlCallsAfterFirst = sqlCalls.length;

    // Second dispatch within the 60s TTL: the settings SELECT is served from
    // cache, so the only new SQL is the per-attempt record (mocked here), and
    // the settings query does not run again.
    await dispatchOcppNotification(sql as never, makeEvent('ocpp.StatusNotification'));

    // The settings-load query (the first SQL call) did not run a second time.
    expect(sqlCalls.length).toBe(sqlCallsAfterFirst);
    expect(mockSendWebhook).toHaveBeenCalledTimes(2);
  });

  it('uses the recipient language when the setting has no language override', async () => {
    const { dispatchOcppNotification } = notificationDispatcherModule;

    setupSqlResults([
      {
        event_type: 'ocpp.StatusNotification',
        recipient: 'admin@test.com',
        channel: 'webhook',
        template_html: null,
        language: null,
      },
    ]);
    mockGetNotificationSettings.mockResolvedValue({
      smtp: null,
      twilio: null,
      emailWrapperTemplate: null,
    });
    mockResolveRecipients.mockReturnValue([{ address: 'https://hook.test.com', language: 'es' }]);
    mockRenderTemplate.mockResolvedValue({ subject: 'S', body: 'B' });
    mockSendWebhook.mockResolvedValue('ok');

    const sql = createSqlMock();
    await dispatchOcppNotification(sql as never, makeEvent('ocpp.StatusNotification'));

    // renderTemplate is called with the recipient's language ('es') because the
    // setting carried no language override.
    expect(mockRenderTemplate).toHaveBeenCalledWith(
      'email',
      'ocpp.StatusNotification',
      'es',
      expect.anything(),
      sql,
      null,
      expect.anything(),
    );
  });

  it('formats date variables in the language of each recipient', async () => {
    const { dispatchOcppNotification } = await import('../server/notification-dispatcher.js');

    setupSqlResults([
      {
        event_type: 'ocpp.StatusNotification',
        recipient: 'admin@test.com',
        channel: 'webhook',
        template_html: null,
        language: null,
      },
    ]);
    mockGetNotificationSettings.mockResolvedValue({
      smtp: null,
      twilio: null,
      emailWrapperTemplate: null,
    });
    mockResolveRecipients.mockReturnValue([
      { address: 'https://hook-en.test.com', language: 'en' },
      { address: 'https://hook-de.test.com', language: 'de' },
    ]);
    mockRenderTemplate.mockResolvedValue({ subject: 'S', body: 'B' });
    mockSendWebhook.mockResolvedValue('ok');

    const sql = createSqlMock();
    await dispatchOcppNotification(sql as never, makeEvent('ocpp.StatusNotification'));

    const occurredAt = (call: unknown[]): unknown =>
      (call[3] as Record<string, unknown>)['occurredAt'];
    expect(mockRenderTemplate).toHaveBeenCalledTimes(2);
    expect(occurredAt(mockRenderTemplate.mock.calls[0] as unknown[])).toMatch(/[A-Z][a-z]{2} \d/);
    expect(occurredAt(mockRenderTemplate.mock.calls[1] as unknown[])).toMatch(
      /^\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}$/,
    );
  });

  it('logs and swallows a failure thrown after loading settings', async () => {
    const { dispatchOcppNotification } = notificationDispatcherModule;

    setupSqlResults([
      {
        event_type: 'ocpp.StatusNotification',
        recipient: 'admin@test.com',
        channel: 'email',
        template_html: null,
        language: 'en',
      },
    ]);
    // getNotificationSettings throwing aborts the whole dispatch in the outer
    // try/catch; it must not propagate.
    mockGetNotificationSettings.mockRejectedValue(new Error('settings unavailable'));

    const sql = createSqlMock();
    await expect(
      dispatchOcppNotification(sql as never, makeEvent('ocpp.StatusNotification')),
    ).resolves.toBeUndefined();
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockRecordNotificationAttempt).not.toHaveBeenCalled();
  });

  it('records smtp_send_failed when sendEmail returns false', async () => {
    const { dispatchOcppNotification } = notificationDispatcherModule;

    setupSqlResults([
      {
        event_type: 'ocpp.StatusNotification',
        recipient: 'admin@test.com',
        channel: 'email',
        template_html: null,
        language: 'en',
      },
    ]);

    mockGetNotificationSettings.mockResolvedValue({
      smtp: { host: 'smtp.test.com', port: 587, username: '', password: '', from: 'test@test.com' },
      twilio: null,
      emailWrapperTemplate: null,
    });
    mockResolveRecipients.mockReturnValue([{ address: 'admin@test.com', language: 'en' }]);
    mockRenderTemplate.mockResolvedValue({ subject: 'Test', body: 'Body', html: '<p>Body</p>' });
    mockWrapEmailHtml.mockReturnValue('<div><p>Body</p></div>');
    mockSendEmail.mockResolvedValue(false);

    const sql = createSqlMock();
    await dispatchOcppNotification(sql as never, makeEvent('ocpp.StatusNotification'));

    expect(mockRecordNotificationAttempt).toHaveBeenCalledWith(
      sql,
      expect.objectContaining({
        channel: 'email',
        status: 'failed',
        metadata: { failureReason: 'smtp_send_failed' },
      }),
    );
  });

  it('records credentials_decrypt_failed when smtp credentials cannot decrypt', async () => {
    const { dispatchOcppNotification } = notificationDispatcherModule;

    setupSqlResults([
      {
        event_type: 'ocpp.StatusNotification',
        recipient: 'admin@test.com',
        channel: 'email',
        template_html: null,
        language: 'en',
      },
    ]);

    mockGetNotificationSettings.mockResolvedValue({
      smtp: {
        host: 'smtp.test.com',
        port: 587,
        username: '',
        password: '',
        from: 'test@test.com',
        credentialError: 'decrypt_failed',
      },
      twilio: null,
      emailWrapperTemplate: null,
    });
    mockResolveRecipients.mockReturnValue([{ address: 'admin@test.com', language: 'en' }]);
    mockRenderTemplate.mockResolvedValue({ subject: 'Test', body: 'Body', html: '<p>Body</p>' });
    mockWrapEmailHtml.mockReturnValue('<div><p>Body</p></div>');
    mockSendEmail.mockResolvedValue(false);

    const sql = createSqlMock();
    await dispatchOcppNotification(sql as never, makeEvent('ocpp.StatusNotification'));

    expect(mockRecordNotificationAttempt).toHaveBeenCalledWith(
      sql,
      expect.objectContaining({
        status: 'failed',
        metadata: { failureReason: 'credentials_decrypt_failed' },
      }),
    );
  });

  it('records a webhook failure reason when sendWebhook does not return ok', async () => {
    const { dispatchOcppNotification } = notificationDispatcherModule;

    setupSqlResults([
      {
        event_type: 'ocpp.StatusNotification',
        recipient: 'https://hook.test.com',
        channel: 'webhook',
        template_html: null,
        language: 'en',
      },
    ]);

    mockGetNotificationSettings.mockResolvedValue({
      smtp: null,
      twilio: null,
      emailWrapperTemplate: null,
    });
    mockResolveRecipients.mockReturnValue([{ address: 'https://hook.test.com', language: 'en' }]);
    mockRenderTemplate.mockResolvedValue({ subject: 'Test', body: 'Body' });
    mockSendWebhook.mockResolvedValue('timeout');

    const sql = createSqlMock();
    await dispatchOcppNotification(sql as never, makeEvent('ocpp.StatusNotification'));

    expect(mockRecordNotificationAttempt).toHaveBeenCalledWith(
      sql,
      expect.objectContaining({
        channel: 'webhook',
        status: 'failed',
        metadata: { failureReason: 'webhook_timeout' },
      }),
    );
  });

  it('catches and logs a per-recipient render failure without throwing', async () => {
    const { dispatchOcppNotification } = notificationDispatcherModule;

    setupSqlResults([
      {
        event_type: 'ocpp.StatusNotification',
        recipient: 'admin@test.com',
        channel: 'email',
        template_html: null,
        language: 'en',
      },
    ]);

    mockGetNotificationSettings.mockResolvedValue({
      smtp: { host: 'smtp.test.com', port: 587, username: '', password: '', from: 'test@test.com' },
      twilio: null,
      emailWrapperTemplate: null,
    });
    mockResolveRecipients.mockReturnValue([{ address: 'admin@test.com', language: 'en' }]);
    mockRenderTemplate.mockRejectedValue(new Error('template missing'));

    const sql = createSqlMock();
    // Per-recipient errors are caught: the call resolves and never records.
    await expect(
      dispatchOcppNotification(sql as never, makeEvent('ocpp.StatusNotification')),
    ).resolves.toBeUndefined();
    expect(mockRecordNotificationAttempt).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('returns an empty cache and skips dispatch when the settings query fails', async () => {
    const { dispatchOcppNotification, clearOcppEventSettingsCache } = notificationDispatcherModule;
    clearOcppEventSettingsCache();

    // SQL throws on the settings load -> loadSettingsCache catch returns an
    // empty Map -> no enabled channels -> nothing dispatched.
    const throwingSql = (() => {
      throw new Error('db down');
    }) as unknown as Parameters<typeof dispatchOcppNotification>[0];

    await expect(
      dispatchOcppNotification(throwingSql, makeEvent('ocpp.StatusNotification')),
    ).resolves.toBeUndefined();
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockSendWebhook).not.toHaveBeenCalled();
  });
});

describe('dispatchDriverNotification wrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards to the shared dispatcher with the default template dirs', async () => {
    const { dispatchDriverNotification, ALL_TEMPLATES_DIRS } = notificationDispatcherModule;
    mockDispatchDriverNotification.mockResolvedValue(undefined);

    const sql = createSqlMock();
    const variables = { firstName: 'Ada' };
    await dispatchDriverNotification(sql as never, 'session.Started', 'drv_1', variables);

    expect(mockDispatchDriverNotification).toHaveBeenCalledWith(
      sql,
      'session.Started',
      'drv_1',
      variables,
      ALL_TEMPLATES_DIRS,
      undefined,
    );
  });

  it('passes a caller-supplied templatesDir and pubsub through', async () => {
    const { dispatchDriverNotification } = notificationDispatcherModule;
    mockDispatchDriverNotification.mockResolvedValue(undefined);

    const sql = createSqlMock();
    const pubsub = { publish: vi.fn(), subscribe: vi.fn(), close: vi.fn() };
    await dispatchDriverNotification(
      sql as never,
      'session.Started',
      'drv_1',
      {},
      '/custom/dir',
      pubsub,
    );

    expect(mockDispatchDriverNotification).toHaveBeenCalledWith(
      sql,
      'session.Started',
      'drv_1',
      {},
      '/custom/dir',
      pubsub,
    );
  });
});

describe('subscribeOcppEventSettingsInvalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clears the OCPP event settings cache on a matching cache message', async () => {
    const mod = notificationDispatcherModule;

    let handler: ((p: string) => void) | null = null;
    const unsubscribe = vi.fn().mockResolvedValue(undefined);
    const pubsub = {
      publish: vi.fn(),
      subscribe: vi.fn((_channel: string, h: (p: string) => void) => {
        handler = h;
        return Promise.resolve({ unsubscribe });
      }),
      close: vi.fn(),
    };

    const sub = await mod.subscribeOcppEventSettingsInvalidation(pubsub);
    expect(pubsub.subscribe).toHaveBeenCalledWith('cache_invalidate', expect.any(Function));

    // Prime the settings cache, then invalidate it and confirm the next
    // dispatch re-queries SQL instead of serving stale rows.
    setupSqlResults([
      {
        event_type: 'ocpp.StatusNotification',
        recipient: 'admin@test.com',
        channel: 'email',
        template_html: null,
        language: 'en',
      },
    ]);
    mockGetNotificationSettings.mockResolvedValue({
      smtp: { host: 'smtp.test.com', port: 587, username: '', password: '', from: 't@t.com' },
      twilio: null,
      emailWrapperTemplate: null,
    });
    mockResolveRecipients.mockReturnValue([{ address: 'admin@test.com', language: 'en' }]);
    mockRenderTemplate.mockResolvedValue({ subject: 'S', body: 'B', html: '<p>B</p>' });
    mockWrapEmailHtml.mockReturnValue('<div>B</div>');
    mockSendEmail.mockResolvedValue(true);

    const sql1 = createSqlMock();
    await mod.dispatchOcppNotification(sql1 as never, makeEvent('ocpp.StatusNotification'));
    const callsBefore = sqlCalls.length;

    // Invalidate; the cache is now cold.
    handler!(JSON.stringify({ cache: 'ocppEventSettings' }));

    // Unrelated and malformed payloads must not throw.
    handler!(JSON.stringify({ kind: 'notification_settings' }));
    handler!('not-json');

    setupSqlResults([
      {
        event_type: 'ocpp.StatusNotification',
        recipient: 'admin@test.com',
        channel: 'email',
        template_html: null,
        language: 'en',
      },
    ]);
    const sql2 = createSqlMock();
    await mod.dispatchOcppNotification(sql2 as never, makeEvent('ocpp.StatusNotification'));
    // A fresh settings SELECT ran because the cache was invalidated.
    expect(sqlCalls.length).toBeGreaterThan(0);
    expect(callsBefore).toBeGreaterThan(0);

    await sub.unsubscribe();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('clears the contract validation CA cache on a pkiCaCertificates message', async () => {
    const mod = notificationDispatcherModule;
    let handler: ((p: string) => void) | null = null;
    const pubsub = {
      publish: vi.fn(),
      subscribe: vi.fn((_channel: string, h: (p: string) => void) => {
        handler = h;
        return Promise.resolve({ unsubscribe: vi.fn().mockResolvedValue(undefined) });
      }),
      close: vi.fn(),
    };
    await mod.subscribeOcppEventSettingsInvalidation(pubsub);

    handler!(JSON.stringify({ cache: 'ocppEventSettings' }));
    expect(mockClearContractValidationCaCache).not.toHaveBeenCalled();
    handler!(JSON.stringify({ cache: 'pkiCaCertificates' }));
    expect(mockClearContractValidationCaCache).toHaveBeenCalledTimes(1);
    expect(mockClearLocalContractCaCache).toHaveBeenCalledTimes(1);
    expect(mockClearOemTrustCache).toHaveBeenCalledTimes(1);
  });

  it('clears the station message caches on a station_message message', async () => {
    const mod = notificationDispatcherModule;
    let handler: ((p: string) => void) | null = null;
    const pubsub = {
      publish: vi.fn(),
      subscribe: vi.fn((_channel: string, h: (p: string) => void) => {
        handler = h;
        return Promise.resolve({ unsubscribe: vi.fn().mockResolvedValue(undefined) });
      }),
      close: vi.fn(),
    };
    await mod.subscribeOcppEventSettingsInvalidation(pubsub);

    handler!(JSON.stringify({ kind: 'notification_settings' }));
    expect(mockClearStationMessageCache).not.toHaveBeenCalled();
    handler!(JSON.stringify({ kind: 'station_message' }));
    expect(mockClearStationMessageCache).toHaveBeenCalledTimes(1);
    expect(mockClearStationMessageSettingsCache).toHaveBeenCalledTimes(1);
  });
});
