// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DomainEvent } from '@evtivity/lib';

const mockGetNotificationSettings = vi.fn();
const mockResolveRecipients = vi.fn();
const mockRenderTemplate = vi.fn();
const mockSendEmail = vi.fn();
const mockSendWebhook = vi.fn();
const mockLogNotification = vi.fn();
const mockWrapEmailHtml = vi.fn();
const mockDispatchDriverNotification = vi.fn();

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
    dispatchDriverNotification: mockDispatchDriverNotification,
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

describe('dispatchOcppNotification', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    sqlCalls.length = 0;
    sqlResults = [];
    sqlCallIndex = 0;
    // Clear the in-memory settings cache between tests
    const mod = await import('../server/notification-dispatcher.js');
    mod.clearOcppEventSettingsCache();
  });

  it('dispatches email notification when setting row exists', async () => {
    const { dispatchOcppNotification } = await import('../server/notification-dispatcher.js');

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
    const { dispatchOcppNotification } = await import('../server/notification-dispatcher.js');
    // Cache load returns no rows
    setupSqlResults([]);

    const sql = createSqlMock();
    await dispatchOcppNotification(sql as never, makeEvent('ocpp.Unknown'));

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockSendWebhook).not.toHaveBeenCalled();
  });

  it('dispatches webhook when channel is webhook', async () => {
    const { dispatchOcppNotification } = await import('../server/notification-dispatcher.js');

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
    mockSendWebhook.mockResolvedValue(true);

    const sql = createSqlMock();
    await dispatchOcppNotification(sql as never, makeEvent('ocpp.StatusNotification'));

    expect(mockSendWebhook).toHaveBeenCalled();
  });

  it('falls back to log when SMTP not configured', async () => {
    const { dispatchOcppNotification } = await import('../server/notification-dispatcher.js');

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
    const { dispatchOcppNotification } = await import('../server/notification-dispatcher.js');

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
    mockSendWebhook.mockResolvedValue(true);

    const sql = createSqlMock();
    await dispatchOcppNotification(sql as never, makeEvent('ocpp.StatusNotification'));

    expect(mockSendEmail).toHaveBeenCalled();
    expect(mockSendWebhook).toHaveBeenCalled();
  });
});
