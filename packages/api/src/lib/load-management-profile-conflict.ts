// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  evseManagedClearConflict,
  evseManagedClearMessage,
  evseManagedConnectorMessage,
  evseManagedProfileIdConflict,
  evseManagedProfileIdMessage,
  evseManagedSessionMessage,
  isEvseManagedConnectorSession,
  isEvseManagedTransaction,
  isLoadManagedStationIdentity,
  isPlannedConnectorSession,
  isPlannedTransaction,
  loadManagedClearConflict,
  loadManagedClearMessage,
  loadManagedMessage,
  maxExternalConstraintsIdByIdentity,
  mayOverrideLoadManagement,
  overridesLoadManagement,
  plannedClearConflict,
  plannedClearMessage,
  plannedConnectorMessage,
  plannedProfileIdConflict,
  plannedProfileIdMessage,
  plannedSessionMessage,
  profileIdentityFromRequest,
  txProfileConnectorWithoutTransaction,
  txProfileTransactionId,
  unitBoxDefaultClearConflict,
  unitBoxDefaultClearMessage,
  unitBoxDefaultConflict,
  unitBoxDefaultMessage,
  usePriorityChargingMessage,
} from './charging-profile-id.js';

/** The commands the load management rule of the other profile writers covers (safety spec I7). */
export type LoadManagedProfileAction =
  | 'SetChargingProfile'
  | 'ClearChargingProfile'
  | 'UsePriorityCharging';

/**
 * The one rule of every other writer of charging profiles on a station load
 * management may manage (safety spec I7): the refusal message when the
 * command could lift or remove a load management limit, else null. A
 * SetChargingProfile (2.1 or 1.6 form) that overrides the station limit or
 * uses its or the credit profile's id, a profile with the TxProfile id of a
 * planned session or of a session limited per EVSE, a TxProfile for such a
 * session (by transaction, or by connector in 1.6); a UsePriorityCharging; a
 * ClearChargingProfile that could remove the station limit, the credit
 * profile, a plan TxProfile or an EVSE limit; a unit box default lifted,
 * replaced or cleared (`unitBoxDefaultConflict`). Reads the database only for a
 * command that could. `maxExternalId`: the station's MaxExternalConstraintsId
 * when the caller read it already.
 */
export async function loadManagementProfileConflict(
  stationIdentity: string,
  action: LoadManagedProfileAction,
  payload: Record<string, unknown>,
  options: { maxExternalId?: number | null } = {},
): Promise<string | null> {
  if (action === 'UsePriorityCharging') {
    return (await isLoadManagedStationIdentity(stationIdentity))
      ? usePriorityChargingMessage()
      : null;
  }
  if (action === 'ClearChargingProfile') {
    if (await loadManagedClearConflict(stationIdentity, payload)) return loadManagedClearMessage();
    const plannedClear = await plannedClearConflict(stationIdentity, payload);
    if (plannedClear != null) return plannedClearMessage(plannedClear);
    const evseClear = await evseManagedClearConflict(stationIdentity, payload);
    if (evseClear != null) return evseManagedClearMessage(evseClear);
    if (await unitBoxDefaultClearConflict(stationIdentity, payload)) {
      return unitBoxDefaultClearMessage();
    }
    return null;
  }
  const profile = profileIdentityFromRequest(payload);
  if (mayOverrideLoadManagement(profile)) {
    const maxExternalId =
      options.maxExternalId !== undefined
        ? options.maxExternalId
        : await maxExternalConstraintsIdByIdentity(stationIdentity);
    if (
      overridesLoadManagement(profile, maxExternalId) &&
      (await isLoadManagedStationIdentity(stationIdentity))
    ) {
      return loadManagedMessage(profile);
    }
  }
  if (profile.profileId != null) {
    // Any profile with the TxProfile id of a planned session replaces the plan
    // profile, and one of a session limited per EVSE that limit, whatever its purpose.
    const planIdTransaction = await plannedProfileIdConflict(stationIdentity, profile.profileId);
    if (planIdTransaction != null) {
      return plannedProfileIdMessage(profile.profileId, planIdTransaction);
    }
    const evseIdTransaction = await evseManagedProfileIdConflict(
      stationIdentity,
      profile.profileId,
    );
    if (evseIdTransaction != null) {
      return evseManagedProfileIdMessage(profile.profileId, evseIdTransaction);
    }
  }
  const boxEvse = await unitBoxDefaultConflict(stationIdentity, payload);
  if (boxEvse != null) return unitBoxDefaultMessage(boxEvse);
  const transaction = txProfileTransactionId(payload);
  if (transaction != null) {
    if (await isPlannedTransaction(stationIdentity, transaction)) {
      return plannedSessionMessage(transaction);
    }
    if (await isEvseManagedTransaction(stationIdentity, transaction)) {
      return evseManagedSessionMessage(transaction);
    }
  }
  // A 1.6 TxProfile without a transactionId applies to the connector's transaction.
  const connector = txProfileConnectorWithoutTransaction(payload);
  if (connector != null) {
    if (await isPlannedConnectorSession(stationIdentity, connector)) {
      return plannedConnectorMessage(connector);
    }
    if (await isEvseManagedConnectorSession(stationIdentity, connector)) {
      return evseManagedConnectorMessage(connector);
    }
  }
  return null;
}

/** The SetChargingProfile fields of a profile template the load management rule reads. */
export function templateProfilePayload(template: {
  profileId: number;
  profilePurpose: string;
  stackLevel: number;
  evseId: number;
}): Record<string, unknown> {
  return {
    evseId: template.evseId,
    chargingProfile: {
      id: template.profileId,
      chargingProfilePurpose: template.profilePurpose,
      stackLevel: template.stackLevel,
    },
  };
}

/** A ClearChargingProfile request of a template clear target (2.1 form). */
export function templateClearPayload(target: {
  profilePurpose: string;
  stackLevel: number | null;
  evseId: number | null;
}): Record<string, unknown> {
  return {
    chargingProfileCriteria: {
      chargingProfilePurpose: target.profilePurpose,
      stackLevel: target.stackLevel,
      evseId: target.evseId,
    },
  };
}
