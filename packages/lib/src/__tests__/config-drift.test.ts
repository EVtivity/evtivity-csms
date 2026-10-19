// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  findTemplateTargetConfiguration,
  configTemplateTarget,
  configTemplateMatchesStation,
  hasConfigDrift,
} from '../config-drift.js';

describe('hasConfigDrift', () => {
  const tx = { component: 'TxCtrlr', variable: 'EVConnectionTimeOut', value: '60' };
  const resumption = { component: 'TxCtrlr', variable: 'ResumptionTimeout', value: '60' };

  it('counts a different or missing value as drift', () => {
    expect(hasConfigDrift('ocpp2.1', tx, { value: '30' })).toBe(true);
    expect(hasConfigDrift('ocpp2.1', tx, undefined)).toBe(true);
    expect(hasConfigDrift('ocpp1.6', { ...tx, component: '' }, undefined)).toBe(true);
    expect(hasConfigDrift('ocpp2.0.1', tx, { value: '30' })).toBe(true);
    expect(hasConfigDrift('ocpp2.0.1', tx, { value: '60' })).toBe(false);
  });

  it('counts an unreported OCPP 2.0.1 variable as drift on a 2.0.1 station', () => {
    expect(hasConfigDrift('ocpp2.0.1', tx, undefined)).toBe(true);
  });

  it('skips a 2.1-only variable an OCPP 2.0.1 station never reported', () => {
    expect(hasConfigDrift('ocpp2.0.1', resumption, undefined)).toBe(false);
    expect(
      hasConfigDrift(
        'ocpp2.0.1',
        { component: 'V2XChargingCtrlr', variable: 'Enabled', value: 'true' },
        undefined,
      ),
    ).toBe(false);
    // A 2.0.1 station that reports it anyway is compared.
    expect(hasConfigDrift('ocpp2.0.1', resumption, { value: '30' })).toBe(true);
  });

  it('keeps counting an unreported 2.1-only variable on a 2.1 station', () => {
    expect(hasConfigDrift('ocpp2.1', resumption, undefined)).toBe(true);
  });
});
import type { ReportedConfiguration } from '../config-drift.js';

function row(overrides: Partial<ReportedConfiguration>): ReportedConfiguration {
  return {
    component: 'TxCtrlr',
    instance: null,
    evseId: null,
    connectorId: null,
    variable: 'EVConnectionTimeOut',
    variableInstance: null,
    attributeType: 'Actual',
    value: '60',
    ...overrides,
  };
}

describe('findTemplateTargetConfiguration', () => {
  it('returns the top-level Actual row', () => {
    const target = row({ value: '30' });
    const rows = [
      row({ evseId: 1 }),
      row({ connectorId: 1, evseId: 1 }),
      row({ instance: 'Main' }),
      row({ variableInstance: 'Other' }),
      row({ attributeType: 'MaxSet' }),
      target,
    ];
    expect(findTemplateTargetConfiguration(rows, 'TxCtrlr', 'EVConnectionTimeOut')).toBe(target);
  });

  it('returns undefined when only other instances, EVSEs, or attributes exist', () => {
    const rows = [
      row({ evseId: 1 }),
      row({ variableInstance: 'Other' }),
      row({ attributeType: 'Target' }),
    ];
    expect(findTemplateTargetConfiguration(rows, 'TxCtrlr', 'EVConnectionTimeOut')).toBeUndefined();
  });

  it('matches an OCPP 1.6 template (no component) to the GetConfiguration row', () => {
    const target = row({ component: 'OCPP', variable: 'HeartbeatInterval', value: '300' });
    expect(findTemplateTargetConfiguration([target], '', 'HeartbeatInterval')).toBe(target);
  });
});

describe('configTemplateTarget', () => {
  it('targets only the bound station, whatever the filter says', () => {
    expect(
      configTemplateTarget({ stationId: 'st_1', targetFilter: { siteId: 'site_2', model: 'M' } }),
    ).toEqual({ stationId: 'st_1' });
    expect(configTemplateTarget({ stationId: 'st_1', targetFilter: null })).toEqual({
      stationId: 'st_1',
    });
  });

  it('reads the non-empty filter fields of an unbound template', () => {
    expect(
      configTemplateTarget({
        stationId: null,
        targetFilter: { siteId: 'site_1', vendorId: '', model: 'M', stationId: 'st_2', x: 'y' },
      }),
    ).toEqual({ siteId: 'site_1', model: 'M', stationId: 'st_2' });
  });

  it('targets every station without a filter', () => {
    expect(configTemplateTarget({ stationId: null, targetFilter: null })).toEqual({});
  });
});

describe('configTemplateMatchesStation', () => {
  const station = { id: 'st_1', siteId: 'site_1', vendorId: 'ven_1', model: 'M1' };

  it('matches a bound template only on its station', () => {
    expect(configTemplateMatchesStation({ stationId: 'st_1', targetFilter: null }, station)).toBe(
      true,
    );
    expect(configTemplateMatchesStation({ stationId: 'st_2', targetFilter: null }, station)).toBe(
      false,
    );
    expect(
      configTemplateMatchesStation(
        { stationId: 'st_2', targetFilter: { stationId: 'st_1' } },
        station,
      ),
    ).toBe(false);
  });

  it('matches an unbound template by every filter field', () => {
    const t = (targetFilter: Record<string, string> | null) => ({ stationId: null, targetFilter });
    expect(configTemplateMatchesStation(t(null), station)).toBe(true);
    expect(configTemplateMatchesStation(t({ siteId: 'site_1', model: 'M1' }), station)).toBe(true);
    expect(configTemplateMatchesStation(t({ siteId: 'site_2' }), station)).toBe(false);
    expect(configTemplateMatchesStation(t({ vendorId: 'ven_2' }), station)).toBe(false);
    expect(configTemplateMatchesStation(t({ model: 'M2' }), station)).toBe(false);
    expect(configTemplateMatchesStation(t({ stationId: 'st_9' }), station)).toBe(false);
  });
});
