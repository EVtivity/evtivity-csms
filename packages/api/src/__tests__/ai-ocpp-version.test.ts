// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';
import { AI_TOOL_CATALOG } from '../services/ai/tools/catalog.js';
import { toolPolicy } from '../services/ai/tools/policy.js';
import { chatbotToolset } from '../services/ai/surfaces/toolsets.js';
import type { ToolsetEntry } from '../services/ai/tools/execute.js';
import {
  mapOcppCommand,
  toolOcppVersion,
  translatedOperationIds,
} from '../services/ai/tools/ocpp-version.js';
import type { OcppVersion } from '../services/ai/tools/ocpp-version.js';
import { checkOcppCommandVersion } from '../services/ai/tools/ocpp-command-check.js';
import type { CommandStation } from '../lib/command-station.js';

vi.mock('../lib/command-station.js', () => ({ findCommandStation: vi.fn() }));

const OCPP = chatbotToolset(
  [...new Set(AI_TOOL_CATALOG.filter((t) => toolOcppVersion(t) !== null).map((t) => t.category))],
  AI_TOOL_CATALOG,
);

function ocppEntry(name: string): ToolsetEntry {
  const found = OCPP.byName.get(name);
  if (found === undefined) throw new Error(`no chatbot tool ${name}`);
  return found;
}

function mapTo(name: string, args: Record<string, unknown>, version: OcppVersion) {
  return mapOcppCommand(ocppEntry(name).tool, { stationId: 'CS-1', ...args }, version, {
    remoteStartId: () => 4242,
  });
}

function station(ocppProtocol: string | null): CommandStation {
  return { id: 'sta_000000000001', ocppProtocol };
}

function caller(permitted = true) {
  return { userId: 'usr_1', hasPermission: vi.fn(async () => permitted) };
}

describe('AI OCPP version mapping', () => {
  it('reads the version from the command route path', () => {
    expect(toolOcppVersion(ocppEntry('ocppv16_reset').tool)).toBe('ocpp1.6');
    expect(toolOcppVersion(ocppEntry('ocppv21_reset').tool)).toBe('ocpp2.1');
    expect(toolOcppVersion({ pathTemplate: '/v1/stations/{id}' })).toBeNull();
  });

  it('every translated tool and every target is a chatbot write tool in the catalog', () => {
    for (const operationId of translatedOperationIds()) {
      const tool = AI_TOOL_CATALOG.find((t) => t.operationId === operationId);
      expect(tool, operationId).toBeDefined();
      expect(toolPolicy(operationId).exposure, operationId).toBe('write');
    }
  });

  it('tells the model in each OCPP tool description to check the version first', () => {
    expect(ocppEntry('ocppv16_reset').definition.description).toContain(
      'For OCPP 1.6 stations: check',
    );
    expect(ocppEntry('ocppv21_reset').definition.description).toContain(
      'For OCPP 2.1 stations: check',
    );
  });

  it('a tool of the station version matches', () => {
    expect(mapTo('ocppv21_reset', { type: 'OnIdle' }, 'ocpp2.1')).toEqual({ kind: 'match' });
  });

  it.each([
    ['ocppv16_reset', { type: 'Soft' }, 'ocppv21_Reset', { type: 'OnIdle' }],
    ['ocppv16_reset', { type: 'Hard' }, 'ocppv21_Reset', { type: 'Immediate' }],
    [
      'ocppv16_change_availability',
      { connectorId: 2, type: 'Inoperative' },
      'ocppv21_ChangeAvailability',
      { operationalStatus: 'Inoperative', evse: { id: 2 } },
    ],
    [
      'ocppv16_change_availability',
      { connectorId: 0, type: 'Operative' },
      'ocppv21_ChangeAvailability',
      { operationalStatus: 'Operative' },
    ],
    [
      'ocppv16_unlock_connector',
      { connectorId: 2 },
      'ocppv21_UnlockConnector',
      { evseId: 2, connectorId: 1 },
    ],
    [
      'ocppv16_remote_start_transaction',
      { connectorId: 1, idTag: 'TAG1' },
      'ocppv21_RequestStartTransaction',
      { remoteStartId: 4242, idToken: { idToken: 'TAG1', type: 'Central' }, evseId: 1 },
    ],
    [
      'ocppv16_remote_stop_transaction',
      { transactionId: 17 },
      'ocppv21_RequestStopTransaction',
      { transactionId: '17' },
    ],
    [
      'ocppv16_extended_trigger_message',
      { requestedMessage: 'SignChargePointCertificate' },
      'ocppv21_TriggerMessage',
      { requestedMessage: 'SignChargingStationCertificate' },
    ],
    [
      'ocppv16_clear_charging_profile',
      { id: 3, chargingProfilePurpose: 'ChargePointMaxProfile' },
      'ocppv21_ClearChargingProfile',
      {
        chargingProfileId: 3,
        chargingProfileCriteria: { chargingProfilePurpose: 'ChargingStationMaxProfile' },
      },
    ],
    [
      'ocppv16_reserve_now',
      { connectorId: 1, expiryDate: '2026-10-11T10:00:00Z', idTag: 'TAG1', reservationId: 9 },
      'ocppv21_ReserveNow',
      {
        id: 9,
        expiryDateTime: '2026-10-11T10:00:00Z',
        idToken: { idToken: 'TAG1', type: 'Central' },
        evseId: 1,
      },
    ],
  ])('maps %s to OCPP 2.1', (name, args, operationId, expected) => {
    expect(mapTo(name, args, 'ocpp2.1')).toEqual({
      kind: 'mapped',
      operationId,
      args: { stationId: 'CS-1', ...expected },
    });
  });

  it.each([
    ['ocppv21_reset', { type: 'OnIdle' }, 'ocppv16_Reset', { type: 'Soft' }],
    ['ocppv21_reset', { type: 'Immediate' }, 'ocppv16_Reset', { type: 'Hard' }],
    [
      'ocppv21_change_availability',
      { operationalStatus: 'Operative' },
      'ocppv16_ChangeAvailability',
      { connectorId: 0, type: 'Operative' },
    ],
    [
      'ocppv21_unlock_connector',
      { evseId: 2, connectorId: 1 },
      'ocppv16_UnlockConnector',
      { connectorId: 2 },
    ],
    [
      'ocppv21_request_start_transaction',
      { remoteStartId: 5, idToken: { idToken: 'TAG1', type: 'ISO14443' }, evseId: 2 },
      'ocppv16_RemoteStartTransaction',
      { connectorId: 2, idTag: 'TAG1' },
    ],
    [
      'ocppv21_request_stop_transaction',
      { transactionId: '17' },
      'ocppv16_RemoteStopTransaction',
      { transactionId: 17 },
    ],
    [
      'ocppv21_trigger_message',
      { requestedMessage: 'LogStatusNotification' },
      'ocppv16_ExtendedTriggerMessage',
      { requestedMessage: 'LogStatusNotification' },
    ],
    [
      'ocppv21_trigger_message',
      { requestedMessage: 'StatusNotification', evse: { id: 1 } },
      'ocppv16_TriggerMessage',
      { requestedMessage: 'StatusNotification', connectorId: 1 },
    ],
  ])('maps %s to OCPP 1.6', (name, args, operationId, expected) => {
    expect(mapTo(name, args, 'ocpp1.6')).toEqual({
      kind: 'mapped',
      operationId,
      args: { stationId: 'CS-1', ...expected },
    });
  });

  it('round-trips a charging profile through both versions', () => {
    const profile16 = {
      chargingProfileId: 7,
      stackLevel: 1,
      chargingProfilePurpose: 'TxDefaultProfile',
      chargingProfileKind: 'Absolute',
      chargingSchedule: {
        chargingRateUnit: 'A',
        chargingSchedulePeriod: [{ startPeriod: 0, limit: 16 }],
      },
    };
    const to21 = mapTo(
      'ocppv16_set_charging_profile',
      { connectorId: 1, csChargingProfiles: profile16 },
      'ocpp2.1',
    );
    expect(to21).toMatchObject({
      kind: 'mapped',
      operationId: 'ocppv21_SetChargingProfile',
      args: {
        evseId: 1,
        chargingProfile: {
          id: 7,
          chargingSchedule: [
            {
              id: 7,
              chargingRateUnit: 'A',
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 16 }],
            },
          ],
        },
      },
    });
    if (to21.kind !== 'mapped') throw new Error('not mapped');
    const back = mapTo('ocppv21_set_charging_profile', to21.args, 'ocpp1.6');
    expect(back).toEqual({
      kind: 'mapped',
      operationId: 'ocppv16_SetChargingProfile',
      args: { stationId: 'CS-1', connectorId: 1, csChargingProfiles: profile16 },
    });
  });

  it.each([
    ['ocppv21_reset', { type: 'ImmediateAndResume' }, 'ImmediateAndResume reset type'],
    ['ocppv21_reset', { type: 'OnIdle', evseId: 1 }, 'whole station only'],
    ['ocppv21_request_stop_transaction', { transactionId: 'tx-abc' }, 'numeric transaction id'],
    [
      'ocppv21_request_start_transaction',
      { remoteStartId: 1, idToken: { idToken: 'X'.repeat(21), type: 'Central' } },
      'at most 20 characters',
    ],
    ['ocppv21_set_display_message', { message: {} }, 'no OCPP 1.6 equivalent'],
  ])('refuses %s for a 1.6 station and names the version', (name, args, reason) => {
    const result = mapTo(name, args, 'ocpp1.6');
    expect(result.kind).toBe('unsupported');
    if (result.kind !== 'unsupported') return;
    expect(result.message).toContain('Station CS-1 uses OCPP 1.6');
    expect(result.message).toContain(reason);
    expect(result.message).toContain('Use only ocppv16_ tools');
  });

  it.each([
    ['ocppv16_get_configuration', {}, 'ocppv21_get_variables'],
    ['ocppv16_send_local_list', { listVersion: 1, updateType: 'Full' }, 'token type'],
    ['ocppv16_trigger_message', { requestedMessage: 'DiagnosticsStatusNotification' }, 'trigger'],
  ])('refuses %s for a 2.1 station and names the version', (name, args, reason) => {
    const result = mapTo(name, args, 'ocpp2.1');
    expect(result.kind).toBe('unsupported');
    if (result.kind !== 'unsupported') return;
    expect(result.message).toContain('Station CS-1 uses OCPP 2.1');
    expect(result.message).toContain(reason);
  });
});

describe('AI OCPP command version check', () => {
  const reset16 = () => ({
    entry: ocppEntry('ocppv16_reset'),
    args: { stationId: 'IOCHARGER-002', type: 'Soft' },
  });

  it('maps a 1.6 reset for a 2.1 station to the 2.1 reset, valid for the 2.1 tool', async () => {
    const findStation = vi.fn(async () => station('ocpp2.1'));
    const result = await checkOcppCommandVersion(caller(), reset16(), { findStation });
    expect(findStation).toHaveBeenCalledWith('usr_1', 'IOCHARGER-002');
    expect(result).toMatchObject({
      ok: true,
      args: { stationId: 'IOCHARGER-002', type: 'OnIdle' },
    });
    if (!result.ok) return;
    expect(result.entry.tool.name).toBe('ocppv21_reset');
    expect(result.note).toContain('IOCHARGER-002 uses OCPP 2.1');
    expect(result.note).toContain('ocppv21_reset');
  });

  it('leaves a tool of the station version unchanged', async () => {
    const call = reset16();
    const result = await checkOcppCommandVersion(caller(), call, {
      findStation: async () => station('ocpp1.6'),
    });
    expect(result).toEqual({ ok: true, entry: call.entry, args: call.args });
  });

  it('refuses an unknown or out-of-scope station as not found, the same for both', async () => {
    const result = await checkOcppCommandVersion(caller(), reset16(), {
      findStation: async () => null,
    });
    expect(result).toEqual({
      ok: false,
      refusal: {
        reason: 'station_not_found',
        modelText: 'Station not found: IOCHARGER-002. Check the station ID with a station lookup.',
      },
    });
  });

  it('refuses a command with no equivalent with the station version', async () => {
    const result = await checkOcppCommandVersion(
      caller(),
      { entry: ocppEntry('ocppv16_get_configuration'), args: { stationId: 'IOCHARGER-002' } },
      { findStation: async () => station('ocpp2.1') },
    );
    expect(result).toMatchObject({ ok: false, refusal: { reason: 'ocpp_version_mismatch' } });
    if (result.ok) return;
    expect(result.refusal.modelText).toContain('uses OCPP 2.1');
  });

  it('refuses a translation the target schema rejects', async () => {
    const result = await checkOcppCommandVersion(
      caller(),
      {
        entry: ocppEntry('ocppv16_unlock_connector'),
        args: { stationId: 'IOCHARGER-002', connectorId: 1.5 },
      },
      { findStation: async () => station('ocpp2.1') },
    );
    expect(result).toMatchObject({ ok: false, refusal: { reason: 'ocpp_version_mismatch' } });
  });

  it('does not look the station up without stations:read (the route decides on confirm)', async () => {
    const findStation = vi.fn(async () => station('ocpp2.1'));
    const call = reset16();
    const result = await checkOcppCommandVersion(caller(false), call, { findStation });
    expect(findStation).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, entry: call.entry, args: call.args });
  });

  it('leaves non-OCPP tools and never-connected stations alone', async () => {
    const findStation = vi.fn(async () => station(null));
    const other = AI_TOOL_CATALOG.find((t) => toolOcppVersion(t) === null && t.method !== 'GET');
    if (other === undefined) throw new Error('no other write tool');
    const otherEntry = { ...ocppEntry('ocppv16_reset'), tool: other };
    expect(await checkOcppCommandVersion(caller(), { entry: otherEntry, args: {} })).toMatchObject({
      ok: true,
      entry: otherEntry,
    });
    const call = reset16();
    expect(await checkOcppCommandVersion(caller(), call, { findStation })).toEqual({
      ok: true,
      entry: call.entry,
      args: call.args,
    });
  });
});
