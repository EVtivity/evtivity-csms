// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  DRIVER_NOTIFICATION_CHANNELS,
  DRIVER_PREFERENCE_EVENT_TYPES,
  driverPreferenceEventGroup,
  type DriverNotificationChannel,
  type DriverPreferenceEventGroup,
} from '@evtivity/lib/notification-events';
import type { DriverEventSettingRow, DriverNotificationState } from '@evtivity/database';

// What a driver sees of their notification preferences (discussion 56), built
// from the three layers: (1) an event the operator turned off is not shown;
// (2) a channel the operator made mandatory shows on and locked; (3) the
// driver's event choice, else the channel switch.

export type ChannelFlags = Record<DriverNotificationChannel, boolean>;

export interface EventChannelView {
  enabled: boolean;
  mandatory: boolean;
}

export interface PreferenceEventView {
  eventType: string;
  group: DriverPreferenceEventGroup;
  email: EventChannelView;
  sms: EventChannelView;
  push: EventChannelView;
}

export interface NotificationPreferencesView {
  emailEnabled: boolean;
  smsEnabled: boolean;
  pushEnabled: boolean;
  channels: ChannelFlags;
  events: PreferenceEventView[];
}

export function mandatoryOf(row: DriverEventSettingRow | undefined): ChannelFlags {
  return {
    email: row?.emailMandatory === true,
    sms: row?.smsMandatory === true,
    push: row?.pushMandatory === true,
  };
}

export function buildNotificationPreferencesView(
  state: DriverNotificationState,
  settings: readonly DriverEventSettingRow[],
  channels: ChannelFlags,
): NotificationPreferencesView {
  const byEvent = new Map(settings.map((row) => [row.eventType, row]));
  const events: PreferenceEventView[] = [];
  for (const eventType of DRIVER_PREFERENCE_EVENT_TYPES) {
    const row = byEvent.get(eventType);
    // Layer 1: an event the operator turned off is never sent, so it is no choice.
    if (row?.isEnabled === false) continue;
    const group = driverPreferenceEventGroup(eventType);
    if (group == null) continue;
    const mandatory = mandatoryOf(row);
    const choices = state.choices.get(eventType) ?? {};
    const one = (channel: DriverNotificationChannel): EventChannelView => ({
      mandatory: mandatory[channel],
      enabled: mandatory[channel] || (choices[channel] ?? state.switches?.[channel] ?? true),
    });
    events.push({ eventType, group, email: one('email'), sms: one('sms'), push: one('push') });
  }
  // The channel switch shows on while any optional event of the channel is on;
  // with no optional event, the stored value.
  const switchOf = (channel: DriverNotificationChannel): boolean => {
    const optional = events.filter((event) => !event[channel].mandatory);
    if (optional.length === 0) return state.switches?.[channel] ?? true;
    return optional.some((event) => event[channel].enabled);
  };
  return {
    emailEnabled: switchOf('email'),
    smsEnabled: switchOf('sms'),
    pushEnabled: switchOf('push'),
    channels,
    events,
  };
}

/**
 * The channel shortcuts a request really changes: a client that sends the shown
 * value back (an older portal or app saving another field) changes nothing, so
 * the driver's event choices of that channel stay.
 */
export function changedChannelSwitches(
  body: Partial<Record<'emailEnabled' | 'smsEnabled' | 'pushEnabled', boolean | undefined>>,
  view: NotificationPreferencesView,
): Partial<ChannelFlags> {
  const out: Partial<ChannelFlags> = {};
  for (const channel of DRIVER_NOTIFICATION_CHANNELS) {
    const key = `${channel}Enabled` as const;
    const value = body[key];
    if (value != null && value !== view[key]) out[channel] = value;
  }
  return out;
}
