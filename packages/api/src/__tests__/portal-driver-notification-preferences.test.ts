// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// Driver notification preferences per event (discussion 56). The writer is
// replaced by an in-memory store with the same rules (a channel switch drops that
// channel's event choices), so the route, the view and the refusals run for real.

interface Row {
  eventType: string;
  isEnabled: boolean;
  emailMandatory: boolean;
  smsMandatory: boolean;
  pushMandatory: boolean;
}

const store = vi.hoisted(() => ({
  settings: [] as Row[],
  switches: new Map<string, { email: boolean; sms: boolean; push: boolean }>(),
  choices: new Map<string, Map<string, Record<string, boolean>>>(),
  smtp: true,
  twilio: false,
  audits: [] as unknown[],
}));

vi.mock('@evtivity/database', () => ({
  db: {},
  client: {},
  driverAuditLog: { _table: 'driver_audit_log' },
  writeAudit: vi.fn((_t: unknown, entry: unknown) => {
    store.audits.push(entry);
    return Promise.resolve();
  }),
  listDriverEventSettings: vi.fn(() => Promise.resolve(store.settings)),
  readDriverNotificationState: vi.fn((driverId: string) =>
    Promise.resolve({
      switches: store.switches.get(driverId) ?? null,
      choices: new Map(store.choices.get(driverId) ?? []),
    }),
  ),
  applyDriverNotificationPreferences: vi.fn(
    (
      driverId: string,
      changes: {
        switches?: Record<string, boolean>;
        events?: Array<{ eventType: string; channel: string; enabled: boolean }>;
      },
    ) => {
      const sw = store.switches.get(driverId) ?? { email: true, sms: true, push: true };
      const choices = store.choices.get(driverId) ?? new Map<string, Record<string, boolean>>();
      for (const [channel, value] of Object.entries(changes.switches ?? {})) {
        (sw as Record<string, boolean>)[channel] = value;
        for (const [eventType, entry] of choices) {
          choices.set(
            eventType,
            Object.fromEntries(Object.entries(entry).filter(([c]) => c !== channel)),
          );
        }
      }
      for (const e of changes.events ?? []) {
        const entry = choices.get(e.eventType) ?? {};
        entry[e.channel] = e.enabled;
        choices.set(e.eventType, entry);
      }
      if (Object.keys(changes.switches ?? {}).length > 0) store.switches.set(driverId, sw);
      store.choices.set(driverId, choices);
      return Promise.resolve();
    },
  ),
}));

vi.mock('@evtivity/lib', async () => {
  const actual = await vi.importActual<typeof import('@evtivity/lib')>('@evtivity/lib');
  return {
    driverNotificationChannels: actual.driverNotificationChannels,
    getNotificationSettings: vi.fn(() =>
      Promise.resolve({
        smtp: store.smtp ? { host: 'mail.example.com' } : null,
        twilio: store.twilio ? { accountSid: 'AC1' } : null,
      }),
    ),
  };
});

import { registerAuth } from '../plugins/auth.js';
import { portalDriverNotificationPreferencesRoutes } from '../routes/portal/driver-notification-preferences.js';
import { applyDriverNotificationPreferences } from '@evtivity/database';

const DRIVER_ID = 'drv_000000000001';
const OTHER_DRIVER_ID = 'drv_000000000002';

function setting(eventType: string, patch: Partial<Row>): Row {
  return {
    eventType,
    isEnabled: true,
    emailMandatory: false,
    smsMandatory: false,
    pushMandatory: false,
    ...patch,
  };
}

interface View {
  emailEnabled: boolean;
  smsEnabled: boolean;
  pushEnabled: boolean;
  channels: Record<string, boolean>;
  events: Array<{
    eventType: string;
    group: string;
    email: { enabled: boolean; mandatory: boolean };
    sms: { enabled: boolean; mandatory: boolean };
    push: { enabled: boolean; mandatory: boolean };
  }>;
}

describe('portal driver notification preferences', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    await app.register(portalDriverNotificationPreferencesRoutes);
    await app.ready();
    token = app.jwt.sign({ driverId: DRIVER_ID, type: 'driver' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    store.settings = [];
    store.switches.clear();
    store.choices.clear();
    store.smtp = true;
    store.twilio = false;
    store.audits = [];
  });

  async function get(): Promise<View> {
    const res = await app.inject({
      method: 'GET',
      url: '/portal/driver/notification-preferences',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as View;
  }

  async function put(payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/driver/notification-preferences',
      headers: { authorization: `Bearer ${token}` },
      payload: payload as Record<string, unknown>,
    });
    return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
  }

  const event = (view: View, type: string) => view.events.find((e) => e.eventType === type);

  it('refuses a request without a driver session', async () => {
    const res = await app.inject({ method: 'GET', url: '/portal/driver/notification-preferences' });
    expect(res.statusCode).toBe(401);
  });

  it('starts with every event on and lists only the configured channels', async () => {
    const view = await get();
    expect(view.channels).toEqual({ email: true, sms: false, push: true });
    expect(view.emailEnabled).toBe(true);
    expect(event(view, 'session.Started')).toMatchObject({
      group: 'sessions',
      email: { enabled: true, mandatory: false },
    });
  });

  it('never lists a security notice, a code or a link event as a choice', async () => {
    const types = (await get()).events.map((e) => e.eventType);
    for (const t of [
      'driver.ForgotPassword',
      'mfa.VerificationCode',
      'driver.Welcome',
      'driver.PasswordChanged',
      'driver.MfaDisabled',
      'invoice.MemberInvoice',
      'session.AutochargeStarted',
    ]) {
      expect(types).not.toContain(t);
    }
  });

  it('keeps what drivers got before: a channel switched off shows every event off', async () => {
    store.switches.set(DRIVER_ID, { email: true, sms: false, push: true });
    const view = await get();
    expect(view.smsEnabled).toBe(false);
    expect(view.events.every((e) => !e.sms.enabled)).toBe(true);
    expect(view.events.every((e) => e.email.enabled)).toBe(true);
  });

  it('leaves out an event the operator turned off, even when it is mandatory', async () => {
    store.settings = [setting('session.Started', { isEnabled: false, emailMandatory: true })];
    expect(event(await get(), 'session.Started')).toBeUndefined();
  });

  it('shows a mandatory channel on and locked whatever the driver chose', async () => {
    store.settings = [setting('session.Faulted', { emailMandatory: true })];
    store.switches.set(DRIVER_ID, { email: false, sms: false, push: false });
    const view = await get();
    expect(event(view, 'session.Faulted')?.email).toEqual({ enabled: true, mandatory: true });
    // The channel switch counts only optional events.
    expect(view.emailEnabled).toBe(false);
  });

  it('turns one event off on one channel and keeps the others', async () => {
    const res = await put({
      events: [{ eventType: 'session.Started', channel: 'email', enabled: false }],
    });
    expect(res.status).toBe(200);
    const view = res.body as unknown as View;
    expect(event(view, 'session.Started')?.email.enabled).toBe(false);
    expect(event(view, 'session.Completed')?.email.enabled).toBe(true);
    expect(view.emailEnabled).toBe(true);
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]).toMatchObject({
      before: { notificationPreferences: { 'session.Started:email': true } },
      after: { notificationPreferences: { 'session.Started:email': false } },
    });
  });

  it('refuses to turn off a mandatory event (400 NOTIFICATION_EVENT_MANDATORY)', async () => {
    store.settings = [setting('session.Faulted', { smsMandatory: true })];
    const res = await put({
      events: [{ eventType: 'session.Faulted', channel: 'sms', enabled: false }],
    });
    expect(res.status).toBe(400);
    expect(res.body['code']).toBe('NOTIFICATION_EVENT_MANDATORY');
    expect(applyDriverNotificationPreferences).not.toHaveBeenCalled();
  });

  it.each(['driver.ForgotPassword', 'mfa.VerificationCode', 'security.FactorAdded', 'x.Unknown'])(
    'refuses a choice for %s, which is always sent',
    async (eventType) => {
      const res = await put({ events: [{ eventType, channel: 'email', enabled: false }] });
      expect(res.status).toBe(400);
      expect(res.body['code']).toBe('VALIDATION_ERROR');
      expect(applyDriverNotificationPreferences).not.toHaveBeenCalled();
    },
  );

  it('refuses an unknown channel', async () => {
    const res = await put({
      events: [{ eventType: 'session.Started', channel: 'fax', enabled: false }],
    });
    expect(res.status).toBe(400);
  });

  it('applies the channel switch as all off, and a mandatory event stays on', async () => {
    store.settings = [setting('session.Faulted', { emailMandatory: true })];
    const res = await put({ emailEnabled: false });
    const view = res.body as unknown as View;
    expect(view.emailEnabled).toBe(false);
    expect(event(view, 'session.Faulted')?.email).toEqual({ enabled: true, mandatory: true });
    expect(view.events.filter((e) => !e.email.mandatory).every((e) => !e.email.enabled)).toBe(true);
  });

  it('applies the channel switch as all on, dropping earlier event choices', async () => {
    await put({ events: [{ eventType: 'session.Started', channel: 'email', enabled: false }] });
    await put({ emailEnabled: false });
    const view = (await put({ emailEnabled: true })).body as unknown as View;
    expect(view.events.every((e) => e.email.enabled)).toBe(true);
  });

  it('changes nothing when an older client sends the shown switches back', async () => {
    await put({ events: [{ eventType: 'session.Started', channel: 'email', enabled: false }] });
    vi.mocked(applyDriverNotificationPreferences).mockClear();
    store.audits = [];
    const res = await put({ emailEnabled: true, smsEnabled: true });
    expect(res.status).toBe(200);
    expect(applyDriverNotificationPreferences).not.toHaveBeenCalled();
    expect(event(res.body as unknown as View, 'session.Started')?.email.enabled).toBe(false);
    expect(store.audits).toHaveLength(0);
  });

  it('writes only the signed-in driver, whatever driver id the body names', async () => {
    const res = await put({
      driverId: OTHER_DRIVER_ID,
      events: [{ eventType: 'session.Started', channel: 'email', enabled: false }],
    });
    expect([200, 400]).toContain(res.status);
    expect(store.choices.has(OTHER_DRIVER_ID)).toBe(false);
    expect(store.switches.has(OTHER_DRIVER_ID)).toBe(false);
    for (const call of vi.mocked(applyDriverNotificationPreferences).mock.calls) {
      expect(call[0]).toBe(DRIVER_ID);
    }
  });
});
