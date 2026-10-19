// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { translateCommand, translateResponse } from '../server/command-translation.js';
import { OCPP21_ONLY_ACTIONS } from '@evtivity/lib';
import { ocpp21OnlyRegistryActions } from '../server/ocpp-registry.js';
import { ActionRegistry as Registry21 } from '../generated/v2_1/registry.js';
import { ActionRegistry as Registry201 } from '../generated/v2_0_1/registry.js';
import { validateSetChargingProfile } from '../generated/v1_6/validators/SetChargingProfile.validator.js';
import { validateClearChargingProfile } from '../generated/v1_6/validators/ClearChargingProfile.validator.js';
import { validateSendLocalList } from '../generated/v1_6/validators/SendLocalList.validator.js';
import { validateCertificateSigned } from '../generated/v1_6/validators/CertificateSigned.validator.js';

describe('command-translation', () => {
  describe('translateCommand', () => {
    describe('Reset', () => {
      it('maps Immediate to Hard for ocpp1.6', () => {
        const result = translateCommand('Reset', 'ocpp1.6', { type: 'Immediate' });
        expect(result).toEqual({ action: 'Reset', payload: { type: 'Hard' } });
      });

      it('maps OnIdle to Soft for ocpp1.6', () => {
        const result = translateCommand('Reset', 'ocpp1.6', { type: 'OnIdle' });
        expect(result).toEqual({ action: 'Reset', payload: { type: 'Soft' } });
      });

      it('passes type through unchanged for ocpp2.1', () => {
        const result = translateCommand('Reset', 'ocpp2.1', { type: 'Immediate' });
        expect(result).toEqual({ action: 'Reset', payload: { type: 'Immediate' } });
      });
    });

    describe('RequestStartTransaction', () => {
      it('maps to RemoteStartTransaction with idTag for ocpp1.6', () => {
        const result = translateCommand('RequestStartTransaction', 'ocpp1.6', {
          idToken: { idToken: 'TAG001', type: 'ISO14443' },
        });
        expect(result).toEqual({
          action: 'RemoteStartTransaction',
          payload: { connectorId: 1, idTag: 'TAG001' },
        });
      });
    });

    describe('RequestStopTransaction', () => {
      it('maps to RemoteStopTransaction with transactionId for ocpp1.6', () => {
        const result = translateCommand('RequestStopTransaction', 'ocpp1.6', {
          transactionId: 12345,
        });
        expect(result).toEqual({
          action: 'RemoteStopTransaction',
          payload: { transactionId: 12345 },
        });
      });
    });

    describe('unsupported commands', () => {
      it('returns null for a 2.1-only command on ocpp1.6', () => {
        const result = translateCommand('SetDisplayMessage', 'ocpp1.6', {});
        expect(result).toBeNull();
      });
    });

    describe('unknown commands', () => {
      it('passes through for ocpp2.1', () => {
        const result = translateCommand('SomeUnknownCommand', 'ocpp2.1', { foo: 1 });
        expect(result).toEqual({ action: 'SomeUnknownCommand', payload: { foo: 1 } });
      });

      it('returns null for ocpp1.6', () => {
        const result = translateCommand('SomeUnknownCommand', 'ocpp1.6', {});
        expect(result).toBeNull();
      });
    });

    describe('GetVariables', () => {
      it('maps to GetConfiguration with key array for ocpp1.6', () => {
        const result = translateCommand('GetVariables', 'ocpp1.6', {
          getVariableData: [
            {
              component: { name: 'OCPPCommCtrlr' },
              variable: { name: 'HeartbeatInterval' },
            },
          ],
        });
        // The 1.6 key is the variable name; OCPPCommCtrlr is a 2.1 component
        // that no 1.6 station knows as a configuration key.
        expect(result).toEqual({
          action: 'GetConfiguration',
          payload: { key: ['HeartbeatInterval'] },
        });
      });
    });

    describe('SetVariables', () => {
      it('maps to ChangeConfiguration with key/value for ocpp1.6', () => {
        const result = translateCommand('SetVariables', 'ocpp1.6', {
          setVariableData: [
            {
              component: { name: 'HeartbeatInterval' },
              variable: { name: 'HeartbeatInterval' },
              attributeValue: '30',
            },
          ],
        });
        expect(result).toEqual({
          action: 'ChangeConfiguration',
          payload: { key: 'HeartbeatInterval', value: '30' },
        });
      });
    });

    describe('ChangeAvailability', () => {
      it('maps evse.id to connectorId and keeps Operative for ocpp1.6', () => {
        const result = translateCommand('ChangeAvailability', 'ocpp1.6', {
          evse: { id: 2 },
          operationalStatus: 'Operative',
        });
        expect(result).toEqual({
          action: 'ChangeAvailability',
          payload: { connectorId: 2, type: 'Operative' },
        });
      });

      it('keeps Inoperative for ocpp1.6', () => {
        const result = translateCommand('ChangeAvailability', 'ocpp1.6', {
          evse: { id: 1 },
          operationalStatus: 'Inoperative',
        });
        expect(result).toEqual({
          action: 'ChangeAvailability',
          payload: { connectorId: 1, type: 'Inoperative' },
        });
      });

      it('reads the EVSE id, not the connector on the EVSE, for ocpp1.6', () => {
        const result = translateCommand('ChangeAvailability', 'ocpp1.6', {
          evse: { id: 3, connectorId: 1 },
          operationalStatus: 'Inoperative',
        });
        expect(result?.payload).toEqual({ connectorId: 3, type: 'Inoperative' });
      });

      it('targets the whole station (connectorId 0) without an EVSE for ocpp1.6', () => {
        for (const operationalStatus of ['Operative', 'Inoperative']) {
          const result = translateCommand('ChangeAvailability', 'ocpp1.6', { operationalStatus });
          expect(result?.payload).toEqual({ connectorId: 0, type: operationalStatus });
        }
      });

      it('sends the payload unchanged for ocpp2.1', () => {
        const payload = { evse: { id: 2 }, operationalStatus: 'Inoperative' };
        expect(translateCommand('ChangeAvailability', 'ocpp2.1', payload)).toEqual({
          action: 'ChangeAvailability',
          payload,
        });
      });

      it('returns the 1.6 response status unchanged (same enum in 2.1)', () => {
        for (const status of ['Accepted', 'Rejected', 'Scheduled']) {
          expect(translateResponse('ChangeAvailability', 'ocpp1.6', { status })).toEqual({
            status,
          });
        }
      });

      it('produces a payload the OCPP 1.6 schema accepts', () => {
        const schema = JSON.parse(
          readFileSync(
            resolve(import.meta.dirname, '../../../../schemas/ocpp-1.6/ChangeAvailability.json'),
            'utf8',
          ),
        ) as { properties: { type: { enum: string[] } }; required: string[] };
        for (const operationalStatus of ['Operative', 'Inoperative']) {
          const payload = translateCommand('ChangeAvailability', 'ocpp1.6', {
            evse: { id: 1 },
            operationalStatus,
          })?.payload as Record<string, unknown>;
          expect(schema.properties.type.enum).toContain(payload.type);
          expect(Object.keys(payload).sort()).toEqual([...schema.required].sort());
        }
      });
    });

    describe('UnlockConnector', () => {
      it('extracts connectorId from evse for ocpp1.6', () => {
        const result = translateCommand('UnlockConnector', 'ocpp1.6', {
          evse: { connectorId: 3 },
        });
        expect(result).toEqual({
          action: 'UnlockConnector',
          payload: { connectorId: 3 },
        });
      });

      it('sends the 2.1 evseId as the 1.6 connectorId, not the connector within the EVSE', () => {
        // A 1.6 connector is what 2.1 calls the EVSE: EVSE 2, connector 1 is 1.6 connector 2.
        const result = translateCommand('UnlockConnector', 'ocpp1.6', {
          evseId: 2,
          connectorId: 1,
        });
        expect(result).toEqual({
          action: 'UnlockConnector',
          payload: { connectorId: 2 },
        });
      });

      it('defaults connectorId to 1 when no evse for ocpp1.6', () => {
        const result = translateCommand('UnlockConnector', 'ocpp1.6', {});
        expect(result).toEqual({
          action: 'UnlockConnector',
          payload: { connectorId: 1 },
        });
      });

      it('uses connectorId directly when no evse for ocpp1.6', () => {
        const result = translateCommand('UnlockConnector', 'ocpp1.6', { connectorId: 5 });
        expect(result).toEqual({
          action: 'UnlockConnector',
          payload: { connectorId: 5 },
        });
      });
    });

    describe('SetChargingProfile', () => {
      it('sends the load management station limit to a 1.6 station as ChargePointMaxProfile', () => {
        // The payload buildLoadManagementProfile (services) publishes.
        const result = translateCommand('SetChargingProfile', 'ocpp1.6', {
          evseId: 0,
          chargingProfile: {
            id: 1_000_000_000,
            stackLevel: 1,
            chargingProfilePurpose: 'ChargingStationMaxProfile',
            chargingProfileKind: 'Absolute',
            chargingSchedule: [
              {
                id: 1,
                startSchedule: '2026-10-13T11:59:30.000Z',
                chargingRateUnit: 'W',
                chargingSchedulePeriod: [{ startPeriod: 0, limit: 22000 }],
              },
            ],
          },
        });
        expect(result?.payload).toEqual({
          connectorId: 0,
          csChargingProfiles: {
            chargingProfileId: 1_000_000_000,
            stackLevel: 1,
            chargingProfilePurpose: 'ChargePointMaxProfile',
            chargingProfileKind: 'Absolute',
            chargingSchedule: {
              startSchedule: '2026-10-13T11:59:30.000Z',
              chargingRateUnit: 'W',
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 22000 }],
            },
          },
        });
      });

      const profile21 = {
        evseId: 2,
        chargingProfile: {
          id: 101,
          stackLevel: 1,
          chargingProfilePurpose: 'ChargingStationMaxProfile',
          chargingProfileKind: 'Recurring',
          recurrencyKind: 'Daily',
          validFrom: '2026-10-01T00:00:00.000Z',
          validTo: '2026-12-31T00:00:00.000Z',
          chargingSchedule: [
            {
              id: 1,
              chargingRateUnit: 'W',
              startSchedule: '2026-10-01T00:00:00.000Z',
              duration: 86400,
              minChargingRate: 1380.04,
              chargingSchedulePeriod: [
                { startPeriod: 0, limit: 11000.04, numberPhases: 3 },
                { startPeriod: 3600, limit: 7400 },
              ],
            },
          ],
        },
      };

      it('builds a schema-valid 1.6 csChargingProfiles from the 2.1 profile', () => {
        const result = translateCommand('SetChargingProfile', 'ocpp1.6', profile21);
        expect(result?.payload).toEqual({
          connectorId: 2,
          csChargingProfiles: {
            chargingProfileId: 101,
            stackLevel: 1,
            chargingProfilePurpose: 'ChargePointMaxProfile',
            chargingProfileKind: 'Recurring',
            recurrencyKind: 'Daily',
            validFrom: '2026-10-01T00:00:00.000Z',
            validTo: '2026-12-31T00:00:00.000Z',
            chargingSchedule: {
              duration: 86400,
              startSchedule: '2026-10-01T00:00:00.000Z',
              chargingRateUnit: 'W',
              chargingSchedulePeriod: [
                { startPeriod: 0, limit: 11000, numberPhases: 3 },
                { startPeriod: 3600, limit: 7400 },
              ],
              minChargingRate: 1380,
            },
          },
        });
        expect(validateSetChargingProfile(result?.payload)).toBe(true);
      });

      it('refuses ChargingStationExternalConstraints, which a CSMS never sends', () => {
        expect(() =>
          translateCommand('SetChargingProfile', 'ocpp1.6', {
            evseId: 0,
            chargingProfile: {
              id: 1,
              stackLevel: 0,
              chargingProfilePurpose: 'ChargingStationExternalConstraints',
              chargingProfileKind: 'Absolute',
              chargingSchedule: [
                {
                  id: 1,
                  chargingRateUnit: 'W',
                  chargingSchedulePeriod: [{ startPeriod: 0, limit: 7333.333 }],
                },
              ],
            },
          }),
        ).toThrow('not supported on ocpp1.6');
      });

      it('makes a TxProfile transaction id numeric', () => {
        const result = translateCommand('SetChargingProfile', 'ocpp1.6', {
          evseId: 1,
          chargingProfile: {
            ...profile21.chargingProfile,
            chargingProfilePurpose: 'TxProfile',
            transactionId: '42',
          },
        });
        expect(validateSetChargingProfile(result?.payload)).toBe(true);
        expect(
          (result?.payload as { csChargingProfiles: Record<string, unknown> }).csChargingProfiles[
            'transactionId'
          ],
        ).toBe(42);
      });

      it('refuses what a 1.6 station cannot take', () => {
        const withPurpose = (purpose: string) => ({
          evseId: 0,
          chargingProfile: { ...profile21.chargingProfile, chargingProfilePurpose: purpose },
        });
        expect(() =>
          translateCommand('SetChargingProfile', 'ocpp1.6', withPurpose('PriorityCharging')),
        ).toThrow('not supported on ocpp1.6');
        expect(() =>
          translateCommand('SetChargingProfile', 'ocpp1.6', withPurpose('LocalGeneration')),
        ).toThrow('not supported on ocpp1.6');
        expect(() =>
          translateCommand('SetChargingProfile', 'ocpp1.6', {
            evseId: 1,
            chargingProfile: { ...profile21.chargingProfile, transactionId: 'tx-abc' },
          }),
        ).toThrow('Invalid transactionId');
      });

      it('sends the 2.1 payload unchanged to ocpp2.1', () => {
        const result = translateCommand('SetChargingProfile', 'ocpp2.1', profile21);
        expect(result?.payload).toEqual(profile21);
      });
    });

    describe('CertificateSigned', () => {
      const payload = {
        certificateChain: 'PEM',
        certificateType: 'ChargingStationCertificate',
        requestId: 4,
      };

      it('sends only certificateChain to an ocpp1.6 station (schema has no other field)', () => {
        const result = translateCommand('CertificateSigned', 'ocpp1.6', payload);
        expect(result).toEqual({
          action: 'CertificateSigned',
          payload: { certificateChain: 'PEM' },
        });
        expect(validateCertificateSigned(result?.payload)).toBe(true);
      });

      it('keeps certificateType and requestId for ocpp2.1', () => {
        const result = translateCommand('CertificateSigned', 'ocpp2.1', payload);
        expect(result).toEqual({ action: 'CertificateSigned', payload });
      });
    });

    describe('ISO 15118 Plug and Charge on ocpp1.6 (OCA application note)', () => {
      const vendorId = 'org.openchargealliance.iso15118pnc';
      const data = (result: { payload: Record<string, unknown> } | null): unknown =>
        JSON.parse(String(result?.payload['data']));

      it('wraps CertificateSigned of a V2G certificate in a DataTransfer', () => {
        const result = translateCommand('CertificateSigned', 'ocpp1.6', {
          certificateChain: 'PEM',
          certificateType: 'V2GCertificate',
          requestId: 3,
        });
        expect(result?.action).toBe('DataTransfer');
        expect(result?.payload).toMatchObject({ vendorId, messageId: 'CertificateSigned' });
        expect(data(result)).toEqual({ certificateChain: 'PEM' });
        const request = { certificateChain: 'PEM', certificateType: 'V2GCertificate' };
        expect(
          translateResponse(
            'CertificateSigned',
            'ocpp1.6',
            {
              status: 'Accepted',
              data: '{"status":"Accepted"}',
            },
            request,
          ),
        ).toEqual({ status: 'Accepted' });
        expect(
          translateResponse('CertificateSigned', 'ocpp1.6', { status: 'UnknownVendorId' }, request),
        ).toEqual({ status: 'Rejected' });
      });

      it('keeps the Security Whitepaper message for the station certificate', () => {
        const result = translateCommand('CertificateSigned', 'ocpp1.6', {
          certificateChain: 'PEM',
          certificateType: 'ChargingStationCertificate',
        });
        expect(result).toEqual({
          action: 'CertificateSigned',
          payload: { certificateChain: 'PEM' },
        });
      });

      it('refuses ISO 15118-20 certificates on ocpp1.6', () => {
        expect(() =>
          translateCommand('CertificateSigned', 'ocpp1.6', {
            certificateChain: 'PEM',
            certificateType: 'V2G20Certificate',
          }),
        ).toThrow(/V2G20Certificate/);
        expect(() =>
          translateCommand('TriggerMessage', 'ocpp1.6', {
            requestedMessage: 'SignV2G20Certificate',
          }),
        ).toThrow(/V2G20Certificate/);
      });

      it('wraps InstallCertificate of a V2G or MO root, not of a Central System root', () => {
        const v2g = translateCommand('InstallCertificate', 'ocpp1.6', {
          certificateType: 'MORootCertificate',
          certificate: 'PEM',
        });
        expect(v2g?.action).toBe('DataTransfer');
        expect(data(v2g)).toEqual({ certificateType: 'MORootCertificate', certificate: 'PEM' });
        expect(
          translateResponse(
            'InstallCertificate',
            'ocpp1.6',
            { status: 'Accepted', data: '{"status":"Failed"}' },
            { certificateType: 'MORootCertificate' },
          ),
        ).toEqual({ status: 'Failed' });
        const csms = translateCommand('InstallCertificate', 'ocpp1.6', {
          certificateType: 'CSMSRootCertificate',
          certificate: 'PEM',
        });
        expect(csms?.action).toBe('InstallCertificate');
      });

      it('wraps DeleteCertificate of an ISO 15118 certificate (type hint never sent)', () => {
        const hash = {
          hashAlgorithm: 'SHA256',
          issuerNameHash: 'a',
          issuerKeyHash: 'b',
          serialNumber: '1',
        };
        const wrapped = translateCommand('DeleteCertificate', 'ocpp1.6', {
          certificateHashData: hash,
          certificateType: 'V2GRootCertificate',
        });
        expect(wrapped?.action).toBe('DataTransfer');
        expect(data(wrapped)).toEqual({ certificateHashData: hash });
        const plain = translateCommand('DeleteCertificate', 'ocpp1.6', {
          certificateHashData: hash,
          certificateType: 'CSMSRootCertificate',
        });
        expect(plain).toEqual({
          action: 'DeleteCertificate',
          payload: { certificateHashData: hash },
        });
        expect(
          translateCommand('DeleteCertificate', 'ocpp2.1', {
            certificateHashData: hash,
            certificateType: 'V2GRootCertificate',
          }),
        ).toEqual({ action: 'DeleteCertificate', payload: { certificateHashData: hash } });
      });

      it('wraps GetInstalledCertificateIds of ISO 15118 types and refuses a mix', () => {
        const request = { certificateType: ['V2GRootCertificate', 'V2GCertificateChain'] };
        const wrapped = translateCommand('GetInstalledCertificateIds', 'ocpp1.6', request);
        expect(wrapped?.action).toBe('DataTransfer');
        expect(data(wrapped)).toEqual(request);
        const chain = [{ certificateType: 'V2GRootCertificate', certificateHashData: {} }];
        expect(
          translateResponse(
            'GetInstalledCertificateIds',
            'ocpp1.6',
            {
              status: 'Accepted',
              data: JSON.stringify({ status: 'Accepted', certificateHashDataChain: chain }),
            },
            request,
          ),
        ).toEqual({ status: 'Accepted', certificateHashDataChain: chain });
        expect(
          translateResponse(
            'GetInstalledCertificateIds',
            'ocpp1.6',
            { status: 'Rejected' },
            request,
          ),
        ).toEqual({ status: 'NotFound' });
        expect(() =>
          translateCommand('GetInstalledCertificateIds', 'ocpp1.6', {
            certificateType: ['V2GRootCertificate', 'CSMSRootCertificate'],
          }),
        ).toThrow(/mix/);
      });

      it('wraps TriggerMessage SignV2GCertificate with no fields', () => {
        const wrapped = translateCommand('TriggerMessage', 'ocpp1.6', {
          requestedMessage: 'SignV2GCertificate',
        });
        expect(wrapped).toEqual({
          action: 'DataTransfer',
          payload: { vendorId, messageId: 'TriggerMessage', data: '{}' },
        });
        expect(
          translateResponse(
            'TriggerMessage',
            'ocpp1.6',
            { status: 'Accepted', data: '{"status":"Accepted"}' },
            { requestedMessage: 'SignV2GCertificate' },
          ),
        ).toEqual({ status: 'Accepted' });
        expect(
          translateCommand('TriggerMessage', 'ocpp1.6', { requestedMessage: 'Heartbeat' }),
        ).toEqual({ action: 'TriggerMessage', payload: { requestedMessage: 'Heartbeat' } });
      });
    });

    describe('ClearChargingProfile', () => {
      it('maps evseId to connectorId for ocpp1.6', () => {
        const result = translateCommand('ClearChargingProfile', 'ocpp1.6', {
          evseId: 3,
        });
        expect(result?.payload).toHaveProperty('connectorId', 3);
        expect(result?.payload).not.toHaveProperty('evseId');
      });

      it('maps the 2.1 purpose to its 1.6 name', () => {
        const result = translateCommand('ClearChargingProfile', 'ocpp1.6', {
          chargingProfileCriteria: {
            chargingProfilePurpose: 'ChargingStationMaxProfile',
            stackLevel: 0,
            evseId: 0,
          },
        });
        expect(result?.payload).toEqual({
          chargingProfilePurpose: 'ChargePointMaxProfile',
          stackLevel: 0,
          connectorId: 0,
        });
        expect(validateClearChargingProfile(result?.payload)).toBe(true);
      });
    });

    describe('GetCompositeSchedule', () => {
      it('maps evseId to connectorId for ocpp1.6', () => {
        const result = translateCommand('GetCompositeSchedule', 'ocpp1.6', {
          evseId: 1,
          duration: 3600,
        });
        // The 1.6 schema rejects additional properties, so evseId must not leak.
        expect(result?.payload).toEqual({ connectorId: 1, duration: 3600 });
      });
    });

    describe('ReserveNow', () => {
      it('maps idToken and evseId for ocpp1.6', () => {
        const result = translateCommand('ReserveNow', 'ocpp1.6', {
          idToken: { idToken: 'TAG001' },
          evseId: 2,
          expiryDate: '2026-12-31T00:00:00Z',
          id: 42,
        });
        expect(result).toEqual({
          action: 'ReserveNow',
          payload: {
            connectorId: 2,
            expiryDate: '2026-12-31T00:00:00Z',
            idTag: 'TAG001',
            reservationId: 42,
          },
        });
      });

      it('TC-RES-02: sends the bound token of a reservation as the 1.6 idTag', () => {
        // The 2.1-shaped payload of reserveNowPayload: the bound RFID token with its type.
        const result = translateCommand('ReserveNow', 'ocpp1.6', {
          id: 42,
          expiryDateTime: '2026-12-31T00:00:00.000Z',
          idToken: { idToken: '04A1B2C3D4E5F6', type: 'ISO14443' },
          evseId: 1,
        });
        expect(result).toEqual({
          action: 'ReserveNow',
          payload: {
            connectorId: 1,
            expiryDate: '2026-12-31T00:00:00.000Z',
            idTag: '04A1B2C3D4E5F6',
            reservationId: 42,
          },
        });
      });

      it('defaults connectorId to 0 when no evseId for ocpp1.6', () => {
        const result = translateCommand('ReserveNow', 'ocpp1.6', {
          idToken: { idToken: 'TAG001' },
          expiryDate: '2026-12-31T00:00:00Z',
          reservationId: 7,
        });
        expect(result?.payload).toHaveProperty('connectorId', 0);
        expect(result?.payload).toHaveProperty('reservationId', 7);
      });

      it('uses idTag when no idToken for ocpp1.6', () => {
        const result = translateCommand('ReserveNow', 'ocpp1.6', {
          idTag: 'DIRECT-TAG',
          expiryDate: '2026-12-31T00:00:00Z',
          id: 1,
        });
        expect(result?.payload).toHaveProperty('idTag', 'DIRECT-TAG');
      });
    });

    describe('SendLocalList', () => {
      it('maps idToken in list entries for ocpp1.6', () => {
        const result = translateCommand('SendLocalList', 'ocpp1.6', {
          versionNumber: 1,
          updateType: 'Full',
          localAuthorizationList: [{ idToken: { idToken: 'TAG001' } }, { idTag: 'TAG002' }],
        });
        const list = result?.payload['localAuthorizationList'] as Array<Record<string, unknown>>;
        expect(list[0]).toHaveProperty('idTag', 'TAG001');
        expect(list[1]).toHaveProperty('idTag', 'TAG002');
      });

      it('maps versionNumber to listVersion when there is no list for ocpp1.6', () => {
        const result = translateCommand('SendLocalList', 'ocpp1.6', {
          versionNumber: 1,
          updateType: 'Full',
        });
        expect(result?.payload).toEqual({ listVersion: 1, updateType: 'Full' });
      });

      it('maps a 2.1 list to the 1.6 schema shape for ocpp1.6', () => {
        const result = translateCommand('SendLocalList', 'ocpp1.6', {
          versionNumber: 7,
          updateType: 'Full',
          localAuthorizationList: [
            {
              idToken: { idToken: 'TAG-A', type: 'ISO14443' },
              idTokenInfo: {
                status: 'Accepted',
                cacheExpiryDateTime: '2027-01-01T00:00:00.000Z',
                groupIdToken: { idToken: 'GROUP-1', type: 'Central' },
              },
            },
            { idToken: { idToken: 'TAG-B', type: 'ISO14443' }, idTokenInfo: { status: 'Blocked' } },
            {
              idToken: { idToken: 'TAG-C', type: 'ISO14443' },
              idTokenInfo: { status: 'NoCredit' },
            },
            { idToken: { idToken: 'TAG-D', type: 'ISO14443' } },
          ],
        });
        // SendLocalList.json (1.6): listVersion and updateType, each entry
        // only idTag and idTagInfo { status, expiryDate, parentIdTag }.
        expect(validateSendLocalList(result?.payload)).toBe(true);
        expect(result?.payload).toEqual({
          listVersion: 7,
          updateType: 'Full',
          localAuthorizationList: [
            {
              idTag: 'TAG-A',
              idTagInfo: {
                status: 'Accepted',
                expiryDate: '2027-01-01T00:00:00.000Z',
                parentIdTag: 'GROUP-1',
              },
            },
            { idTag: 'TAG-B', idTagInfo: { status: 'Blocked' } },
            // 1.6 has no NoCredit: a prepaid card without credit is Blocked.
            { idTag: 'TAG-C', idTagInfo: { status: 'Blocked' } },
            { idTag: 'TAG-D' },
          ],
        });
      });

      it('keeps a list already in the 1.6 shape for ocpp1.6', () => {
        const result = translateCommand('SendLocalList', 'ocpp1.6', {
          listVersion: 3,
          updateType: 'Differential',
          localAuthorizationList: [{ idTag: 'T', idTagInfo: { status: 'Accepted' } }],
        });
        expect(result?.payload).toEqual({
          listVersion: 3,
          updateType: 'Differential',
          localAuthorizationList: [{ idTag: 'T', idTagInfo: { status: 'Accepted' } }],
        });
      });
    });

    describe('UpdateFirmware', () => {
      it('extracts location and retrieveDate from firmware object for ocpp1.6', () => {
        const result = translateCommand('UpdateFirmware', 'ocpp1.6', {
          firmware: {
            location: 'https://example.com/fw.bin',
            retrieveDateTime: '2026-01-01T00:00:00Z',
          },
          retries: 3,
          retryInterval: 60,
        });
        expect(result).toEqual({
          action: 'UpdateFirmware',
          payload: {
            location: 'https://example.com/fw.bin',
            retrieveDate: '2026-01-01T00:00:00Z',
            retries: 3,
            retryInterval: 60,
          },
        });
      });

      it('falls back to direct location/retrieveDate when no firmware object', () => {
        const result = translateCommand('UpdateFirmware', 'ocpp1.6', {
          location: 'https://example.com/fw.bin',
          retrieveDate: '2026-01-01T00:00:00Z',
        });
        expect(result?.payload).toHaveProperty('location', 'https://example.com/fw.bin');
        expect(result?.payload).toHaveProperty('retrieveDate', '2026-01-01T00:00:00Z');
      });

      const signed = {
        requestId: 42,
        firmware: {
          location: 'https://example.com/fw.bin',
          retrieveDateTime: '2026-01-01T00:00:00Z',
          signingCertificate: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
          signature: 'c2lnbmF0dXJl',
        },
        retries: 2,
      };

      it('sends a signed update to an ocpp1.6 station as SignedUpdateFirmware', () => {
        const result = translateCommand('UpdateFirmware', 'ocpp1.6', signed);
        expect(result).toEqual({
          action: 'SignedUpdateFirmware',
          payload: {
            requestId: 42,
            retries: 2,
            firmware: {
              location: 'https://example.com/fw.bin',
              retrieveDateTime: '2026-01-01T00:00:00Z',
              signingCertificate: signed.firmware.signingCertificate,
              signature: 'c2lnbmF0dXJl',
            },
          },
        });
      });

      it('passes the signing certificate and signature to an ocpp2.1 station', () => {
        const result = translateCommand('UpdateFirmware', 'ocpp2.1', signed);
        expect(result).toEqual({ action: 'UpdateFirmware', payload: signed });
      });

      it('keeps plain UpdateFirmware on ocpp1.6 when only one signing field is set', () => {
        const result = translateCommand('UpdateFirmware', 'ocpp1.6', {
          requestId: 42,
          firmware: { ...signed.firmware, signature: undefined },
        });
        expect(result?.action).toBe('UpdateFirmware');
        expect(result?.payload).toHaveProperty('location', 'https://example.com/fw.bin');
      });
    });

    describe('GetLog', () => {
      it('extracts log details from log object for ocpp1.6', () => {
        const result = translateCommand('GetLog', 'ocpp1.6', {
          log: {
            remoteLocation: 'https://example.com/logs',
            oldestTimestamp: '2026-01-01T00:00:00Z',
            latestTimestamp: '2026-02-01T00:00:00Z',
          },
          retries: 2,
          retryInterval: 30,
        });
        expect(result).toEqual({
          action: 'GetDiagnostics',
          payload: {
            location: 'https://example.com/logs',
            startTime: '2026-01-01T00:00:00Z',
            stopTime: '2026-02-01T00:00:00Z',
            retries: 2,
            retryInterval: 30,
          },
        });
      });

      it('falls back to direct location when no log object', () => {
        const result = translateCommand('GetLog', 'ocpp1.6', {
          location: 'https://example.com/logs',
        });
        expect(result?.payload).toHaveProperty('location', 'https://example.com/logs');
      });
    });

    describe('GetVariables edge cases', () => {
      it('returns empty object when getVariableData is empty for ocpp1.6', () => {
        const result = translateCommand('GetVariables', 'ocpp1.6', {
          getVariableData: [],
        });
        expect(result?.payload).toEqual({});
      });

      it('uses variable name when no component for ocpp1.6', () => {
        const result = translateCommand('GetVariables', 'ocpp1.6', {
          getVariableData: [{ variable: { name: 'SomeVar' } }],
        });
        expect(result?.payload).toEqual({ key: ['SomeVar'] });
      });

      it('returns empty object when the single getVariableData entry is null', () => {
        const result = translateCommand('GetVariables', 'ocpp1.6', {
          getVariableData: [null],
        });
        expect(result?.payload).toEqual({});
      });
    });

    describe('1.6 Basic Auth password', () => {
      it('maps SecurityCtrlr.BasicAuthPassword to a hex AuthorizationKey (OCTT TC_073)', () => {
        const result = translateCommand('SetVariables', 'ocpp1.6', {
          setVariableData: [
            {
              component: { name: 'SecurityCtrlr' },
              variable: { name: 'BasicAuthPassword' },
              attributeValue: 'OCA_OCTT_admin_test',
            },
          ],
        });
        expect(result).toEqual({
          action: 'ChangeConfiguration',
          payload: { key: 'AuthorizationKey', value: '4F43415F4F4354545F61646D696E5F74657374' },
        });
      });
    });

    describe('1.6 configuration keys', () => {
      it('uses the variable name when the component name is empty (1.6 templates)', () => {
        const result = translateCommand('SetVariables', 'ocpp1.6', {
          setVariableData: [
            {
              component: { name: '' },
              variable: { name: 'HeartbeatInterval' },
              attributeValue: '300',
            },
          ],
        });
        expect(result?.payload).toEqual({ key: 'HeartbeatInterval', value: '300' });
      });

      it('uses the variable name, not the 2.1 component, for SecurityProfile', () => {
        const result = translateCommand('SetVariables', 'ocpp1.6', {
          setVariableData: [
            {
              component: { name: 'SecurityCtrlr' },
              variable: { name: 'SecurityProfile' },
              attributeValue: '1',
            },
          ],
        });
        expect(result?.payload).toEqual({ key: 'SecurityProfile', value: '1' });
      });

      it('falls back to the component name when the variable name is empty', () => {
        const result = translateCommand('GetVariables', 'ocpp1.6', {
          getVariableData: [{ component: { name: 'LegacyKey' }, variable: { name: '' } }],
        });
        expect(result?.payload).toEqual({ key: ['LegacyKey'] });
      });
    });

    describe('SetVariables edge cases', () => {
      it('returns empty object when setVariableData is empty for ocpp1.6', () => {
        const result = translateCommand('SetVariables', 'ocpp1.6', {
          setVariableData: [],
        });
        expect(result?.payload).toEqual({});
      });

      it('uses variable name when no component for ocpp1.6', () => {
        const result = translateCommand('SetVariables', 'ocpp1.6', {
          setVariableData: [{ variable: { name: 'SomeVar' }, attributeValue: '42' }],
        });
        expect(result?.payload).toEqual({ key: 'SomeVar', value: '42' });
      });

      it('returns empty object when the single setVariableData entry is null', () => {
        const result = translateCommand('SetVariables', 'ocpp1.6', {
          setVariableData: [null],
        });
        expect(result?.payload).toEqual({});
      });
    });

    describe('ChangeAvailability edge cases', () => {
      it('passes an unknown operationalStatus through for ocpp1.6', () => {
        const result = translateCommand('ChangeAvailability', 'ocpp1.6', {
          operationalStatus: 'CustomStatus',
        });
        expect(result?.payload).toHaveProperty('type', 'CustomStatus');
      });
    });

    describe('Reset edge cases', () => {
      it('throws for unknown reset type targeting ocpp1.6 (e.g. 2.1 ImmediateAndResume)', () => {
        // OCPP 1.6 Reset.type enum is Hard|Soft only. Letting an unknown value
        // through produces a FormationViolation CALLERROR; the mapper throws
        // so the caller surfaces the mismatch at the CSMS layer.
        expect(() => translateCommand('Reset', 'ocpp1.6', { type: 'ImmediateAndResume' })).toThrow(
          /no OCPP 1.6 equivalent/,
        );
        expect(() => translateCommand('Reset', 'ocpp1.6', { type: 'CustomType' })).toThrow(
          /no OCPP 1.6 equivalent/,
        );
      });
    });

    describe('RequestStartTransaction edge cases', () => {
      it('uses evseId when provided for ocpp1.6', () => {
        const result = translateCommand('RequestStartTransaction', 'ocpp1.6', {
          evseId: 3,
          idToken: { idToken: 'TAG001' },
        });
        expect(result?.payload).toHaveProperty('connectorId', 3);
      });

      it('uses connectorId when provided for ocpp1.6', () => {
        const result = translateCommand('RequestStartTransaction', 'ocpp1.6', {
          connectorId: 4,
          idTag: 'TAG002',
        });
        expect(result?.payload).toHaveProperty('connectorId', 4);
        expect(result?.payload).toHaveProperty('idTag', 'TAG002');
      });
    });

    describe('identity translations for ocpp2.1', () => {
      it('TriggerMessage passes through for ocpp2.1', () => {
        const result = translateCommand('TriggerMessage', 'ocpp2.1', {
          requestedMessage: 'BootNotification',
        });
        expect(result?.action).toBe('TriggerMessage');
        expect(result?.payload).toHaveProperty('requestedMessage', 'BootNotification');
      });

      it('ClearCache passes through for both versions', () => {
        const r21 = translateCommand('ClearCache', 'ocpp2.1', {});
        const r16 = translateCommand('ClearCache', 'ocpp1.6', {});
        expect(r21?.action).toBe('ClearCache');
        expect(r16?.action).toBe('ClearCache');
      });

      it('CancelReservation passes through for ocpp1.6', () => {
        const result = translateCommand('CancelReservation', 'ocpp1.6', { reservationId: 1 });
        expect(result?.action).toBe('CancelReservation');
        expect(result?.payload).toHaveProperty('reservationId', 1);
      });

      it('DataTransfer passes through for both versions', () => {
        const r21 = translateCommand('DataTransfer', 'ocpp2.1', { vendorId: 'x' });
        const r16 = translateCommand('DataTransfer', 'ocpp1.6', { vendorId: 'x' });
        expect(r21?.action).toBe('DataTransfer');
        expect(r16?.action).toBe('DataTransfer');
      });

      it('GetLocalListVersion passes through for ocpp1.6', () => {
        const result = translateCommand('GetLocalListVersion', 'ocpp1.6', {});
        expect(result?.action).toBe('GetLocalListVersion');
      });
    });

    describe('unsupported version for known command', () => {
      it('returns null for known command on unknown version', () => {
        const result = translateCommand('Reset', 'ocpp99.9', {});
        expect(result).toBeNull();
      });
    });

    describe('Reset with no type', () => {
      it('throws when type is absent targeting ocpp1.6', () => {
        expect(() => translateCommand('Reset', 'ocpp1.6', {})).toThrow(
          'Reset type "undefined" has no OCPP 1.6 equivalent',
        );
      });
    });

    describe('RequestStopTransaction validation', () => {
      it('throws for a non-numeric transactionId targeting ocpp1.6', () => {
        expect(() =>
          translateCommand('RequestStopTransaction', 'ocpp1.6', { transactionId: 'abc' }),
        ).toThrow('Invalid transactionId for OCPP 1.6 stop: abc');
      });

      it('throws for a zero transactionId targeting ocpp1.6', () => {
        expect(() =>
          translateCommand('RequestStopTransaction', 'ocpp1.6', { transactionId: 0 }),
        ).toThrow('Invalid transactionId for OCPP 1.6 stop: 0');
      });

      it('coerces a numeric-string transactionId to a positive integer for ocpp1.6', () => {
        const result = translateCommand('RequestStopTransaction', 'ocpp1.6', {
          transactionId: '42',
        });
        expect(result).toEqual({
          action: 'RemoteStopTransaction',
          payload: { transactionId: 42 },
        });
      });
    });

    describe('ClearChargingProfile nested 2.1 criteria', () => {
      it('flattens chargingProfileCriteria and maps chargingProfileId to id for ocpp1.6', () => {
        const result = translateCommand('ClearChargingProfile', 'ocpp1.6', {
          chargingProfileId: 7,
          chargingProfileCriteria: {
            evseId: 2,
            chargingProfilePurpose: 'TxDefaultProfile',
            customData: { vendorId: 'x' },
          },
        });
        expect(result?.payload).toEqual({
          chargingProfilePurpose: 'TxDefaultProfile',
          id: 7,
          connectorId: 2,
        });
        expect(result?.payload).not.toHaveProperty('chargingProfileId');
        expect(result?.payload).not.toHaveProperty('evseId');
        expect(result?.payload).not.toHaveProperty('customData');
      });

      it('omits id and connectorId when chargingProfileId and evseId are absent for ocpp1.6', () => {
        const result = translateCommand('ClearChargingProfile', 'ocpp1.6', {
          chargingProfileCriteria: { chargingProfilePurpose: 'ChargingStationMaxProfile' },
        });
        expect(result?.payload).toEqual({ chargingProfilePurpose: 'ChargePointMaxProfile' });
        expect(result?.payload).not.toHaveProperty('id');
        expect(result?.payload).not.toHaveProperty('connectorId');
      });
    });

    describe('GetVariables multi-variable rejection', () => {
      it('throws when more than one variable targets ocpp1.6', () => {
        expect(() =>
          translateCommand('GetVariables', 'ocpp1.6', {
            getVariableData: [
              { component: { name: 'A' }, variable: { name: 'x' } },
              { component: { name: 'B' }, variable: { name: 'y' } },
            ],
          }),
        ).toThrow('at most one variable per call');
      });
    });

    describe('SetVariables multi-variable rejection', () => {
      it('throws when more than one variable targets ocpp1.6', () => {
        expect(() =>
          translateCommand('SetVariables', 'ocpp1.6', {
            setVariableData: [
              { component: { name: 'A' }, variable: { name: 'x' }, attributeValue: '1' },
              { component: { name: 'B' }, variable: { name: 'y' }, attributeValue: '2' },
            ],
          }),
        ).toThrow('at most one variable per call');
      });
    });
  });

  describe('translateResponse', () => {
    it('returns the response unchanged for identity translations', () => {
      const response = { status: 'Accepted' };
      const result = translateResponse('Reset', 'ocpp1.6', response);
      expect(result).toEqual({ status: 'Accepted' });
    });

    it('returns the response unchanged for unknown commands', () => {
      const response = { foo: 'bar' };
      const result = translateResponse('NonExistent', 'ocpp2.1', response);
      expect(result).toEqual({ foo: 'bar' });
    });

    it('returns the response unchanged for unknown version', () => {
      const response = { status: 'OK' };
      const result = translateResponse('Reset', 'ocpp99.9', response);
      expect(result).toEqual({ status: 'OK' });
    });

    it('returns a 1.6 composite schedule in the 2.1 shape', () => {
      const result = translateResponse(
        'GetCompositeSchedule',
        'ocpp1.6',
        {
          status: 'Accepted',
          connectorId: 1,
          scheduleStart: '2026-10-13T08:00:00.000Z',
          chargingSchedule: {
            duration: 3600,
            chargingRateUnit: 'A',
            chargingSchedulePeriod: [{ startPeriod: 0, limit: 16, numberPhases: 3 }],
          },
        },
        { evseId: 1, duration: 3600 },
      );
      expect(result).toEqual({
        status: 'Accepted',
        schedule: {
          evseId: 1,
          duration: 3600,
          scheduleStart: '2026-10-13T08:00:00.000Z',
          chargingRateUnit: 'A',
          chargingSchedulePeriod: [{ startPeriod: 0, limit: 16, numberPhases: 3 }],
        },
      });
    });

    it('returns a rejected 1.6 composite schedule without a schedule', () => {
      const result = translateResponse(
        'GetCompositeSchedule',
        'ocpp1.6',
        { status: 'Rejected' },
        { evseId: 0, duration: 60 },
      );
      expect(result).toEqual({ status: 'Rejected' });
    });
  });

  describe('1.6 Security Whitepaper certificate commands', () => {
    const hash = {
      hashAlgorithm: 'SHA256',
      issuerNameHash: 'aa',
      issuerKeyHash: 'bb',
      serialNumber: '01',
    };

    it('maps InstallCertificate types to the 1.6 names', () => {
      expect(
        translateCommand('InstallCertificate', 'ocpp1.6', {
          certificateType: 'CSMSRootCertificate',
          certificate: 'PEM',
          customData: { vendorId: 'x' },
        }),
      ).toEqual({
        action: 'InstallCertificate',
        payload: { certificateType: 'CentralSystemRootCertificate', certificate: 'PEM' },
      });
      expect(
        translateCommand('InstallCertificate', 'ocpp1.6', {
          certificateType: 'ManufacturerRootCertificate',
          certificate: 'PEM',
        })?.payload,
      ).toEqual({ certificateType: 'ManufacturerRootCertificate', certificate: 'PEM' });
    });

    it('refuses certificate types without a 1.6 equivalent', () => {
      // V2G and MO roots go in the ISO 15118 DataTransfer (tested above); an OEM root has no 1.6 form.
      for (const type of ['OEMRootCertificate']) {
        expect(() =>
          translateCommand('InstallCertificate', 'ocpp1.6', {
            certificateType: type,
            certificate: 'PEM',
          }),
        ).toThrow('not supported on ocpp1.6 stations');
      }
      expect(() =>
        translateCommand('GetInstalledCertificateIds', 'ocpp1.6', {
          certificateType: ['OEMRootCertificate'],
        }),
      ).toThrow('not supported on ocpp1.6 stations');
    });

    it('keeps 2.1 certificate payloads unchanged for 2.1 stations', () => {
      const payload = { certificateType: 'V2GRootCertificate', certificate: 'PEM' };
      expect(translateCommand('InstallCertificate', 'ocpp2.1', payload)?.payload).toBe(payload);
    });

    it('requests exactly one certificate type with GetInstalledCertificateIds', () => {
      expect(
        translateCommand('GetInstalledCertificateIds', 'ocpp1.6', {
          certificateType: ['CSMSRootCertificate'],
        }),
      ).toEqual({
        action: 'GetInstalledCertificateIds',
        payload: { certificateType: 'CentralSystemRootCertificate' },
      });
      expect(() => translateCommand('GetInstalledCertificateIds', 'ocpp1.6', {})).toThrow(
        'exactly one certificate type',
      );
      expect(() =>
        translateCommand('GetInstalledCertificateIds', 'ocpp1.6', {
          certificateType: ['CSMSRootCertificate', 'ManufacturerRootCertificate'],
        }),
      ).toThrow('exactly one certificate type');
    });

    it('maps the GetInstalledCertificateIds response to a 2.1 hash data chain', () => {
      const request = { certificateType: ['CSMSRootCertificate'] };
      expect(
        translateResponse(
          'GetInstalledCertificateIds',
          'ocpp1.6',
          { status: 'Accepted', certificateHashData: [hash] },
          request,
        ),
      ).toEqual({
        status: 'Accepted',
        certificateHashDataChain: [
          { certificateType: 'CSMSRootCertificate', certificateHashData: hash },
        ],
      });
      expect(
        translateResponse('GetInstalledCertificateIds', 'ocpp1.6', { status: 'NotFound' }, request),
      ).toEqual({ status: 'NotFound' });
    });

    it('sends DeleteCertificate hash data without 2.1-only fields', () => {
      expect(
        translateCommand('DeleteCertificate', 'ocpp1.6', {
          certificateHashData: { ...hash, customData: { vendorId: 'x' } },
        }),
      ).toEqual({ action: 'DeleteCertificate', payload: { certificateHashData: hash } });
    });
  });
});

describe('translateCommand for OCPP 2.0.1', () => {
  const only21 = Object.keys(Registry21).filter((action) => !Object.hasOwn(Registry201, action));
  const relativeProfile = (period: Record<string, unknown>): Record<string, unknown> => ({
    evseId: 1,
    chargingProfile: {
      id: 1,
      stackLevel: 0,
      chargingProfilePurpose: 'TxDefaultProfile',
      chargingProfileKind: 'Relative',
      chargingSchedule: [{ id: 1, chargingRateUnit: 'A', chargingSchedulePeriod: [period] }],
    },
  });

  it('knows the 26 actions only OCPP 2.1 defines, the list lib holds', () => {
    expect(only21).toHaveLength(26);
    expect([...only21].sort()).toEqual([...OCPP21_ONLY_ACTIONS].sort());
    expect(ocpp21OnlyRegistryActions()).toEqual(only21);
    expect(only21).toEqual(
      expect.arrayContaining([
        'GetTariffs',
        'SetDERControl',
        'RequestBatterySwap',
        'OpenPeriodicEventStream',
      ]),
    );
  });

  it('refuses every 2.1-only action', () => {
    for (const action of only21) {
      expect(translateCommand(action, 'ocpp2.0.1', {}), action).toBeNull();
    }
  });

  it('refuses a 1.6 action and a command with only a 1.6 translation', () => {
    expect(translateCommand('ChangeConfiguration', 'ocpp2.0.1', { key: 'a' })).toBeNull();
    expect(translateCommand('ExtendedTriggerMessage', 'ocpp2.0.1', {})).toBeNull();
  });

  it('maps and fits a shared command, which then passes the strict 2.0.1 check', () => {
    const payload = {
      ...relativeProfile({ startPeriod: 0, limit: 16, operationMode: 'ChargingOnly' }),
      customData: { vendorId: 'v' },
    };

    const result = translateCommand('SetChargingProfile', 'ocpp2.0.1', payload);

    expect(result).toEqual({
      action: 'SetChargingProfile',
      payload: { ...relativeProfile({ startPeriod: 0, limit: 16 }), customData: { vendorId: 'v' } },
    });
    expect(Registry201.SetChargingProfile.validateRequest(result?.payload)).toBe(true);
  });

  it('throws with the reason for a profile that only has a setpoint', () => {
    expect(() =>
      translateCommand(
        'SetChargingProfile',
        'ocpp2.0.1',
        relativeProfile({ startPeriod: 0, setpoint: 10 }),
      ),
    ).toThrow(/SetChargingProfile cannot be sent to an OCPP 2\.0\.1 station: .*setpoint/);
  });

  it('keeps the 2.1 command for a 2.1 station', () => {
    const payload = { type: 'ImmediateAndResume' };

    expect(translateCommand('Reset', 'ocpp2.1', payload)).toEqual({ action: 'Reset', payload });
    expect(() => translateCommand('Reset', 'ocpp2.0.1', payload)).toThrow(/ImmediateAndResume/);
  });

  it('leaves a 2.0.1 station answer unchanged', () => {
    const response = { status: 'Accepted' };

    expect(translateResponse('Reset', 'ocpp2.0.1', response)).toBe(response);
  });
});
