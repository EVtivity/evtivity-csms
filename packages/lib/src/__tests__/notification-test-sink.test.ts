// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  resolveNotificationTestSinkUrl,
  getNotificationTestSinkUrl,
  clearNotificationTestSinkCache,
  postToNotificationTestSink,
} from '../notification-test-sink.js';
import { sendSms } from '../notification-dispatch.js';
import { sendExpoPush } from '../push-send.js';

const SINK = 'http://notify-sink:8080';
const TOKEN = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';

function stubFetch(ok = true, status = 200): ReturnType<typeof vi.fn> {
  const fetchSpy = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => ({ data: [{ status: 'ok' }] }),
    text: async () => '',
  });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

function enableSink(): void {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('NOTIFICATIONS_ALLOW_TEST_SINK', 'true');
  vi.stubEnv('NOTIFICATIONS_TEST_SINK_URL', `${SINK}/`);
  clearNotificationTestSinkCache();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearNotificationTestSinkCache();
});

describe('resolveNotificationTestSinkUrl', () => {
  it('is off by default', () => {
    expect(resolveNotificationTestSinkUrl({})).toBeNull();
    expect(resolveNotificationTestSinkUrl({ NODE_ENV: 'production' })).toBeNull();
    expect(
      resolveNotificationTestSinkUrl({
        NODE_ENV: 'production',
        NOTIFICATIONS_ALLOW_TEST_SINK: 'false',
        NOTIFICATIONS_TEST_SINK_URL: '',
      }),
    ).toBeNull();
  });

  it('stays off with the allow flag but no URL', () => {
    expect(
      resolveNotificationTestSinkUrl({
        NODE_ENV: 'development',
        NOTIFICATIONS_ALLOW_TEST_SINK: 'true',
      }),
    ).toBeNull();
  });

  it('returns the URL without a trailing slash when both are set in development or test', () => {
    for (const nodeEnv of ['development', 'test']) {
      expect(
        resolveNotificationTestSinkUrl({
          NODE_ENV: nodeEnv,
          NOTIFICATIONS_ALLOW_TEST_SINK: 'true',
          NOTIFICATIONS_TEST_SINK_URL: `${SINK}/`,
        }),
      ).toBe(SINK);
    }
  });

  it('refuses the allow flag unless NODE_ENV is development or test, unset included', () => {
    for (const nodeEnv of [undefined, '', 'staging', 'Development', 'prod']) {
      expect(() =>
        resolveNotificationTestSinkUrl({
          NODE_ENV: nodeEnv,
          NOTIFICATIONS_ALLOW_TEST_SINK: 'true',
          NOTIFICATIONS_TEST_SINK_URL: SINK,
        }),
      ).toThrow(/needs NODE_ENV development or test/);
    }
    expect(() => resolveNotificationTestSinkUrl({ NOTIFICATIONS_ALLOW_TEST_SINK: 'true' })).toThrow(
      /needs NODE_ENV development or test/,
    );
  });

  it('refuses the allow flag when NODE_ENV is production, with or without a URL', () => {
    expect(() =>
      resolveNotificationTestSinkUrl({
        NODE_ENV: 'production',
        NOTIFICATIONS_ALLOW_TEST_SINK: 'true',
      }),
    ).toThrow(/needs NODE_ENV development or test/);
    expect(() =>
      resolveNotificationTestSinkUrl({
        NODE_ENV: 'production',
        NOTIFICATIONS_ALLOW_TEST_SINK: 'true',
        NOTIFICATIONS_TEST_SINK_URL: SINK,
      }),
    ).toThrow(/needs NODE_ENV development or test/);
  });

  it('refuses a URL without the allow flag', () => {
    expect(() => resolveNotificationTestSinkUrl({ NOTIFICATIONS_TEST_SINK_URL: SINK })).toThrow(
      /needs NOTIFICATIONS_ALLOW_TEST_SINK=true/,
    );
    expect(() =>
      resolveNotificationTestSinkUrl({
        NODE_ENV: 'production',
        NOTIFICATIONS_ALLOW_TEST_SINK: 'false',
        NOTIFICATIONS_TEST_SINK_URL: SINK,
      }),
    ).toThrow(/needs NOTIFICATIONS_ALLOW_TEST_SINK=true/);
  });

  it('refuses an invalid flag or URL', () => {
    expect(() => resolveNotificationTestSinkUrl({ NOTIFICATIONS_ALLOW_TEST_SINK: 'yes' })).toThrow(
      /must be true or false/,
    );
    expect(() =>
      resolveNotificationTestSinkUrl({
        NODE_ENV: 'development',
        NOTIFICATIONS_ALLOW_TEST_SINK: 'true',
        NOTIFICATIONS_TEST_SINK_URL: 'ftp://sink',
      }),
    ).toThrow(/http or https/);
    expect(() =>
      resolveNotificationTestSinkUrl({
        NODE_ENV: 'development',
        NOTIFICATIONS_ALLOW_TEST_SINK: 'true',
        NOTIFICATIONS_TEST_SINK_URL: 'not a url',
      }),
    ).toThrow(/http or https/);
  });
});

describe('getNotificationTestSinkUrl', () => {
  it('reads process.env once and refuses production and unset NODE_ENV there too', () => {
    enableSink();
    expect(getNotificationTestSinkUrl()).toBe(SINK);
    vi.stubEnv('NOTIFICATIONS_TEST_SINK_URL', '');
    expect(getNotificationTestSinkUrl()).toBe(SINK);

    vi.stubEnv('NODE_ENV', 'production');
    clearNotificationTestSinkCache();
    expect(() => getNotificationTestSinkUrl()).toThrow(/needs NODE_ENV development or test/);

    vi.stubEnv('NODE_ENV', undefined);
    clearNotificationTestSinkCache();
    expect(() => getNotificationTestSinkUrl()).toThrow(/needs NODE_ENV development or test/);
  });
});

describe('postToNotificationTestSink', () => {
  const message = {
    channel: 'sms' as const,
    to: '+15551234567',
    eventType: 'session.Started',
    language: 'de',
    title: null,
    body: 'Hallo',
    data: null,
  };

  it('posts the message as JSON to /messages', async () => {
    const fetchSpy = stubFetch();
    expect(await postToNotificationTestSink(SINK, message)).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${SINK}/messages`);
    expect(JSON.parse(init.body as string)).toEqual(message);
  });

  it('returns false on an error answer or a network error', async () => {
    stubFetch(false, 500);
    expect(await postToNotificationTestSink(SINK, message)).toBe(false);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    expect(await postToNotificationTestSink(SINK, message)).toBe(false);
  });
});

describe('senders with the test sink', () => {
  it('sendSms posts to the sink without Twilio credentials or a Twilio config', async () => {
    enableSink();
    const fetchSpy = stubFetch();
    const ok = await sendSms(null, '(555) 123-4567', 'Your session started', {
      eventType: 'session.Started',
      language: 'es',
    });
    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${SINK}/messages`);
    expect(JSON.stringify(init.headers)).not.toMatch(/Authorization/i);
    expect(JSON.parse(init.body as string)).toEqual({
      channel: 'sms',
      to: '+15551234567',
      eventType: 'session.Started',
      language: 'es',
      title: null,
      body: 'Your session started',
      data: null,
    });
  });

  it('sendSms never calls Twilio while the sink is on', async () => {
    enableSink();
    const fetchSpy = stubFetch();
    await sendSms(
      { accountSid: 'AC1', authToken: 'secret', fromNumber: '+1555' },
      '+15550000000',
      'x',
    );
    expect(String(fetchSpy.mock.calls[0]?.[0])).not.toContain('twilio.com');
    expect((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string).not.toContain('secret');
  });

  it('sendSms without the sink and without Twilio returns false and sends nothing', async () => {
    const fetchSpy = stubFetch();
    expect(await sendSms(null, '+15550000000', 'x')).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sendExpoPush posts each message to the sink instead of Expo', async () => {
    enableSink();
    const fetchSpy = stubFetch();
    const results = await sendExpoPush(
      [{ to: TOKEN, title: 'Charging', body: 'Started', data: { eventType: 'session.Started' } }],
      { eventType: 'session.Started', language: 'ko' },
    );
    expect(results).toEqual([{ token: TOKEN, ok: true, unregistered: false }]);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${SINK}/messages`);
    expect(JSON.parse(init.body as string)).toEqual({
      channel: 'push',
      to: TOKEN,
      eventType: 'session.Started',
      language: 'ko',
      title: 'Charging',
      body: 'Started',
      data: { eventType: 'session.Started' },
    });
  });

  it('sendExpoPush reports a sink failure as a failed, not unregistered, token', async () => {
    enableSink();
    stubFetch(false, 503);
    const [res] = await sendExpoPush([{ to: TOKEN, title: 'T', body: 'B' }]);
    expect(res).toEqual({ token: TOKEN, ok: false, unregistered: false });
  });
});
