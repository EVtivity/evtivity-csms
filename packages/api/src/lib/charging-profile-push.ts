// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and } from 'drizzle-orm';
import { db, chargingProfilePushes, chargingProfilePushStations } from '@evtivity/database';
import { createLogger, UNCLEARABLE_PROFILE_PURPOSES } from '@evtivity/lib';
import { sendOcppCommandAndWait } from '@evtivity/services/ocpp-command';
import {
  isReservedProfileId,
  loadManagedMessage,
  loadManagedStationIds,
  maxExternalConstraintsIds,
  mayOverrideLoadManagement,
  overridesLoadManagement,
  reservedProfileIdMessage,
  type ProfileIdentity,
} from './charging-profile-id.js';

/** The CSMS must not name these purposes in a ClearChargingProfile (2.1 K10.FR.06). */
function isUnclearablePurpose(purpose: string): boolean {
  return (UNCLEARABLE_PROFILE_PURPOSES as readonly string[]).includes(purpose);
}

const logger = createLogger('charging-profile-push');

const CONCURRENCY_LIMIT = 10;

// Every station update is guarded by `status = 'pending'` and the push update
// by `status = 'active'`: a station result and a completed push are terminal,
// so a late result after the worker's charging-profile-push-sweep ended an
// interrupted push changes nothing (P5).

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

/**
 * Clears the profile slot (purpose, stack level, EVSE) a template push writes
 * to (2.1 K01.FR.06). The OCPP server's ClearChargingProfile projection removes
 * the stored copies when the station accepts.
 */
export async function clearProfileSlotBeforePush(
  stationOcppId: string,
  slot: { profilePurpose: string; stackLevel: number; evseId: number },
): Promise<void> {
  // A LocalGeneration profile cannot be cleared; the Set with the template's
  // profile id replaces it (K01.FR.05).
  if (isUnclearablePurpose(slot.profilePurpose)) return;
  await sendOcppCommandAndWait(stationOcppId, 'ClearChargingProfile', {
    chargingProfileCriteria: {
      chargingProfilePurpose: slot.profilePurpose,
      stackLevel: slot.stackLevel,
      evseId: slot.evseId,
    },
  });
}

export async function processChargingProfilePush(
  pushId: string,
  stations: { id: string; stationId: string }[],
  template: ChargingProfileTemplate,
  ocppVersion: string,
): Promise<void> {
  try {
    // K01.FR.81: a 2.1 station rejects a profile id at or below its
    // MaxExternalConstraintsId. Such a station fails without a command.
    const maxExternalIds =
      ocppVersion === '2.1'
        ? await maxExternalConstraintsIds(stations.map((s) => s.id))
        : new Map<string, number>();
    // A profile that would override the load management limit of a managed
    // station (charging-profile-id.ts) is not sent to it: the station fails.
    const identity: ProfileIdentity = {
      profileId: template.profileId,
      purpose: template.profilePurpose,
      stackLevel: template.stackLevel,
    };
    const loadManaged = mayOverrideLoadManagement(identity)
      ? await loadManagedStationIds(stations.map((s) => s.id))
      : new Set<string>();
    for (let i = 0; i < stations.length; i += CONCURRENCY_LIMIT) {
      const batch = stations.slice(i, i + CONCURRENCY_LIMIT);
      await Promise.all(
        batch.map(async (station) => {
          try {
            const maxExternalId = maxExternalIds.get(station.id);
            if (maxExternalId != null && isReservedProfileId(template.profileId, maxExternalId)) {
              await db
                .update(chargingProfilePushStations)
                .set({
                  status: 'failed',
                  errorInfo: reservedProfileIdMessage(template.profileId, maxExternalId),
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(chargingProfilePushStations.pushId, pushId),
                    eq(chargingProfilePushStations.stationId, station.id),
                    eq(chargingProfilePushStations.status, 'pending'),
                  ),
                );
              return;
            }
            if (
              loadManaged.has(station.id) &&
              overridesLoadManagement(identity, maxExternalIds.get(station.id))
            ) {
              await db
                .update(chargingProfilePushStations)
                .set({
                  status: 'failed',
                  errorInfo: loadManagedMessage(identity),
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(chargingProfilePushStations.pushId, pushId),
                    eq(chargingProfilePushStations.stationId, station.id),
                    eq(chargingProfilePushStations.status, 'pending'),
                  ),
                );
              return;
            }
            // Best-effort clear existing profile with same purpose/stackLevel/evseId.
            // OCPP 2.1 requires the criteria nested under `chargingProfileCriteria`;
            // the 1.6 translator unwraps it and maps evseId -> connectorId.
            try {
              await clearProfileSlotBeforePush(station.stationId, template);
            } catch (err) {
              logger.warn(
                { err, pushId, stationId: station.stationId },
                'ClearChargingProfile before the push failed, sending SetChargingProfile anyway',
              );
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
                    eq(chargingProfilePushStations.status, 'pending'),
                  ),
                );
            } else {
              const response = result.response as
                | {
                    status?: string;
                    statusInfo?: { reasonCode?: string; additionalInfo?: string };
                  }
                | undefined;
              if (response?.status === 'Accepted') {
                // Auto-refresh station_reported rows on OCPP 2.1 stations
                // so the CSMS mirror reflects the new on-station profile
                // set without requiring a manual Refresh. 1.6 has no
                // GetChargingProfiles command. Fire-and-forget.
                if (ocppVersion === '2.1') {
                  void sendOcppCommandAndWait(station.stationId, 'GetChargingProfiles', {
                    requestId: Math.floor(Math.random() * 2147483647),
                    chargingProfile: {},
                  }).catch((err: unknown) => {
                    logger.warn(
                      { err, pushId, stationId: station.stationId },
                      'GetChargingProfiles refresh after the push failed',
                    );
                  });
                }
                await db
                  .update(chargingProfilePushStations)
                  .set({ status: 'accepted', updatedAt: new Date() })
                  .where(
                    and(
                      eq(chargingProfilePushStations.pushId, pushId),
                      eq(chargingProfilePushStations.stationId, station.id),
                      eq(chargingProfilePushStations.status, 'pending'),
                    ),
                  );
              } else {
                // Surface the station's actual rejection reason from
                // SetChargingProfileResponse.statusInfo per OCPP 2.1, not
                // just the bare status enum value. Without this the push
                // history records "Rejected" with no diagnostic detail.
                const reasonCode = response?.statusInfo?.reasonCode;
                const additionalInfo = response?.statusInfo?.additionalInfo;
                const errorInfo =
                  reasonCode != null && reasonCode !== ''
                    ? additionalInfo != null && additionalInfo !== ''
                      ? `${reasonCode}: ${additionalInfo}`
                      : reasonCode
                    : (response?.status ?? 'Unknown');
                await db
                  .update(chargingProfilePushStations)
                  .set({
                    status: 'rejected',
                    errorInfo,
                    updatedAt: new Date(),
                  })
                  .where(
                    and(
                      eq(chargingProfilePushStations.pushId, pushId),
                      eq(chargingProfilePushStations.stationId, station.id),
                      eq(chargingProfilePushStations.status, 'pending'),
                    ),
                  );
              }
            }
          } catch (err) {
            logger.warn(
              { err, pushId, stationId: station.stationId },
              'Charging profile push to the station failed, marking the station failed',
            );
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
                  eq(chargingProfilePushStations.status, 'pending'),
                ),
              )
              .catch((markErr: unknown) => {
                // fail-open: the other stations of the push still run.
                logger.warn(
                  { err: markErr, pushId, stationId: station.stationId },
                  'Marking the station failed in the charging profile operation failed',
                );
              });
          }
        }),
      );
    }

    // Mark push as completed
    await db
      .update(chargingProfilePushes)
      .set({ status: 'completed', updatedAt: new Date() })
      .where(and(eq(chargingProfilePushes.id, pushId), eq(chargingProfilePushes.status, 'active')));
  } catch (err) {
    logger.error({ err, pushId }, 'Charging profile push failed, marking the push completed');
    await db
      .update(chargingProfilePushes)
      .set({ status: 'completed', updatedAt: new Date() })
      .where(and(eq(chargingProfilePushes.id, pushId), eq(chargingProfilePushes.status, 'active')))
      .catch((markErr: unknown) => {
        logger.warn({ err: markErr, pushId }, 'Marking the charging profile push completed failed');
      });
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
            if (isUnclearablePurpose(target.profilePurpose)) {
              await db
                .update(chargingProfilePushStations)
                .set({
                  status: 'rejected',
                  errorInfo: `${target.profilePurpose} profiles cannot be cleared by the CSMS`,
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(chargingProfilePushStations.pushId, pushId),
                    eq(chargingProfilePushStations.stationId, station.id),
                    eq(chargingProfilePushStations.status, 'pending'),
                  ),
                );
              return;
            }
            const result = await sendOcppCommandAndWait(station.stationId, 'ClearChargingProfile', {
              chargingProfileCriteria: {
                chargingProfilePurpose: target.profilePurpose,
                stackLevel: target.stackLevel,
                evseId: target.evseId,
              },
            });

            if (result.error != null) {
              await db
                .update(chargingProfilePushStations)
                .set({ status: 'failed', errorInfo: result.error, updatedAt: new Date() })
                .where(
                  and(
                    eq(chargingProfilePushStations.pushId, pushId),
                    eq(chargingProfilePushStations.stationId, station.id),
                    eq(chargingProfilePushStations.status, 'pending'),
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
              // Auto-refresh station_reported rows on OCPP 2.1 stations so the
              // CSMS mirror reflects the station's new state. 1.6 has no
              // GetChargingProfiles command (and no ReportChargingProfiles
              // payload); the ClearChargingProfile projection updates the copy.
              if (ocppVersion === '2.1') {
                void sendOcppCommandAndWait(station.stationId, 'GetChargingProfiles', {
                  requestId: Math.floor(Math.random() * 2147483647),
                  chargingProfile: {},
                }).catch((err: unknown) => {
                  // Best-effort; do not block clear bookkeeping on refresh failure.
                  logger.warn(
                    { err, pushId, stationId: station.stationId },
                    'GetChargingProfiles refresh after the clear failed',
                  );
                });
              }
              await db
                .update(chargingProfilePushStations)
                .set({ status: 'accepted', updatedAt: new Date() })
                .where(
                  and(
                    eq(chargingProfilePushStations.pushId, pushId),
                    eq(chargingProfilePushStations.stationId, station.id),
                    eq(chargingProfilePushStations.status, 'pending'),
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
                    eq(chargingProfilePushStations.status, 'pending'),
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
                    eq(chargingProfilePushStations.status, 'pending'),
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
                    eq(chargingProfilePushStations.status, 'pending'),
                  ),
                );
            }
          } catch (err) {
            logger.warn(
              { err, pushId, stationId: station.stationId },
              'Charging profile clear on the station failed, marking the station failed',
            );
            await db
              .update(chargingProfilePushStations)
              .set({ status: 'failed', errorInfo: 'Internal error', updatedAt: new Date() })
              .where(
                and(
                  eq(chargingProfilePushStations.pushId, pushId),
                  eq(chargingProfilePushStations.stationId, station.id),
                  eq(chargingProfilePushStations.status, 'pending'),
                ),
              )
              .catch((markErr: unknown) => {
                // fail-open: the other stations of the push still run.
                logger.warn(
                  { err: markErr, pushId, stationId: station.stationId },
                  'Marking the station failed in the charging profile operation failed',
                );
              });
          }
        }),
      );
    }

    await db
      .update(chargingProfilePushes)
      .set({ status: 'completed', updatedAt: new Date() })
      .where(and(eq(chargingProfilePushes.id, pushId), eq(chargingProfilePushes.status, 'active')));
  } catch (err) {
    logger.error({ err, pushId }, 'Charging profile clear failed, marking the push completed');
    await db
      .update(chargingProfilePushes)
      .set({ status: 'completed', updatedAt: new Date() })
      .where(and(eq(chargingProfilePushes.id, pushId), eq(chargingProfilePushes.status, 'active')))
      .catch((markErr: unknown) => {
        logger.warn(
          { err: markErr, pushId },
          'Marking the charging profile clear completed failed',
        );
      });
  }
}
