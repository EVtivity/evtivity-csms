// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  buildChargingInformation,
  pointFaultOfErrorCode,
  pointStatus,
  pointStatusOfConnector,
  predictSocTimeline,
  processStatus,
  provideChargingInformationRequestSchema,
  stationFaultOfErrorCode,
  stationStatus,
  vehicleChargingStatus,
  type DepotSnapshot,
  type PointSnapshot,
  type PredictionSnapshot,
  type ProcessSnapshot,
} from '../vdv463/index.js';

const NOW = new Date('2026-03-10T07:00:00Z');
const NO_PREDICTION: PredictionSnapshot = {
  minSocPercent: null,
  minReachedAt: null,
  finalSocPercent: null,
  finalReachedAt: null,
  departureAt: null,
  socAtDeparture: null,
};

function point(over: Partial<PointSnapshot> = {}): PointSnapshot {
  return {
    evseId: 1,
    connectorStatuses: ['Available'],
    errorCode: null,
    errorAt: null,
    errorText: null,
    allowedKw: null,
    meterWh: 1_204_000,
    powerKw: null,
    temperatureC: null,
    process: null,
    scheduled: [],
    ...over,
  };
}

function process(over: Partial<ProcessSnapshot> = {}): ProcessSnapshot {
  return {
    processId: 'vdp_1',
    presystemId: 'DMS-NORTH',
    requestId: 'north/req-1',
    startedAt: new Date('2026-03-10T06:02:10Z'),
    state: 'Charging',
    queued: false,
    rejected: false,
    deliveredWh: 41_500,
    powerKw: 96.4,
    currentA: 131.2,
    voltageV: 735.1,
    reactiveKvar: null,
    vehicle: {
      vin: 'EVTVDVTEST0000001',
      evccId: '0A1B2C3D4E5F',
      socPercent: 52,
      preconditioningStatus: null,
      hvacPreconditioningActive: false,
    },
    prediction: NO_PREDICTION,
    ...over,
  };
}

function depot(points: PointSnapshot[], online = true): DepotSnapshot[] {
  return [
    {
      siteId: 'sit_vdvdepot01',
      name: 'North Bus Depot',
      stations: [
        {
          ocppId: 'VDV-CS-01',
          isOnline: online,
          offlineSince: online ? null : new Date('2026-03-10T06:40:00Z'),
          stationErrorCode: null,
          stationErrorAt: null,
          points,
        },
      ],
    },
  ];
}

describe('status mapping', () => {
  it.each([
    ['Available', 'Available'],
    ['Reserved', 'Reserved'],
    ['Unavailable', 'Unavailable'],
    ['Faulted', 'Faulted'],
    ['Occupied', 'Occupied'],
    ['Preparing', 'Occupied'],
    ['Charging', 'Occupied'],
    ['SuspendedEV', 'Occupied'],
    ['SuspendedEVSE', 'Occupied'],
    ['Finishing', 'Occupied'],
  ])('maps the OCPP connector status %s to %s', (ocpp, vdv) => {
    expect(pointStatusOfConnector(ocpp)).toBe(vdv);
  });

  it('takes the worst connector of an EVSE', () => {
    expect(pointStatus(['Available', 'Occupied'], true)).toBe('Occupied');
    expect(pointStatus(['Faulted', 'Occupied'], true)).toBe('Faulted');
    expect(pointStatus(['Reserved', 'Available'], true)).toBe('Reserved');
  });

  it('reports the points of an offline station as unavailable', () => {
    expect(pointStatus(['Available'], false)).toBe('Unavailable');
  });

  it('aggregates the station as issue #2 describes', () => {
    expect(stationStatus(['Available', 'Occupied', 'Reserved'], true)).toBe('Available');
    expect(stationStatus(['Available', 'Unavailable'], true)).toBe('Unavailable');
    expect(stationStatus(['Unavailable', 'Faulted'], true)).toBe('Faulted');
    expect(stationStatus(['Available'], false)).toBe('Unavailable');
  });

  it('maps OCPP 1.6 error codes to point and station faults', () => {
    expect(pointFaultOfErrorCode('EVCommunicationError')).toBe('CommunicationFailure');
    expect(pointFaultOfErrorCode('ConnectorLockFailure')).toBe('UsageFailure');
    expect(pointFaultOfErrorCode('ReaderFailure')).toBe('UsageFailure');
    expect(pointFaultOfErrorCode('GroundFailure')).toBeNull();
    for (const code of [
      'GroundFailure',
      'PowerSwitchFailure',
      'OverCurrentFailure',
      'OverVoltage',
      'UnderVoltage',
      'HighTemperature',
      'PowerMeterFailure',
    ]) {
      expect(stationFaultOfErrorCode(code)).toBe('ElectricalOperationFailure');
    }
    expect(stationFaultOfErrorCode('LocalListConflict')).toBe('ConfigurationFailure');
    expect(stationFaultOfErrorCode('InternalError')).toBe('OtherChargingStationFailure');
    expect(stationFaultOfErrorCode('NoError')).toBeNull();
    expect(stationFaultOfErrorCode('EVCommunicationError')).toBeNull();
  });

  it('derives the vehicle charging status from the OCPP state', () => {
    expect(vehicleChargingStatus('Charging')).toBe('Charging');
    expect(vehicleChargingStatus('SuspendedEVSE')).toBe('ReadyToCharge');
    expect(vehicleChargingStatus('Preparing')).toBe('ReadyToCharge');
    expect(vehicleChargingStatus('SuspendedEV')).toBe('ReadyToCharge');
    expect(vehicleChargingStatus('Finishing')).toBe('ReadyToCharge');
  });

  it('puts a refused profile and a queued plan above the OCPP state', () => {
    expect(processStatus(process({ rejected: true }))).toBe('ChargingRejectedTechnically');
    expect(processStatus(process({ queued: true, state: 'SuspendedEVSE' }))).toBe('Queued');
    expect(processStatus(process({ queued: true, state: 'Finishing' }))).toBe('Finishing');
    expect(processStatus(process({ state: 'SuspendedEV' }))).toBe('SuspendedEV');
  });
});

describe('buildChargingInformation', () => {
  it('reports an idle depot with every required field', () => {
    const out = buildChargingInformation(
      depot([point(), point({ evseId: 2, meterWh: 2_400_000 })]),
      NOW,
    );
    expect(out).toEqual({
      depotInfoList: [
        {
          depotId: 'sit_vdvdepot01',
          name: 'North Bus Depot',
          chargingStationInfoList: [
            {
              chargingStationId: 'VDV-CS-01',
              chargingStationStatus: 'Available',
              chargingPointInfoList: [
                {
                  chargingPointId: 'VDV-CS-01/1',
                  chargingPointStatus: 'Available',
                  energyMeterReading: 1_204_000,
                },
                {
                  chargingPointId: 'VDV-CS-01/2',
                  chargingPointStatus: 'Available',
                  energyMeterReading: 2_400_000,
                },
              ],
            },
          ],
        },
      ],
    });
    expect(provideChargingInformationRequestSchema.safeParse(out).success).toBe(true);
  });

  it('reports a charging process with the vehicle, electric data and predictions', () => {
    const out = buildChargingInformation(
      depot([
        point({
          connectorStatuses: ['Occupied'],
          allowedKw: 100,
          powerKw: 96.4,
          process: process({
            prediction: {
              minSocPercent: 80,
              minReachedAt: new Date('2026-03-10T08:10:00Z'),
              finalSocPercent: 95,
              finalReachedAt: new Date('2026-03-10T08:50:00Z'),
              departureAt: new Date('2026-03-10T09:15:00Z'),
              socAtDeparture: 95,
            },
          }),
        }),
      ]),
      NOW,
    );
    const cp = out.depotInfoList[0]?.chargingStationInfoList[0]?.chargingPointInfoList[0];
    expect(cp?.presentPower).toBe(100);
    expect(cp?.vehicleInfo).toEqual({
      vehicleId: 'EVTVDVTEST0000001',
      evccId: '0A1B2C3D4E5F',
      tractionBatteryInfo: { stateOfCharge: 52 },
      vehicleStatusInfo: {},
      vehicleChargingStatus: 'Charging',
      preconditioningInfo: {},
    });
    expect(cp?.chargingProcessInfo).toEqual({
      presystemId: 'DMS-NORTH',
      chargingRequestId: 'north/req-1',
      chargingProcessId: 'vdp_1',
      processStatus: 'Charging',
      startTime: '2026-03-10T06:02:10Z',
      chargingPredictionData: {
        chargingPredictionDataMinSoc: {
          requestedMinSoc: 80,
          predictedTime: '2026-03-10T08:10:00Z',
        },
        chargingPredictionDataFinalSoc: {
          predictedFinalSoc: 95,
          predictedTime: '2026-03-10T08:50:00Z',
        },
        chargingPredictionDataDepartureTime: {
          predictedDepartureTimeSoc: 95,
          predictedTime: '2026-03-10T09:15:00Z',
        },
      },
      electricData: { chargingCurrent: 131.2, chargingVoltage: 735.1, chargingPower: 96.4 },
      deliveredEnergy: 41_500,
    });
    expect(out.depotInfoList[0]?.chargingStationInfoList[0]?.totalPower).toBe(96.4);
    expect(provideChargingInformationRequestSchema.safeParse(out).success).toBe(true);
  });

  it('sends charging power 0 before the station measured anything', () => {
    const out = buildChargingInformation(
      depot([
        point({
          connectorStatuses: ['Occupied'],
          process: process({ state: 'Preparing', powerKw: null, currentA: null, voltageV: null }),
        }),
      ]),
      NOW,
    );
    expect(
      out.depotInfoList[0]?.chargingStationInfoList[0]?.chargingPointInfoList[0]
        ?.chargingProcessInfo?.electricData,
    ).toEqual({ chargingPower: 0 });
  });

  it('leaves out the request ids of a process another system or nobody requested', () => {
    const out = buildChargingInformation(
      depot([
        point({
          connectorStatuses: ['Occupied'],
          process: process({
            presystemId: null,
            requestId: null,
            processId: 'ses_7',
            vehicle: null,
          }),
        }),
      ]),
      NOW,
    );
    const cp = out.depotInfoList[0]?.chargingStationInfoList[0]?.chargingPointInfoList[0];
    expect(cp?.vehicleInfo).toBeUndefined();
    expect(cp?.chargingProcessInfo?.presystemId).toBeUndefined();
    expect(cp?.chargingProcessInfo?.chargingRequestId).toBeUndefined();
    expect(cp?.chargingProcessInfo?.chargingProcessId).toBe('ses_7');
  });

  it('reports the 2.1 preconditioning status and a started manual HVAC window', () => {
    const out = buildChargingInformation(
      depot([
        point({
          connectorStatuses: ['Occupied'],
          process: process({
            vehicle: {
              vin: 'V',
              evccId: null,
              socPercent: null,
              preconditioningStatus: 'Preconditioning',
              hvacPreconditioningActive: true,
            },
          }),
        }),
      ]),
      NOW,
    );
    expect(
      out.depotInfoList[0]?.chargingStationInfoList[0]?.chargingPointInfoList[0]?.vehicleInfo
        ?.vehicleStatusInfo,
    ).toEqual({
      systemPreconditioningActive: true,
      hvacPreconditioningActive: true,
    });
  });

  it('lists a scheduled process under its requested point', () => {
    const out = buildChargingInformation(
      depot([
        point({
          scheduled: [
            {
              presystemId: 'DMS-NORTH',
              requestId: 'north/req-2',
              processId: 'vdp_2',
              vin: 'EVTVDVTEST0000002',
              startAt: new Date('2026-03-10T07:30:00Z'),
              prediction: {
                ...NO_PREDICTION,
                minSocPercent: 70,
                minReachedAt: new Date('2026-03-10T09:00:00Z'),
              },
            },
          ],
        }),
      ]),
      NOW,
    );
    expect(
      out.depotInfoList[0]?.chargingStationInfoList[0]?.chargingPointInfoList[0]
        ?.scheduledChargingProcessList,
    ).toEqual([
      {
        presystemId: 'DMS-NORTH',
        chargingRequestId: 'north/req-2',
        chargingProcessId: 'vdp_2',
        vehicleId: 'EVTVDVTEST0000002',
        startTime: '2026-03-10T07:30:00Z',
        chargingPredictionData: {
          chargingPredictionDataMinSoc: {
            requestedMinSoc: 70,
            predictedTime: '2026-03-10T09:00:00Z',
          },
        },
      },
    ]);
    expect(provideChargingInformationRequestSchema.safeParse(out).success).toBe(true);
  });

  it('reports an offline station as unavailable with a communication fault', () => {
    const out = buildChargingInformation(depot([point()], false), NOW);
    const cs = out.depotInfoList[0]?.chargingStationInfoList[0];
    expect(cs?.chargingStationStatus).toBe('Unavailable');
    expect(cs?.chargingStationFaultInfo).toEqual({
      chargingStationFaultCode: 'CommunicationFailure',
      faultText: 'Charging station offline',
      faultTimeStamp: '2026-03-10T06:40:00Z',
    });
    expect(cs?.chargingPointInfoList[0]?.chargingPointFaultInfo?.chargingPointFaultCode).toBe(
      'CommunicationFailure',
    );
  });

  it('reports a faulted point with its 1.6 code and a station fault', () => {
    const out = buildChargingInformation(
      [
        {
          siteId: 's',
          name: 'n',
          stations: [
            {
              ocppId: 'CS',
              isOnline: true,
              offlineSince: null,
              stationErrorCode: 'GroundFailure',
              stationErrorAt: new Date('2026-03-10T06:55:00Z'),
              points: [
                point({
                  connectorStatuses: ['Faulted'],
                  errorCode: 'ConnectorLockFailure',
                  errorAt: new Date('2026-03-10T06:50:00Z'),
                  errorText: 'lock',
                }),
              ],
            },
          ],
        },
      ],
      NOW,
    );
    const cs = out.depotInfoList[0]?.chargingStationInfoList[0];
    expect(cs?.chargingStationStatus).toBe('Faulted');
    expect(cs?.chargingStationFaultInfo?.chargingStationFaultCode).toBe(
      'ElectricalOperationFailure',
    );
    expect(cs?.chargingPointInfoList[0]?.chargingPointFaultInfo).toEqual({
      chargingPointFaultCode: 'UsageFailure',
      faultText: 'lock',
      faultTimeStamp: '2026-03-10T06:50:00Z',
    });
  });

  it('reports a faulted 2.x point without an error code as another point failure', () => {
    const out = buildChargingInformation(depot([point({ connectorStatuses: ['Faulted'] })]), NOW);
    expect(
      out.depotInfoList[0]?.chargingStationInfoList[0]?.chargingPointInfoList[0]
        ?.chargingPointFaultInfo?.chargingPointFaultCode,
    ).toBe('OtherChargingPointFailure');
  });

  it('keeps empty lists', () => {
    expect(buildChargingInformation([], NOW)).toEqual({ depotInfoList: [] });
    const out = buildChargingInformation([{ siteId: 's', name: 'n', stations: [] }], NOW);
    expect(out.depotInfoList[0]?.chargingStationInfoList).toEqual([]);
  });
});

describe('predictSocTimeline', () => {
  const slots = [
    { startMs: Date.parse('2026-03-10T07:00:00Z'), endMs: Date.parse('2026-03-10T07:15:00Z') },
    { startMs: Date.parse('2026-03-10T07:15:00Z'), endMs: Date.parse('2026-03-10T07:30:00Z') },
    { startMs: Date.parse('2026-03-10T07:30:00Z'), endMs: Date.parse('2026-03-10T07:45:00Z') },
  ];
  const base = {
    nowMs: Date.parse('2026-03-10T07:00:00Z'),
    socPercent: 50,
    capacityKwh: 400,
    slots,
    // 160 kW for 15 minutes is 40 kWh, 10 percent of 400 kWh.
    powerKw: [160, 160, 0],
    minSocPercent: 55,
    maxSocPercent: 65,
    departureMs: Date.parse('2026-03-10T07:45:00Z'),
  };

  it('interpolates inside a slot', () => {
    const p = predictSocTimeline(base);
    expect(p.minReachedAt?.toISOString()).toBe('2026-03-10T07:07:30.000Z');
    expect(p.finalSocPercent).toBeCloseTo(65);
    expect(p.finalReachedAt?.toISOString()).toBe('2026-03-10T07:22:30.000Z');
    expect(p.socAtDeparture).toBeCloseTo(70);
  });

  it('ends at the planned SoC when the plan stays below the maximum', () => {
    const p = predictSocTimeline({ ...base, maxSocPercent: 90 });
    expect(p.finalSocPercent).toBeCloseTo(70);
    expect(p.finalReachedAt?.toISOString()).toBe('2026-03-10T07:30:00.000Z');
  });

  it('reaches a target the battery already holds now', () => {
    const p = predictSocTimeline({ ...base, socPercent: 60 });
    expect(p.minReachedAt?.toISOString()).toBe('2026-03-10T07:00:00.000Z');
  });

  it('has no minimum time when the plan never gets there', () => {
    expect(
      predictSocTimeline({ ...base, minSocPercent: 95, maxSocPercent: 95 }).minReachedAt,
    ).toBeNull();
  });

  it('stops a full battery at 100 percent', () => {
    const p = predictSocTimeline({
      ...base,
      socPercent: 95,
      minSocPercent: 100,
      maxSocPercent: 100,
    });
    expect(p.socAtDeparture).toBe(100);
    expect(p.minReachedAt?.toISOString()).toBe('2026-03-10T07:07:30.000Z');
  });

  it('knows nothing without a SoC or a capacity', () => {
    expect(predictSocTimeline({ ...base, socPercent: null }).minReachedAt).toBeNull();
    expect(predictSocTimeline({ ...base, capacityKwh: null }).finalSocPercent).toBeNull();
  });

  it('has no departure prediction for an ad hoc request', () => {
    const p = predictSocTimeline({ ...base, departureMs: null });
    expect(p.departureAt).toBeNull();
    expect(p.socAtDeparture).toBeNull();
  });
});
