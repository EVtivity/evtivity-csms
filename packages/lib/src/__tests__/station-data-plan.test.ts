// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  BOOT_OWNED_STATION_SETTINGS,
  DATA_PLANS,
  DATA_PLAN_DEFAULTS,
  DATA_PLAN_SETTING_KEYS,
  buildDataPlanCommands,
  dataPlanSettingKeys,
  dataPlanValuesFromSettings,
  isBootOwnedStationSetting,
  isDataPlan,
  measurandsForProtocol,
  parseStationDataPlanInvalidation,
  resolveDataPlan,
  stationDataPlanInvalidationPayload,
  validateDataPlanSetting,
} from '../station-data-plan.js';
import type { DataPlan, DataPlanCommand } from '../station-data-plan.js';

const PLAN_INPUTS: (DataPlan | null)[] = [null, 'wifi_or_wired', 'cellular'];

describe('resolveDataPlan', () => {
  it('orders station choice, confirmed SIM, site plan, default over every input', () => {
    for (const stationPlan of PLAN_INPUTS) {
      for (const hasConfirmedSim of [false, true]) {
        for (const sitePlan of PLAN_INPUTS) {
          const r = resolveDataPlan({ stationPlan, hasConfirmedSim, sitePlan });
          if (stationPlan != null) expect(r).toEqual({ plan: stationPlan, source: 'station' });
          else if (hasConfirmedSim) expect(r).toEqual({ plan: 'cellular', source: 'sim' });
          else if (sitePlan != null) expect(r).toEqual({ plan: sitePlan, source: 'site' });
          else expect(r).toEqual({ plan: 'wifi_or_wired', source: 'default' });
        }
      }
    }
  });

  it('keeps a station choice of Wi-Fi or wired over a confirmed SIM', () => {
    expect(
      resolveDataPlan({ stationPlan: 'wifi_or_wired', hasConfirmedSim: true, sitePlan: null }),
    ).toEqual({ plan: 'wifi_or_wired', source: 'station' });
  });

  it('recognizes plan ids', () => {
    expect(isDataPlan('cellular')).toBe(true);
    expect(isDataPlan('wifi_or_wired')).toBe(true);
    expect(isDataPlan('wifi')).toBe(false);
    expect(isDataPlan(null)).toBe(false);
  });
});

describe('dataPlanSettingKeys and values', () => {
  it('keeps the original keys for Wi-Fi or wired and prefixes Cellular', () => {
    expect(dataPlanSettingKeys('wifi_or_wired')).toEqual({
      heartbeatInterval: 'ocpp.heartbeatInterval',
      csmsPingInterval: 'ocpp.csmsPingInterval',
      clockAlignedInterval: 'ocpp.clockAlignedInterval',
      alignedMeasurands: 'ocpp.alignedMeasurands',
      txEndedMeasurands: 'ocpp.txEndedMeasurands',
      acMeterValueInterval: 'ocpp.meterValueInterval',
      acSampledMeasurands: 'ocpp.sampledMeasurands',
      dcMeterValueInterval: 'ocpp.dc.meterValueInterval',
      dcSampledMeasurands: 'ocpp.dc.sampledMeasurands',
    });
    expect(dataPlanSettingKeys('cellular').dcSampledMeasurands).toBe(
      'ocpp.cellular.dc.sampledMeasurands',
    );
    expect(DATA_PLAN_SETTING_KEYS).toHaveLength(18);
  });

  it('falls back to the shipped value per key and ignores a wrong type', () => {
    const rows = new Map<string, unknown>([
      ['ocpp.cellular.heartbeatInterval', 7200],
      ['ocpp.cellular.dc.sampledMeasurands', 'SoC'],
      ['ocpp.cellular.csmsPingInterval', 'x'],
    ]);
    const v = dataPlanValuesFromSettings('cellular', rows);
    expect(v.heartbeatInterval).toBe(7200);
    expect(v.dc.sampledMeasurands).toBe('SoC');
    expect(v.csmsPingInterval).toBe(240);
    expect(v.ac).toEqual(DATA_PLAN_DEFAULTS.cellular.ac);
  });

  it('takes the shipped value for a stored value out of range and trims lists', () => {
    const v = dataPlanValuesFromSettings(
      'wifi_or_wired',
      new Map<string, unknown>([
        ['ocpp.csmsPingInterval', 0],
        ['ocpp.alignedMeasurands', 'Bogus'],
        ['ocpp.txEndedMeasurands', 'Energy.Active.Import.Register, SoC'],
      ]),
    );
    expect(v.csmsPingInterval).toBe(120);
    expect(v.alignedMeasurands).toBe('Energy.Active.Import.Register');
    expect(v.txEndedMeasurands).toBe('Energy.Active.Import.Register,SoC');
  });

  it('ships the owner values', () => {
    expect(DATA_PLAN_DEFAULTS.wifi_or_wired).toMatchObject({
      heartbeatInterval: 900,
      csmsPingInterval: 120,
      clockAlignedInterval: 900,
      ac: { meterValueInterval: 60 },
      dc: { meterValueInterval: 30 },
    });
    expect(DATA_PLAN_DEFAULTS.cellular).toMatchObject({
      heartbeatInterval: 3600,
      csmsPingInterval: 240,
      clockAlignedInterval: 0,
      ac: { meterValueInterval: 300 },
      dc: { meterValueInterval: 60 },
    });
  });
});

describe('validateDataPlanSetting', () => {
  it('checks the interval ranges', () => {
    expect(validateDataPlanSetting('ocpp.heartbeatInterval', 30)).toBeNull();
    expect(validateDataPlanSetting('ocpp.heartbeatInterval', 29)).toMatch(/30 to 86400/);
    expect(validateDataPlanSetting('ocpp.cellular.heartbeatInterval', 86401)).not.toBeNull();
    expect(validateDataPlanSetting('ocpp.meterValueInterval', 0)).not.toBeNull();
    expect(validateDataPlanSetting('ocpp.dc.meterValueInterval', 5)).toBeNull();
    expect(validateDataPlanSetting('ocpp.cellular.dc.meterValueInterval', 3601)).not.toBeNull();
    expect(validateDataPlanSetting('ocpp.clockAlignedInterval', 0)).toBeNull();
    expect(validateDataPlanSetting('ocpp.clockAlignedInterval', 59)).toMatch(/0 or 60/);
    expect(validateDataPlanSetting('ocpp.csmsPingInterval', 3600)).toBeNull();
    expect(validateDataPlanSetting('ocpp.cellular.csmsPingInterval', 20)).not.toBeNull();
    expect(validateDataPlanSetting('ocpp.heartbeatInterval', 90.5)).not.toBeNull();
    expect(validateDataPlanSetting('ocpp.heartbeatInterval', '900')).not.toBeNull();
  });

  it('checks the measurand lists', () => {
    expect(validateDataPlanSetting('ocpp.sampledMeasurands', 'SoC,Temperature')).toBeNull();
    expect(validateDataPlanSetting('ocpp.cellular.alignedMeasurands', 'Bogus')).toMatch(/Bogus/);
    expect(validateDataPlanSetting('ocpp.txEndedMeasurands', '')).not.toBeNull();
    expect(validateDataPlanSetting('ocpp.dc.sampledMeasurands', 'SoC,,Voltage')).not.toBeNull();
    expect(validateDataPlanSetting('ocpp.dc.sampledMeasurands', 3)).not.toBeNull();
  });

  it('ignores other keys', () => {
    expect(validateDataPlanSetting('ocpp.offlineCommandTtlHours', -1)).toBeNull();
  });
});

function names(commands: DataPlanCommand[]): string[] {
  return commands.map((c) => {
    if (c.action === 'ChangeConfiguration')
      return `${String(c.payload['key'])}=${String(c.payload['value'])}`;
    const [d] = c.payload['setVariableData'] as {
      component: { name: string };
      variable: { name: string };
      attributeValue: string;
    }[];
    return `${d!.component.name}.${d!.variable.name}=${d!.attributeValue}`;
  });
}

describe('buildDataPlanCommands', () => {
  it('sends a Cellular 2.1 station idle interval 0 and no idle measurands', () => {
    const out = names(
      buildDataPlanCommands('ocpp2.1', DATA_PLAN_DEFAULTS.cellular, 'ac', {
        includeHeartbeat: false,
      }),
    );
    expect(out).toEqual([
      'SampledDataCtrlr.TxUpdatedInterval=300',
      'SampledDataCtrlr.TxUpdatedMeasurands=Energy.Active.Import.Register,Power.Active.Import',
      'SampledDataCtrlr.TxEndedMeasurands=Energy.Active.Import.Register',
      'AlignedDataCtrlr.Interval=0',
    ]);
  });

  it('sends a 1.6 Cellular station ClockAlignedDataInterval 0', () => {
    const out = names(
      buildDataPlanCommands('ocpp1.6', DATA_PLAN_DEFAULTS.cellular, 'dc', {
        includeHeartbeat: true,
      }),
    );
    expect(out).toEqual([
      'HeartbeatInterval=3600',
      'MeterValueSampleInterval=60',
      'MeterValuesSampledData=Energy.Active.Import.Register,Power.Active.Import,SoC',
      'StopTxnSampledData=Energy.Active.Import.Register',
      'ClockAlignedDataInterval=0',
    ]);
  });

  it('sends a DC Wi-Fi or wired station the DC values with SoC', () => {
    const out = names(
      buildDataPlanCommands('ocpp2.0.1', DATA_PLAN_DEFAULTS.wifi_or_wired, 'dc', {
        includeHeartbeat: true,
      }),
    );
    expect(out).toEqual([
      'OCPPCommCtrlr.HeartbeatInterval=900',
      'SampledDataCtrlr.TxUpdatedInterval=30',
      'SampledDataCtrlr.TxUpdatedMeasurands=Energy.Active.Import.Register,Power.Active.Import,Current.Import,SoC',
      'SampledDataCtrlr.TxEndedMeasurands=Energy.Active.Import.Register',
      'AlignedDataCtrlr.Interval=900',
      'AlignedDataCtrlr.Measurands=Energy.Active.Import.Register',
    ]);
  });

  it('sends only the charging values for a charging scope', () => {
    const out = names(
      buildDataPlanCommands('ocpp1.6', DATA_PLAN_DEFAULTS.wifi_or_wired, 'dc', {
        includeHeartbeat: true,
        scope: 'charging',
      }),
    );
    expect(out).toEqual([
      'MeterValueSampleInterval=30',
      'MeterValuesSampledData=Energy.Active.Import.Register,Power.Active.Import,Current.Import,SoC',
    ]);
  });

  it('leaves out 2.0.1-unknown measurands and a list that becomes empty', () => {
    const values = {
      ...DATA_PLAN_DEFAULTS.wifi_or_wired,
      txEndedMeasurands: 'Temperature',
      ac: { meterValueInterval: 60, sampledMeasurands: 'Voltage.Minimum,SoC' },
    };
    const out = names(
      buildDataPlanCommands('ocpp2.0.1', values, 'ac', { includeHeartbeat: false }),
    );
    expect(out).toContain('SampledDataCtrlr.TxUpdatedMeasurands=SoC');
    expect(out.some((n) => n.startsWith('SampledDataCtrlr.TxEndedMeasurands'))).toBe(false);
    const out21 = names(
      buildDataPlanCommands('ocpp2.1', values, 'ac', { includeHeartbeat: false }),
    );
    expect(out21).toContain('SampledDataCtrlr.TxUpdatedMeasurands=Voltage.Minimum,SoC');
  });

  it('sends nothing to an unknown protocol', () => {
    expect(
      buildDataPlanCommands(null, DATA_PLAN_DEFAULTS.cellular, 'ac', { includeHeartbeat: true }),
    ).toEqual([]);
  });

  it('sends a 1.6 station only 1.6 measurands and skips a list that becomes empty', () => {
    const values = {
      ...DATA_PLAN_DEFAULTS.wifi_or_wired,
      txEndedMeasurands: 'Power.Active.Setpoint',
      ac: { meterValueInterval: 60, sampledMeasurands: 'Power.Active.Setpoint,SoC,RPM' },
    };
    const out = names(buildDataPlanCommands('ocpp1.6', values, 'ac', { includeHeartbeat: false }));
    expect(out).toContain('MeterValuesSampledData=SoC,RPM');
    expect(out.some((n) => n.startsWith('StopTxnSampledData'))).toBe(false);
  });

  it('measurandsForProtocol keeps only the protocol enum', () => {
    expect(measurandsForProtocol(' SoC , RPM ,Voltage', 'ocpp2.1')).toBe('SoC,Voltage');
  });
});

describe('BOOT_OWNED_STATION_SETTINGS', () => {
  it('matches exactly what buildDataPlanCommands sends', () => {
    const sent16 = new Set<string>();
    const sent2x = new Set<string>();
    for (const plan of DATA_PLANS) {
      for (const kind of ['ac', 'dc'] as const) {
        for (const includeHeartbeat of [true, false]) {
          for (const protocol of ['ocpp1.6', 'ocpp2.0.1', 'ocpp2.1']) {
            for (const c of buildDataPlanCommands(protocol, DATA_PLAN_DEFAULTS[plan], kind, {
              includeHeartbeat,
            })) {
              if (c.action === 'ChangeConfiguration') {
                const key = String(c.payload['key']);
                expect(isBootOwnedStationSetting('1.6', '', key)).toBe(true);
                sent16.add(key);
              } else {
                for (const d of c.payload['setVariableData'] as {
                  component: { name: string };
                  variable: { name: string };
                }[]) {
                  expect(isBootOwnedStationSetting('2.1', d.component.name, d.variable.name)).toBe(
                    true,
                  );
                  sent2x.add(`${d.component.name}.${d.variable.name}`);
                }
              }
            }
          }
        }
      }
    }
    expect([...sent16].sort()).toEqual([...BOOT_OWNED_STATION_SETTINGS['1.6']].sort());
    expect([...sent2x].sort()).toEqual(
      BOOT_OWNED_STATION_SETTINGS['2.x'].map((e) => `${e.component}.${e.variable}`).sort(),
    );
  });

  it('compares names trimmed and per version', () => {
    expect(isBootOwnedStationSetting('ocpp1.6', null, ' HeartbeatInterval ')).toBe(true);
    expect(isBootOwnedStationSetting('2.1', ' OCPPCommCtrlr ', 'HeartbeatInterval')).toBe(true);
    expect(isBootOwnedStationSetting('2.1', 'ocppcommctrlr', 'HeartbeatInterval')).toBe(false);
    expect(isBootOwnedStationSetting('2.1', '', 'HeartbeatInterval')).toBe(false);
    expect(isBootOwnedStationSetting('1.6', '', 'WebSocketPingInterval')).toBe(false);
    expect(isBootOwnedStationSetting('2.1', 'OCPPCommCtrlr', 'WebSocketPingInterval')).toBe(false);
    expect(isBootOwnedStationSetting('2.1', 'AlignedDataCtrlr', '')).toBe(false);
  });
});

describe('station data plan invalidation', () => {
  it('round-trips the OCPP identity and ignores other kinds', () => {
    const msg: unknown = JSON.parse(stationDataPlanInvalidationPayload('CS-1'));
    expect(parseStationDataPlanInvalidation(msg)).toBe('CS-1');
    expect(
      parseStationDataPlanInvalidation({ kind: 'station_auth', stationId: 'CS-1' }),
    ).toBeNull();
    expect(parseStationDataPlanInvalidation(null)).toBeNull();
  });
});
