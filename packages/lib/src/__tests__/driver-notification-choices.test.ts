// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';
import {
  DRIVER_EVENT_TYPES,
  DRIVER_PREFERENCE_EVENT_GROUPS,
  DRIVER_PREFERENCE_EVENT_TYPES,
  OTHER_SENSITIVE_EVENT_TYPES,
  REQUIRED_DRIVER_EVENT_TYPES,
  driverPreferenceEventGroup,
  isDriverPreferenceEventType,
  isSecurityTemplateEventType,
} from '../notification-events.js';
import {
  driverNotificationChannels,
  mandatoryChannelsOf,
  resolveDriverChannels,
  type DriverEventSetting,
  type NotificationSettings,
} from '../notification-dispatch.js';

const NONE = { email: false, sms: false, push: false };

describe('driver preference events (discussion 56)', () => {
  it('lists every driver event that is no required, security or link event, once', () => {
    const alwaysSent = (type: string): boolean =>
      (REQUIRED_DRIVER_EVENT_TYPES as readonly string[]).includes(type) ||
      isSecurityTemplateEventType(type) ||
      (OTHER_SENSITIVE_EVENT_TYPES as readonly string[]).includes(type);
    const expected = DRIVER_EVENT_TYPES.filter((type) => !alwaysSent(type));
    expect([...DRIVER_PREFERENCE_EVENT_TYPES].sort()).toEqual([...expected].sort());
    expect(new Set(DRIVER_PREFERENCE_EVENT_TYPES).size).toBe(DRIVER_PREFERENCE_EVENT_TYPES.length);
  });

  it('never offers a security notice, a code or a link event as a choice', () => {
    for (const type of [
      'driver.ForgotPassword',
      'mfa.VerificationCode',
      'driver.Welcome',
      'driver.PasswordChanged',
      'driver.MfaDisabled',
      'security.FactorAdded',
      'session.AutochargeStarted',
    ]) {
      expect(isDriverPreferenceEventType(type)).toBe(false);
    }
  });

  it('names the group of each choice', () => {
    for (const [group, events] of Object.entries(DRIVER_PREFERENCE_EVENT_GROUPS)) {
      for (const event of events) expect(driverPreferenceEventGroup(event)).toBe(group);
    }
    expect(driverPreferenceEventGroup('driver.ForgotPassword')).toBeNull();
  });
});

describe('resolveDriverChannels', () => {
  it('sends a mandatory channel even when the channel and the event are off', () => {
    expect(
      resolveDriverChannels(
        'session.Faulted',
        { email: false, sms: false, push: false },
        { email: false },
        { email: true, sms: false, push: false },
      ),
    ).toEqual({ email: true, sms: false, push: false });
  });

  it('lets the event choice win over the channel switch', () => {
    expect(
      resolveDriverChannels(
        'session.Completed',
        { email: false, sms: true, push: true },
        { email: true, sms: false },
        NONE,
      ),
    ).toEqual({ email: true, sms: false, push: true });
  });

  it('keeps what drivers got before: no event choice follows the channel switch', () => {
    expect(
      resolveDriverChannels('session.Started', { email: true, sms: false, push: true }, {}, NONE),
    ).toEqual({ email: true, sms: false, push: true });
    expect(resolveDriverChannels('session.Started', undefined, {}, NONE)).toEqual({
      email: true,
      sms: true,
      push: true,
    });
  });

  it('sends an event that is no choice on every channel, whatever is stored', () => {
    expect(
      resolveDriverChannels(
        'driver.Welcome',
        { email: false, sms: false, push: false },
        { email: false },
        NONE,
      ),
    ).toEqual({ email: true, sms: true, push: true });
  });
});

describe('mandatoryChannelsOf', () => {
  const settings = new Map<string, DriverEventSetting>([
    ['session.Faulted', { isEnabled: true, mandatory: { email: true, sms: false, push: true } }],
    ['driver.Welcome', { isEnabled: true, mandatory: { email: true, sms: true, push: true } }],
  ]);

  it('reads the stored channels of a choice', () => {
    expect(mandatoryChannelsOf(settings, 'session.Faulted')).toEqual({
      email: true,
      sms: false,
      push: true,
    });
    expect(mandatoryChannelsOf(settings, 'session.Started')).toEqual(NONE);
  });

  it('ignores a stored mandatory flag of an event that is no choice', () => {
    expect(mandatoryChannelsOf(settings, 'driver.Welcome')).toEqual(NONE);
  });
});

describe('driverNotificationChannels', () => {
  it('reports email with SMTP, SMS with Twilio and push always', () => {
    const none = { smtp: null, twilio: null } as unknown as NotificationSettings;
    expect(driverNotificationChannels(none)).toEqual({ email: false, sms: false, push: true });
    const both = {
      smtp: { host: 'h' },
      twilio: { accountSid: 'a' },
    } as unknown as NotificationSettings;
    expect(driverNotificationChannels(both)).toEqual({ email: true, sms: true, push: true });
  });
});

// The three layers in order (owner clarification 2026-11-10): (1) an event the
// operator turned off is never sent, mandatory or not; (2) a mandatory channel is
// sent whatever the driver chose; (3) the driver's event choice, else the channel
// switch, decides an optional channel. A channel that is not configured sends nothing.
interface Case {
  name: string;
  isEnabled: boolean;
  emailMandatory: boolean;
  channelSwitch: boolean;
  eventChoice: boolean | undefined;
  smtp: boolean;
  delivered: boolean;
}

const CASES: Case[] = [
  {
    name: 'disabled and mandatory: never sent (disable wins)',
    isEnabled: false,
    emailMandatory: true,
    channelSwitch: true,
    eventChoice: true,
    smtp: true,
    delivered: false,
  },
  {
    name: 'enabled, mandatory, driver off: sent',
    isEnabled: true,
    emailMandatory: true,
    channelSwitch: false,
    eventChoice: false,
    smtp: true,
    delivered: true,
  },
  {
    name: 'enabled, optional, driver event off: not sent',
    isEnabled: true,
    emailMandatory: false,
    channelSwitch: true,
    eventChoice: false,
    smtp: true,
    delivered: false,
  },
  {
    name: 'enabled, optional, driver event on while the channel switch is off: sent',
    isEnabled: true,
    emailMandatory: false,
    channelSwitch: false,
    eventChoice: true,
    smtp: true,
    delivered: true,
  },
  {
    name: 'enabled, optional, no event choice: follows the channel switch (off)',
    isEnabled: true,
    emailMandatory: false,
    channelSwitch: false,
    eventChoice: undefined,
    smtp: true,
    delivered: false,
  },
  {
    name: 'mandatory on a channel that is not configured: nothing delivered',
    isEnabled: true,
    emailMandatory: true,
    channelSwitch: false,
    eventChoice: false,
    smtp: false,
    delivered: false,
  },
];

describe('dispatchDriverNotification layers (operator switch, mandatory, driver choice)', () => {
  it.each(CASES)('$name', async (c) => {
    vi.resetModules();
    const sendMail = vi.fn().mockResolvedValue({});
    vi.doMock('nodemailer', () => ({
      default: { createTransport: vi.fn(() => ({ sendMail })) },
    }));
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
    }));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve({ data: [{ status: 'ok' }] }),
      text: () => Promise.resolve(''),
    });
    vi.stubGlobal('fetch', fetchMock);
    const queries: string[] = [];
    const sqlFn = (strings: TemplateStringsArray): Promise<unknown[]> => {
      const text = strings.join('?');
      queries.push(text);
      if (text.includes('FROM driver_event_settings')) {
        return Promise.resolve([
          {
            event_type: 'session.Faulted',
            is_enabled: c.isEnabled,
            email_mandatory: c.emailMandatory,
            sms_mandatory: false,
            push_mandatory: false,
          },
        ]);
      }
      if (text.includes('FROM drivers WHERE id')) {
        return Promise.resolve([
          {
            first_name: 'Ana',
            last_name: 'Lee',
            email: 'ana@example.com',
            phone: null,
            language: 'en',
            timezone: 'UTC',
          },
        ]);
      }
      if (text.includes('driver_notification_preferences')) {
        return Promise.resolve([
          {
            email_enabled: c.channelSwitch,
            sms_enabled: false,
            push_enabled: false,
            event_choices: c.eventChoice === undefined ? {} : { email: c.eventChoice },
          },
        ]);
      }
      if (text.includes("LIKE 'smtp.%'")) {
        return Promise.resolve(c.smtp ? [{ key: 'smtp.host', value: 'mail.example.com' }] : []);
      }
      return Promise.resolve([]);
    };
    (sqlFn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
    const dispatch = await import('../notification-dispatch.js');
    dispatch.clearNotificationSettingsCache();

    const result = await dispatch.dispatchDriverNotification(
      sqlFn as never,
      'session.Faulted',
      'drv_1',
      {},
      [],
    );

    expect(result.delivered).toEqual(
      c.delivered ? [{ channel: 'email', recipient: 'ana@example.com' }] : [],
    );
    expect(sendMail).toHaveBeenCalledTimes(c.delivered ? 1 : 0);
    if (!c.isEnabled) {
      // The operator switch is checked first: no driver lookup at all.
      expect(queries.some((q) => q.includes('FROM drivers WHERE id'))).toBe(false);
    }
    vi.unstubAllGlobals();
  });
});
