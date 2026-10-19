// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  chargingProfileFitsOcpp201,
  chargingProfileOcpp201Refusal,
  chargingProfileTemplateCondition,
  chargingProfileTemplateProtocols,
  templateProtocolCondition,
  templateReachesProtocol,
  templateStationProtocols,
} from '../lib/template-protocols.js';

describe('chargingProfileTemplateProtocols', () => {
  const template = (extra: Record<string, unknown> = {}) => ({
    ocppVersion: '2.1',
    profilePurpose: 'TxDefaultProfile',
    profileKind: 'Absolute',
    schedulePeriods: [{ startPeriod: 0, limit: 11000 }],
    ...extra,
  });

  it('reaches OCPP 2.0.1 stations with a template 2.0.1 can take', () => {
    expect(chargingProfileFitsOcpp201(template())).toBe(true);
    expect(chargingProfileTemplateProtocols(template())).toEqual(['ocpp2.0.1', 'ocpp2.1']);
  });

  it.each([
    ['PriorityCharging purpose', { profilePurpose: 'PriorityCharging' }],
    ['LocalGeneration purpose', { profilePurpose: 'LocalGeneration' }],
    ['Dynamic kind', { profileKind: 'Dynamic' }],
    ['discharge limit', { schedulePeriods: [{ startPeriod: 0, limit: -5000 }] }],
    ['period without a limit', { schedulePeriods: [{ startPeriod: 0 }] }],
    ['setpoint', { schedulePeriods: [{ startPeriod: 0, limit: 1, setpoint: 5 }] }],
    [
      'discharge limit field',
      { schedulePeriods: [{ startPeriod: 0, limit: 1, dischargeLimit: -1 }] },
    ],
    [
      'per-phase limit that differs',
      { schedulePeriods: [{ startPeriod: 0, limit: 16, limit_L2: 8 }] },
    ],
    [
      'operation mode other than ChargingOnly',
      { schedulePeriods: [{ startPeriod: 0, limit: 16, operationMode: 'CentralSetpoint' }] },
    ],
  ])('leaves OCPP 2.0.1 stations out for a %s', (_name, extra) => {
    expect(chargingProfileFitsOcpp201(template(extra))).toBe(false);
    expect(chargingProfileTemplateProtocols(template(extra))).toEqual(['ocpp2.1']);
  });

  it('keeps a 1.6 template on 1.6 stations', () => {
    expect(chargingProfileTemplateProtocols(template({ ocppVersion: '1.6' }))).toEqual(['ocpp1.6']);
  });
});

describe('templateStationProtocols', () => {
  it('reaches OCPP 2.0.1 and 2.1 stations with a 2.1 template', () => {
    expect(templateStationProtocols('2.1')).toEqual(['ocpp2.0.1', 'ocpp2.1']);
  });

  it('reaches only OCPP 1.6 stations with a 1.6 template', () => {
    expect(templateStationProtocols('1.6')).toEqual(['ocpp1.6']);
  });
});

describe('templateReachesProtocol', () => {
  it('matches a 2.1 template to 2.x stations and a 1.6 template to 1.6 stations', () => {
    expect(templateReachesProtocol('2.1', 'ocpp2.0.1')).toBe(true);
    expect(templateReachesProtocol('2.1', 'ocpp2.1')).toBe(true);
    expect(templateReachesProtocol('2.1', 'ocpp1.6')).toBe(false);
    expect(templateReachesProtocol('1.6', 'ocpp1.6')).toBe(true);
    expect(templateReachesProtocol('1.6', 'ocpp2.0.1')).toBe(false);
    expect(templateReachesProtocol('2.1', null)).toBe(false);
  });
});

describe('chargingProfileOcpp201Refusal', () => {
  it('gives the reason the OCPP server would refuse the profile with', () => {
    expect(
      chargingProfileOcpp201Refusal({
        ocppVersion: '2.1',
        profilePurpose: 'TxDefaultProfile',
        profileKind: 'Absolute',
        schedulePeriods: [{ startPeriod: 0, limit: -5000 }],
      }),
    ).toBe(
      'chargingProfile.chargingSchedule[0].chargingSchedulePeriod[0].limit -5000 is a discharge limit, OCPP 2.0.1 has no discharging',
    );
  });

  it('keeps a per-phase limit equal to the limit, which 2.0.1 drops', () => {
    expect(
      chargingProfileOcpp201Refusal({
        ocppVersion: '2.1',
        profilePurpose: 'TxDefaultProfile',
        profileKind: 'Absolute',
        schedulePeriods: [{ startPeriod: 0, limit: 16, limit_L2: 16, limit_L3: 16 }],
      }),
    ).toBeNull();
  });
});

describe('template station conditions', () => {
  const dialect = new PgDialect();

  it('leave conformance test stations out', () => {
    const config = dialect.sqlToQuery(templateProtocolCondition('2.1'));
    expect(config.sql).toContain('"is_conformance"');
    expect(config.params).toEqual(['ocpp2.0.1', 'ocpp2.1', false]);

    const profile = dialect.sqlToQuery(
      chargingProfileTemplateCondition({
        ocppVersion: '2.1',
        profilePurpose: 'PriorityCharging',
        profileKind: 'Absolute',
        schedulePeriods: [{ startPeriod: 0, limit: 1 }],
      }),
    );
    expect(profile.sql).toContain('"is_conformance"');
    expect(profile.params).toEqual(['ocpp2.1', false]);
  });
});
