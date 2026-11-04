// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Conformance exchanges of the bus depot interface, one per communication
// sequence of VDV 463 section 6.2 (6.2.1 to 6.2.9), written with our own
// identifiers, times and values: depot sit_vdvdepot01, station VDV-CS-01 with
// two EVSEs, bus EVTVDVTEST0000001 (420 kWh, 120 kW). Each step is a frame the
// depot system sends (with what EVtivity reads from it) or a state EVtivity
// reports (the snapshot and the payload it must build).

import type {
  CheckedChargingRequest,
  DepotSnapshot,
  PointSnapshot,
  ProcessSnapshot,
} from '../../../vdv463/index.js';

export const PRESYSTEM = 'DMS-NORTH';
export const VIN = 'EVTVDVTEST0000001';
export const TRUCK_VIN = 'EVTVDVTRUCK000002';
export const REQUEST_ID = 'north/2026-03-10/run-17';
export const DEPARTURE_ID = 'vdp_vdvrun17';

export interface InboundStep {
  kind: 'in';
  /** The frame the depot system sends. */
  frame: unknown[];
  /** For a request list: what EVtivity reads from each request (null: refused with the reason). */
  expected?: Array<CheckedChargingRequest | { refused: string }>;
}

export interface OutboundStep {
  kind: 'out';
  now: string;
  snapshot: DepotSnapshot[];
  payload: unknown;
}

export interface Sequence {
  follows: string;
  title: string;
  steps: Array<InboundStep | OutboundStep>;
}

const NO_PREDICTION = {
  minSocPercent: null,
  minReachedAt: null,
  finalSocPercent: null,
  finalReachedAt: null,
  departureAt: null,
  socAtDeparture: null,
};

function idlePoint(
  evseId: number,
  meterWh: number,
  over: Partial<PointSnapshot> = {},
): PointSnapshot {
  return {
    evseId,
    connectorStatuses: ['Available'],
    errorCode: null,
    errorAt: null,
    errorText: null,
    allowedKw: 0,
    meterWh,
    powerKw: 0,
    temperatureC: null,
    process: null,
    scheduled: [],
    ...over,
  };
}

function depot(points: PointSnapshot[]): DepotSnapshot[] {
  return [
    {
      siteId: 'sit_vdvdepot01',
      name: 'North Bus Depot',
      stations: [
        {
          ocppId: 'VDV-CS-01',
          isOnline: true,
          offlineSince: null,
          stationErrorCode: null,
          stationErrorAt: null,
          points,
        },
      ],
    },
  ];
}

function depotPayload(points: unknown[]): unknown {
  return {
    depotInfoList: [
      {
        depotId: 'sit_vdvdepot01',
        name: 'North Bus Depot',
        chargingStationInfoList: [
          {
            chargingStationId: 'VDV-CS-01',
            chargingStationStatus: 'Available',
            chargingPointInfoList: points,
            totalPower: points.reduce<number>(
              (sum, p) => sum + ((p as { _power?: number })._power ?? 0),
              0,
            ),
          },
        ],
      },
    ],
  };
}

const IDLE_2 = {
  chargingPointId: 'VDV-CS-01/2',
  chargingPointStatus: 'Available',
  presentPower: 0,
  energyMeterReading: 2_310_000,
};

function process(over: Partial<ProcessSnapshot>): ProcessSnapshot {
  return {
    processId: DEPARTURE_ID,
    presystemId: PRESYSTEM,
    requestId: REQUEST_ID,
    startedAt: new Date('2026-03-10T06:01:12Z'),
    state: 'Preparing',
    queued: false,
    rejected: false,
    deliveredWh: 0,
    powerKw: 0,
    currentA: null,
    voltageV: null,
    reactiveKvar: null,
    vehicle: null,
    prediction: {
      minSocPercent: 80,
      minReachedAt: new Date('2026-03-10T08:41:00Z'),
      finalSocPercent: 95,
      finalReachedAt: new Date('2026-03-10T09:05:00Z'),
      departureAt: new Date('2026-03-10T09:15:00Z'),
      socAtDeparture: 95,
    },
    ...over,
  };
}

const PREDICTION_PAYLOAD = {
  chargingPredictionDataMinSoc: { requestedMinSoc: 80, predictedTime: '2026-03-10T08:41:00Z' },
  chargingPredictionDataFinalSoc: { predictedFinalSoc: 95, predictedTime: '2026-03-10T09:05:00Z' },
  chargingPredictionDataDepartureTime: {
    predictedDepartureTimeSoc: 95,
    predictedTime: '2026-03-10T09:15:00Z',
  },
};

const REQUEST = {
  chargingPointId: 'VDV-CS-01/1',
  vehicleId: VIN,
  chargingRequestId: REQUEST_ID,
  priority: 2,
  chargingInstruction: 'Normal',
  chargingRequestData: {
    expectedArrivalTimeAtChargingPoint: '2026-03-10T06:00:00Z',
    expectedSocAtArrival: 31,
    minTargetSoc: 80,
    maxTargetSoc: 95,
    requestedTimeForDeparture: '2026-03-10T09:15:00Z',
  },
};

const CHECKED: CheckedChargingRequest = {
  externalRequestId: REQUEST_ID,
  vehicleRef: VIN,
  chargingPointRef: 'VDV-CS-01/1',
  chargingProcessRef: null,
  terminate: false,
  priority: 9,
  externalPriority: 2,
  minSocPercent: 80,
  maxSocPercent: 95,
  adHoc: false,
  departureAt: new Date('2026-03-10T09:15:00Z'),
  expectedArrivalAt: new Date('2026-03-10T06:00:00Z'),
  expectedArrivalSocPercent: 31,
  preconditioning: null,
};

function frame(type: number, at: string, id: string, action: string, payload: unknown): unknown[] {
  return [type, type === 2 ? 'BMS' : 'BMS', PRESYSTEM, at, id, action, payload];
}

export const SEQUENCES: Sequence[] = [
  {
    follows: 'VDV 463 6.2.1',
    title: 'provisioning and connection: the depot system boots, EVtivity reports the idle depot',
    steps: [
      {
        kind: 'in',
        frame: frame(
          1,
          '2026-03-10T04:58:00Z',
          '0b7d1f8e-2a3c-4e5f-9a1b-2c3d4e5f6a7b',
          'BootNotification',
          { presystem: 'BMS' },
        ),
      },
      {
        kind: 'out',
        now: '2026-03-10T04:58:01Z',
        snapshot: depot([idlePoint(1, 1_204_000), idlePoint(2, 2_310_000)]),
        payload: depotPayload([
          {
            chargingPointId: 'VDV-CS-01/1',
            chargingPointStatus: 'Available',
            presentPower: 0,
            energyMeterReading: 1_204_000,
          },
          IDLE_2,
        ]),
      },
    ],
  },
  {
    follows: 'VDV 463 6.2.2',
    title:
      'first charging request: one bus applies, a truck in the same list is refused, the bus shows as scheduled',
    steps: [
      {
        kind: 'in',
        frame: frame(
          1,
          '2026-03-10T05:00:00Z',
          '1c8e2a9f-3b4d-4f60-8b2c-3d4e5f6a7b8c',
          'ProvideChargingRequests',
          {
            chargingRequestList: [
              REQUEST,
              {
                ...REQUEST,
                vehicleId: TRUCK_VIN,
                chargingRequestId: 'north/2026-03-10/truck-4',
                chargingPointId: 'VDV-CS-01/2',
              },
            ],
          },
        ),
        expected: [CHECKED, { refused: 'vehicle_not_bus' }],
      },
      {
        kind: 'out',
        now: '2026-03-10T05:00:30Z',
        snapshot: depot([
          idlePoint(1, 1_204_000, {
            scheduled: [
              {
                presystemId: PRESYSTEM,
                requestId: REQUEST_ID,
                processId: DEPARTURE_ID,
                vin: VIN,
                startAt: new Date('2026-03-10T06:00:00Z'),
                prediction: {
                  ...NO_PREDICTION,
                  minSocPercent: 80,
                  minReachedAt: new Date('2026-03-10T08:41:00Z'),
                  finalSocPercent: 95,
                  finalReachedAt: new Date('2026-03-10T09:05:00Z'),
                },
              },
            ],
          }),
          idlePoint(2, 2_310_000),
        ]),
        payload: depotPayload([
          {
            chargingPointId: 'VDV-CS-01/1',
            chargingPointStatus: 'Available',
            presentPower: 0,
            energyMeterReading: 1_204_000,
            scheduledChargingProcessList: [
              {
                presystemId: PRESYSTEM,
                chargingRequestId: REQUEST_ID,
                chargingProcessId: DEPARTURE_ID,
                vehicleId: VIN,
                startTime: '2026-03-10T06:00:00Z',
                chargingPredictionData: {
                  chargingPredictionDataMinSoc: {
                    requestedMinSoc: 80,
                    predictedTime: '2026-03-10T08:41:00Z',
                  },
                  chargingPredictionDataFinalSoc: {
                    predictedFinalSoc: 95,
                    predictedTime: '2026-03-10T09:05:00Z',
                  },
                },
              },
            ],
          },
          IDLE_2,
        ]),
      },
    ],
  },
  {
    follows: 'VDV 463 6.2.3',
    title: 'arrival: the bus plugs in, the process is preparing, the vehicle is not identified yet',
    steps: [
      {
        kind: 'out',
        now: '2026-03-10T06:01:20Z',
        snapshot: depot([
          idlePoint(1, 1_204_000, {
            connectorStatuses: ['Occupied'],
            process: process({ vehicle: null }),
          }),
          idlePoint(2, 2_310_000),
        ]),
        payload: depotPayload([
          {
            chargingPointId: 'VDV-CS-01/1',
            chargingPointStatus: 'Occupied',
            presentPower: 0,
            energyMeterReading: 1_204_000,
            chargingProcessInfo: {
              presystemId: PRESYSTEM,
              chargingRequestId: REQUEST_ID,
              chargingProcessId: DEPARTURE_ID,
              processStatus: 'Preparing',
              startTime: '2026-03-10T06:01:12Z',
              chargingPredictionData: PREDICTION_PAYLOAD,
              electricData: { chargingPower: 0 },
              deliveredEnergy: 0,
            },
          },
          IDLE_2,
        ]),
      },
    ],
  },
  {
    follows: 'VDV 463 6.2.4',
    title: 'start: the vehicle is identified and ready to charge',
    steps: [
      {
        kind: 'out',
        now: '2026-03-10T06:03:20Z',
        snapshot: depot([
          idlePoint(1, 1_204_000, {
            connectorStatuses: ['Occupied'],
            process: process({
              vehicle: {
                vin: VIN,
                evccId: '0A1B2C3D4E5F',
                socPercent: null,
                preconditioningStatus: null,
                hvacPreconditioningActive: false,
              },
            }),
          }),
          idlePoint(2, 2_310_000),
        ]),
        payload: depotPayload([
          {
            chargingPointId: 'VDV-CS-01/1',
            chargingPointStatus: 'Occupied',
            presentPower: 0,
            energyMeterReading: 1_204_000,
            vehicleInfo: {
              vehicleId: VIN,
              evccId: '0A1B2C3D4E5F',
              vehicleStatusInfo: {},
              vehicleChargingStatus: 'ReadyToCharge',
              preconditioningInfo: {},
            },
            chargingProcessInfo: {
              presystemId: PRESYSTEM,
              chargingRequestId: REQUEST_ID,
              chargingProcessId: DEPARTURE_ID,
              processStatus: 'Preparing',
              startTime: '2026-03-10T06:01:12Z',
              chargingPredictionData: PREDICTION_PAYLOAD,
              electricData: { chargingPower: 0 },
              deliveredEnergy: 0,
            },
          },
          IDLE_2,
        ]),
      },
    ],
  },
  {
    follows: 'VDV 463 6.2.5',
    title: 'charging: power, voltage, current, state of charge and the delivered energy',
    steps: [
      {
        kind: 'out',
        now: '2026-03-10T07:03:20Z',
        snapshot: depot([
          idlePoint(1, 1_310_400, {
            connectorStatuses: ['Occupied'],
            allowedKw: 110,
            powerKw: 108.6,
            process: process({
              state: 'Charging',
              deliveredWh: 106_400,
              powerKw: 108.6,
              currentA: 146.2,
              voltageV: 742.8,
              vehicle: {
                vin: VIN,
                evccId: '0A1B2C3D4E5F',
                socPercent: 56,
                preconditioningStatus: 'NotReady',
                hvacPreconditioningActive: false,
              },
            }),
          }),
          idlePoint(2, 2_310_000),
        ]),
        payload: depotPayload([
          {
            _power: 108.6,
            chargingPointId: 'VDV-CS-01/1',
            chargingPointStatus: 'Occupied',
            presentPower: 110,
            energyMeterReading: 1_310_400,
            vehicleInfo: {
              vehicleId: VIN,
              evccId: '0A1B2C3D4E5F',
              tractionBatteryInfo: { stateOfCharge: 56 },
              vehicleStatusInfo: { systemPreconditioningActive: false },
              vehicleChargingStatus: 'Charging',
              preconditioningInfo: {},
            },
            chargingProcessInfo: {
              presystemId: PRESYSTEM,
              chargingRequestId: REQUEST_ID,
              chargingProcessId: DEPARTURE_ID,
              processStatus: 'Charging',
              startTime: '2026-03-10T06:01:12Z',
              chargingPredictionData: PREDICTION_PAYLOAD,
              electricData: {
                chargingCurrent: 146.2,
                chargingVoltage: 742.8,
                chargingPower: 108.6,
              },
              deliveredEnergy: 106_400,
            },
          },
          IDLE_2,
        ]),
      },
    ],
  },
  {
    follows: 'VDV 463 6.2.6',
    title:
      'changed request: the departure moves 30 minutes later, the request names the running process',
    steps: [
      {
        kind: 'in',
        frame: frame(
          1,
          '2026-03-10T07:04:00Z',
          '2d9f3b0a-4c5e-4071-9c3d-4e5f6a7b8c9d',
          'ProvideChargingRequests',
          {
            chargingRequestList: [
              {
                ...REQUEST,
                chargingProcessId: ` ${DEPARTURE_ID}`,
                chargingInstruction: 'Changed',
                chargingRequestData: {
                  ...REQUEST.chargingRequestData,
                  requestedTimeForDeparture: '2026-03-10T09:45:00Z',
                },
              },
            ],
          },
        ),
        expected: [
          {
            ...CHECKED,
            chargingProcessRef: DEPARTURE_ID,
            departureAt: new Date('2026-03-10T09:45:00Z'),
          },
        ],
      },
    ],
  },
  {
    follows: 'VDV 463 6.2.7',
    title: 'end of charging: the target is reached, the process is finishing',
    steps: [
      {
        kind: 'out',
        now: '2026-03-10T09:30:00Z',
        snapshot: depot([
          idlePoint(1, 1_467_500, {
            connectorStatuses: ['Occupied'],
            process: process({
              state: 'Finishing',
              deliveredWh: 263_500,
              vehicle: {
                vin: VIN,
                evccId: '0A1B2C3D4E5F',
                socPercent: 95,
                preconditioningStatus: null,
                hvacPreconditioningActive: false,
              },
              prediction: {
                minSocPercent: 80,
                minReachedAt: new Date('2026-03-10T08:52:00Z'),
                finalSocPercent: 95,
                finalReachedAt: new Date('2026-03-10T09:28:00Z'),
                departureAt: new Date('2026-03-10T09:45:00Z'),
                socAtDeparture: 95,
              },
            }),
          }),
          idlePoint(2, 2_310_000),
        ]),
        payload: depotPayload([
          {
            chargingPointId: 'VDV-CS-01/1',
            chargingPointStatus: 'Occupied',
            presentPower: 0,
            energyMeterReading: 1_467_500,
            vehicleInfo: {
              vehicleId: VIN,
              evccId: '0A1B2C3D4E5F',
              tractionBatteryInfo: { stateOfCharge: 95 },
              vehicleStatusInfo: {},
              vehicleChargingStatus: 'ReadyToCharge',
              preconditioningInfo: {},
            },
            chargingProcessInfo: {
              presystemId: PRESYSTEM,
              chargingRequestId: REQUEST_ID,
              chargingProcessId: DEPARTURE_ID,
              processStatus: 'Finishing',
              startTime: '2026-03-10T06:01:12Z',
              chargingPredictionData: {
                chargingPredictionDataMinSoc: {
                  requestedMinSoc: 80,
                  predictedTime: '2026-03-10T08:52:00Z',
                },
                chargingPredictionDataFinalSoc: {
                  predictedFinalSoc: 95,
                  predictedTime: '2026-03-10T09:28:00Z',
                },
                chargingPredictionDataDepartureTime: {
                  predictedDepartureTimeSoc: 95,
                  predictedTime: '2026-03-10T09:45:00Z',
                },
              },
              electricData: { chargingPower: 0 },
              deliveredEnergy: 263_500,
            },
          },
          IDLE_2,
        ]),
      },
    ],
  },
  {
    follows: 'VDV 463 6.2.8',
    title: 'departure: the bus unplugs and leaves, the point is available again',
    steps: [
      {
        kind: 'out',
        now: '2026-03-10T09:46:00Z',
        snapshot: depot([idlePoint(1, 1_467_500), idlePoint(2, 2_310_000)]),
        payload: depotPayload([
          {
            chargingPointId: 'VDV-CS-01/1',
            chargingPointStatus: 'Available',
            presentPower: 0,
            energyMeterReading: 1_467_500,
          },
          IDLE_2,
        ]),
      },
    ],
  },
  {
    follows: 'VDV 463 6.2.9',
    title: 'offline and reconnect: the depot system boots again, nothing is replayed',
    steps: [
      {
        kind: 'in',
        frame: frame(
          1,
          '2026-03-10T10:12:00Z',
          '3e0a4c1b-5d6f-4182-8d4e-5f6a7b8c9d0e',
          'BootNotification',
          { presystem: 'BMS' },
        ),
      },
      {
        kind: 'out',
        now: '2026-03-10T10:12:01Z',
        snapshot: depot([idlePoint(1, 1_467_500), idlePoint(2, 2_310_000)]),
        payload: depotPayload([
          {
            chargingPointId: 'VDV-CS-01/1',
            chargingPointStatus: 'Available',
            presentPower: 0,
            energyMeterReading: 1_467_500,
          },
          IDLE_2,
        ]),
      },
    ],
  },
];

/** The payload without the test-only `_power` marks. */
export function cleanPayload(payload: unknown): unknown {
  return JSON.parse(
    JSON.stringify(payload, (key, value: unknown) => (key === '_power' ? undefined : value)),
  );
}
