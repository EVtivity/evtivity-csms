// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  findTemplateTargetConfiguration,
  configTemplateTarget,
  configTemplateMatchesStation,
} from '../config-drift.js';
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
