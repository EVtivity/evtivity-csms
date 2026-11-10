// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq, sql } from 'drizzle-orm';
import type { DriverNotificationChannel } from '@evtivity/lib/notification-events';
import { db } from '../config.js';
import { driverEventSettings } from '../schema/notifications.js';
import {
  driverNotificationEventPreferences,
  driverNotificationPreferences,
} from '../schema/drivers.js';

// The only writer of driver_event_settings, driver_notification_preferences and
// driver_notification_event_preferences (guard test
// driver-notification-writer-guard.test.ts). The layers, in order (discussion 56):
// (1) the operator turns a driver event off for everyone (`is_enabled`), which
// wins over everything; (2) the operator makes an enabled event mandatory per
// channel (`*_mandatory`); (3) the driver chooses per event and channel, else the
// channel switch decides. No rules and no audit here: the routes decide and audit,
// and the dispatcher (`@evtivity/lib/notification-dispatch`) applies the layers.

export type DriverNotificationDb = Pick<
  typeof db,
  'select' | 'insert' | 'update' | 'delete' | 'execute' | 'transaction'
>;

export type DriverEventSettingRow = typeof driverEventSettings.$inferSelect;

export interface DriverChannelSwitches {
  email: boolean;
  sms: boolean;
  push: boolean;
}

/** Every stored operator setting of a driver event. No row means on, nothing mandatory. */
export async function listDriverEventSettings(
  tx: DriverNotificationDb = db,
): Promise<DriverEventSettingRow[]> {
  return tx.select().from(driverEventSettings);
}

export async function getDriverEventSettingRow(
  eventType: string,
  tx: DriverNotificationDb = db,
): Promise<DriverEventSettingRow | null> {
  const [row] = await tx
    .select()
    .from(driverEventSettings)
    .where(eq(driverEventSettings.eventType, eventType));
  return row ?? null;
}

/** Turns a driver event on or off for every driver. Returns the stored row. */
export async function setDriverEventSwitch(
  eventType: string,
  isEnabled: boolean,
  tx: DriverNotificationDb = db,
): Promise<DriverEventSettingRow> {
  const [row] = await tx
    .insert(driverEventSettings)
    .values({ eventType, isEnabled })
    .onConflictDoUpdate({
      target: [driverEventSettings.eventType],
      set: { isEnabled, updatedAt: new Date() },
    })
    .returning();
  if (row == null) throw new Error('Driver event setting upsert returned no row');
  return row;
}

/** Marks channels of a driver event mandatory or optional. Unnamed channels keep their value. */
export async function setDriverEventMandatory(
  eventType: string,
  changes: Partial<Record<DriverNotificationChannel, boolean>>,
  tx: DriverNotificationDb = db,
): Promise<DriverEventSettingRow> {
  const set: Partial<typeof driverEventSettings.$inferInsert> = {};
  if (changes.email != null) set.emailMandatory = changes.email;
  if (changes.sms != null) set.smsMandatory = changes.sms;
  if (changes.push != null) set.pushMandatory = changes.push;
  const [row] = await tx
    .insert(driverEventSettings)
    .values({ eventType, ...set })
    .onConflictDoUpdate({
      target: [driverEventSettings.eventType],
      set: { ...set, updatedAt: new Date() },
    })
    .returning();
  if (row == null) throw new Error('Driver event setting upsert returned no row');
  return row;
}

export interface DriverNotificationState {
  /** The stored channel switches; null when the driver never saved preferences (all on). */
  switches: DriverChannelSwitches | null;
  /** The driver's stored choices per event. */
  choices: Map<string, Partial<Record<DriverNotificationChannel, boolean>>>;
}

export async function readDriverNotificationState(
  driverId: string,
  tx: DriverNotificationDb = db,
): Promise<DriverNotificationState> {
  const [switchRows, choiceRows] = await Promise.all([
    tx
      .select({
        email: driverNotificationPreferences.emailEnabled,
        sms: driverNotificationPreferences.smsEnabled,
        push: driverNotificationPreferences.pushEnabled,
      })
      .from(driverNotificationPreferences)
      .where(eq(driverNotificationPreferences.driverId, driverId)),
    tx
      .select({
        eventType: driverNotificationEventPreferences.eventType,
        channel: driverNotificationEventPreferences.channel,
        enabled: driverNotificationEventPreferences.enabled,
      })
      .from(driverNotificationEventPreferences)
      .where(eq(driverNotificationEventPreferences.driverId, driverId)),
  ]);
  const choices = new Map<string, Partial<Record<DriverNotificationChannel, boolean>>>();
  for (const row of choiceRows) {
    const entry = choices.get(row.eventType) ?? {};
    entry[row.channel as DriverNotificationChannel] = row.enabled;
    choices.set(row.eventType, entry);
  }
  return { switches: switchRows[0] ?? null, choices };
}

export interface DriverEventChoice {
  eventType: string;
  channel: DriverNotificationChannel;
  enabled: boolean;
}

/**
 * Stores a driver's preferences in one transaction. A channel switch is the all on
 * or all off shortcut: it sets the channel value and drops that channel's event
 * choices, so every optional event follows it. Event choices are written after the
 * switches, so a request can turn a channel off and one event back on.
 */
export async function applyDriverNotificationPreferences(
  driverId: string,
  changes: {
    switches?: Partial<Record<DriverNotificationChannel, boolean>>;
    events?: readonly DriverEventChoice[];
  },
  tx: DriverNotificationDb = db,
): Promise<void> {
  await tx.transaction(async (trx) => {
    const switches = changes.switches ?? {};
    const switchChannels = (Object.keys(switches) as DriverNotificationChannel[]).filter(
      (channel) => switches[channel] != null,
    );
    if (switchChannels.length > 0) {
      const set: Partial<typeof driverNotificationPreferences.$inferInsert> = {};
      if (switches.email != null) set.emailEnabled = switches.email;
      if (switches.sms != null) set.smsEnabled = switches.sms;
      if (switches.push != null) set.pushEnabled = switches.push;
      await trx
        .insert(driverNotificationPreferences)
        .values({ driverId, ...set })
        .onConflictDoUpdate({
          target: driverNotificationPreferences.driverId,
          set: { ...set, updatedAt: new Date() },
        });
      for (const channel of switchChannels) {
        await trx
          .delete(driverNotificationEventPreferences)
          .where(
            and(
              eq(driverNotificationEventPreferences.driverId, driverId),
              eq(driverNotificationEventPreferences.channel, channel),
            ),
          );
      }
    }
    // One row per event and channel: the last entry wins (one insert cannot
    // update the same row twice).
    const byKey = new Map<string, DriverEventChoice>();
    for (const event of changes.events ?? [])
      byKey.set(`${event.eventType}:${event.channel}`, event);
    const events = [...byKey.values()];
    if (events.length > 0) {
      await trx
        .insert(driverNotificationEventPreferences)
        .values(
          events.map((event) => ({
            driverId,
            eventType: event.eventType,
            channel: event.channel,
            enabled: event.enabled,
          })),
        )
        .onConflictDoUpdate({
          target: [
            driverNotificationEventPreferences.driverId,
            driverNotificationEventPreferences.eventType,
            driverNotificationEventPreferences.channel,
          ],
          set: { enabled: sql`excluded.enabled`, updatedAt: new Date() },
        });
    }
  });
}

/** Deletes every notification preference of a driver (the erasure, in its transaction). */
export async function deleteDriverNotificationPreferences(
  driverId: string,
  tx: DriverNotificationDb = db,
): Promise<void> {
  await tx
    .delete(driverNotificationEventPreferences)
    .where(eq(driverNotificationEventPreferences.driverId, driverId));
  await tx
    .delete(driverNotificationPreferences)
    .where(eq(driverNotificationPreferences.driverId, driverId));
}
