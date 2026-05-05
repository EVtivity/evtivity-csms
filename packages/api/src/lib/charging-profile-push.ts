// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, sql } from 'drizzle-orm';
import {
  db,
  chargingProfilePushes,
  chargingProfilePushStations,
  chargingProfiles,
} from '@evtivity/database';
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
            // Best-effort clear existing profile with same purpose/stackLevel/evseId.
            // OCPP 2.1 requires the criteria nested under `chargingProfileCriteria`;
            // the 1.6 translator unwraps it and maps evseId -> connectorId.
            try {
              await sendOcppCommandAndWait(
                station.stationId,
                'ClearChargingProfile',
                {
                  chargingProfileCriteria: {
                    chargingProfilePurpose: template.profilePurpose,
                    stackLevel: template.stackLevel,
                    evseId: template.evseId,
                  },
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

interface ClearChargingProfileTarget {
  profilePurpose: string;
  stackLevel: number;
  evseId: number;
}

export async function processChargingProfileClear(
  pushId: string,
  stations: { id: string; stationId: string }[],
  target: ClearChargingProfileTarget,
  ocppVersion: string,
): Promise<void> {
  try {
    for (let i = 0; i < stations.length; i += CONCURRENCY_LIMIT) {
      const batch = stations.slice(i, i + CONCURRENCY_LIMIT);
      await Promise.all(
        batch.map(async (station) => {
          try {
            const result = await sendOcppCommandAndWait(
              station.stationId,
              'ClearChargingProfile',
              {
                chargingProfileCriteria: {
                  chargingProfilePurpose: target.profilePurpose,
                  stackLevel: target.stackLevel,
                  evseId: target.evseId,
                },
              },
              `ocpp${ocppVersion}`,
            );

            if (result.error != null) {
              await db
                .update(chargingProfilePushStations)
                .set({ status: 'failed', errorInfo: result.error, updatedAt: new Date() })
                .where(
                  and(
                    eq(chargingProfilePushStations.pushId, pushId),
                    eq(chargingProfilePushStations.stationId, station.id),
                  ),
                );
              return;
            }

            const response = result.response as { status?: string } | undefined;
            // ClearChargingProfile returns Accepted or Unknown per OCPP spec.
            // Both are idempotent successes from the operator's POV: Unknown means
            // "no matching profile found", which is the desired end-state. Mark as
            // accepted with a note so push history doesn't show red on a clean run.
            // Missing status indicates a translator/transport gap rather than a
            // station response, so flag it as failed.
            if (response?.status === 'Accepted') {
              // Mirror the deletion in the CSMS DB so the per-station charging
              // profiles list reflects the on-station state.
              await db
                .delete(chargingProfiles)
                .where(
                  and(
                    eq(chargingProfiles.stationId, station.id),
                    sql`profile_data->>'chargingProfilePurpose' = ${target.profilePurpose}`,
                    sql`(profile_data->>'stackLevel')::int = ${target.stackLevel}`,
                    eq(chargingProfiles.evseId, target.evseId),
                  ),
                );
              await db
                .update(chargingProfilePushStations)
                .set({ status: 'accepted', updatedAt: new Date() })
                .where(
                  and(
                    eq(chargingProfilePushStations.pushId, pushId),
                    eq(chargingProfilePushStations.stationId, station.id),
                  ),
                );
            } else if (response?.status === 'Unknown') {
              await db
                .update(chargingProfilePushStations)
                .set({
                  status: 'accepted',
                  errorInfo: 'no_matching_profile',
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(chargingProfilePushStations.pushId, pushId),
                    eq(chargingProfilePushStations.stationId, station.id),
                  ),
                );
            } else if (response?.status != null) {
              await db
                .update(chargingProfilePushStations)
                .set({ status: 'rejected', errorInfo: response.status, updatedAt: new Date() })
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
                  status: 'failed',
                  errorInfo: 'No status in response',
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(chargingProfilePushStations.pushId, pushId),
                    eq(chargingProfilePushStations.stationId, station.id),
                  ),
                );
            }
          } catch {
            await db
              .update(chargingProfilePushStations)
              .set({ status: 'failed', errorInfo: 'Internal error', updatedAt: new Date() })
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

    await db
      .update(chargingProfilePushes)
      .set({ status: 'completed', updatedAt: new Date() })
      .where(eq(chargingProfilePushes.id, pushId));
  } catch {
    await db
      .update(chargingProfilePushes)
      .set({ status: 'completed', updatedAt: new Date() })
      .where(eq(chargingProfilePushes.id, pushId))
      .catch(() => {});
  }
}
