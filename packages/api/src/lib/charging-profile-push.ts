// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and } from 'drizzle-orm';
import { db, chargingProfilePushes, chargingProfilePushStations } from '@evtivity/database';
import { sendOcppCommandAndWait } from './ocpp-command.js';

const CONCURRENCY_LIMIT = 10;

interface ChargingProfileTemplate {
  profileId: number;
  profilePurpose: string;
  profileKind: string;
  recurrencyKind: string | null;
  stackLevel: number;
  evseId: number;
  chargingRateUnit: string;
  schedulePeriods: unknown;
  startSchedule: Date | null;
  duration: number | null;
  validFrom: Date | null;
  validTo: Date | null;
}

export async function processChargingProfilePush(
  pushId: string,
  stations: { id: string; stationId: string }[],
  template: ChargingProfileTemplate,
  ocppVersion: string,
): Promise<void> {
  try {
    for (let i = 0; i < stations.length; i += CONCURRENCY_LIMIT) {
      const batch = stations.slice(i, i + CONCURRENCY_LIMIT);
      await Promise.all(
        batch.map(async (station) => {
          try {
            // Best-effort clear existing profile with same purpose/stackLevel/evseId
            try {
              await sendOcppCommandAndWait(
                station.stationId,
                'ClearChargingProfile',
                {
                  chargingProfilePurpose: template.profilePurpose,
                  stackLevel: template.stackLevel,
                  evseId: template.evseId,
                },
                `ocpp${ocppVersion}`,
              );
            } catch {
              // Non-critical: clear failure should not block set
            }

            // Build SetChargingProfile payload
            const payload = {
              evseId: template.evseId,
              chargingProfile: {
                id: template.profileId,
                stackLevel: template.stackLevel,
                chargingProfilePurpose: template.profilePurpose,
                chargingProfileKind: template.profileKind,
                recurrencyKind: template.recurrencyKind || undefined,
                validFrom: template.validFrom?.toISOString() || undefined,
                validTo: template.validTo?.toISOString() || undefined,
                chargingSchedule: [
                  {
                    id: 1,
                    chargingRateUnit: template.chargingRateUnit,
                    startSchedule: template.startSchedule?.toISOString() || undefined,
                    duration: template.duration || undefined,
                    chargingSchedulePeriod: template.schedulePeriods,
                  },
                ],
              },
            };

            const result = await sendOcppCommandAndWait(
              station.stationId,
              'SetChargingProfile',
              payload,
              `ocpp${ocppVersion}`,
            );

            if (result.error != null) {
              await db
                .update(chargingProfilePushStations)
                .set({
                  status: 'failed',
                  errorInfo: result.error,
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(chargingProfilePushStations.pushId, pushId),
                    eq(chargingProfilePushStations.stationId, station.id),
                  ),
                );
            } else {
              const response = result.response as { status?: string } | undefined;
              if (response?.status === 'Accepted') {
                await db
                  .update(chargingProfilePushStations)
                  .set({ status: 'accepted', updatedAt: new Date() })
                  .where(
                    and(
                      eq(chargingProfilePushStations.pushId, pushId),
                      eq(chargingProfilePushStations.stationId, station.id),
                    ),
                  );
              } else {
                await db
                  .update(chargingProfilePushStations)
                  .set({
                    status: 'rejected',
                    errorInfo: response?.status ?? 'Unknown',
                    updatedAt: new Date(),
                  })
                  .where(
                    and(
                      eq(chargingProfilePushStations.pushId, pushId),
                      eq(chargingProfilePushStations.stationId, station.id),
                    ),
                  );
              }
            }
          } catch {
            await db
              .update(chargingProfilePushStations)
              .set({
                status: 'failed',
                errorInfo: 'Internal error',
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(chargingProfilePushStations.pushId, pushId),
                  eq(chargingProfilePushStations.stationId, station.id),
                ),
              );
          }
        }),
      );
    }

    // Mark push as completed
    await db
      .update(chargingProfilePushes)
      .set({ status: 'completed', updatedAt: new Date() })
      .where(eq(chargingProfilePushes.id, pushId));
  } catch {
    // If something goes wrong at the batch level, still try to mark as completed
    await db
      .update(chargingProfilePushes)
      .set({ status: 'completed', updatedAt: new Date() })
      .where(eq(chargingProfilePushes.id, pushId))
      .catch(() => {});
  }
}
