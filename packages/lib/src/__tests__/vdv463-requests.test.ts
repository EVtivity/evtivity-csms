// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  VDV463_CHARGING_INSTRUCTIONS,
  VDV463_CHARGING_POINT_FAULT_CODES,
  VDV463_CHARGING_POINT_STATUSES,
  VDV463_CHARGING_STATION_FAULT_CODES,
  VDV463_CHARGING_STATION_STATUSES,
  VDV463_PRECONDITIONING_REQUESTS,
  VDV463_PROCESS_STATUSES,
  VDV463_VEHICLE_CHARGING_STATUSES,
  bootNotificationRequestSchema,
  chargingPointId,
  checkChargingRequest,
  climateOfRequest,
  parseChargingPointId,
  priorityFromVdv,
  provideChargingInformationRequestSchema,
  provideChargingRequestsRequestSchema,
  type Vdv463ChargingRequest,
} from '../vdv463/index.js';

const NOW = new Date('2026-03-10T05:00:00Z');

function request(over: Partial<Vdv463ChargingRequest> = {}): Vdv463ChargingRequest {
  return {
    chargingPointId: 'VDV-CS-01/1',
    vehicleId: 'EVTVDVTEST0000001',
    chargingRequestId: 'north/req-1',
    priority: 2,
    chargingRequestData: {
      expectedArrivalTimeAtChargingPoint: '2026-03-10T06:00:00Z',
      expectedSocAtArrival: 31,
      minTargetSoc: 80,
      maxTargetSoc: 95,
      requestedTimeForDeparture: '2026-03-10T09:15:00Z',
    },
    ...over,
  };
}

describe('VDV 463 payload schemas', () => {
  it('reads the boot notification field of the schema, not the 1.0 text name', () => {
    expect(bootNotificationRequestSchema.safeParse({ presystem: 'ITCS' }).success).toBe(true);
    expect(bootNotificationRequestSchema.safeParse({ systemType: 'BMS' }).success).toBe(false);
    expect(bootNotificationRequestSchema.safeParse({ presystem: 'DMS' }).success).toBe(false);
  });

  it('accepts an empty request list and an empty depot list', () => {
    expect(
      provideChargingRequestsRequestSchema.safeParse({ chargingRequestList: [] }).success,
    ).toBe(true);
    expect(provideChargingInformationRequestSchema.safeParse({ depotInfoList: [] }).success).toBe(
      true,
    );
  });

  it.each(['vehicleId', 'chargingRequestId', 'chargingRequestData'])(
    'refuses a request without %s',
    (field) => {
      const r = Object.fromEntries(Object.entries(request()).filter(([key]) => key !== field));
      expect(
        provideChargingRequestsRequestSchema.safeParse({ chargingRequestList: [r] }).success,
      ).toBe(false);
    },
  );

  it.each(['minTargetSoc', 'maxTargetSoc'])('refuses request data without %s', (field) => {
    const data = Object.fromEntries(
      Object.entries(request().chargingRequestData).filter(([key]) => key !== field),
    );
    const r = { ...request(), chargingRequestData: data };
    expect(
      provideChargingRequestsRequestSchema.safeParse({ chargingRequestList: [r] }).success,
    ).toBe(false);
  });

  it('refuses an extra property at any level', () => {
    expect(
      provideChargingRequestsRequestSchema.safeParse({ chargingRequestList: [], extra: 1 }).success,
    ).toBe(false);
    expect(
      provideChargingRequestsRequestSchema.safeParse({
        chargingRequestList: [{ ...request(), color: 'red' }],
      }).success,
    ).toBe(false);
  });

  it('needs both start times of manual preconditioning, and integer powers', () => {
    const manual = {
      hvacPreconditioningStartTime: '2026-03-10T08:30:00Z',
      systemPreconditioningStartTime: '2026-03-10T08:45:00Z',
      hvacAuxiliaryConsumerPower: 18,
    };
    const ok = provideChargingRequestsRequestSchema.safeParse({
      chargingRequestList: [{ ...request(), manualPreconditioning: manual }],
    });
    expect(ok.success).toBe(true);
    const missing = { ...manual } as Record<string, unknown>;
    delete missing['systemPreconditioningStartTime'];
    expect(
      provideChargingRequestsRequestSchema.safeParse({
        chargingRequestList: [{ ...request(), manualPreconditioning: missing }],
      }).success,
    ).toBe(false);
    expect(
      provideChargingRequestsRequestSchema.safeParse({
        chargingRequestList: [
          { ...request(), manualPreconditioning: { ...manual, hvacAuxiliaryConsumerPower: 2.5 } },
        ],
      }).success,
    ).toBe(false);
  });

  it('needs the preconditioning type of automatic preconditioning', () => {
    expect(
      provideChargingRequestsRequestSchema.safeParse({
        chargingRequestList: [
          { ...request(), automaticPreconditioning: { ambientTemperature: 4 } },
        ],
      }).success,
    ).toBe(false);
  });

  it('knows every value of every enum of 1.1.0', () => {
    expect(VDV463_CHARGING_INSTRUCTIONS).toEqual(['Normal', 'Changed', 'Terminate']);
    expect(VDV463_PRECONDITIONING_REQUESTS).toHaveLength(4);
    expect(VDV463_CHARGING_POINT_STATUSES).toEqual([
      'Available',
      'Occupied',
      'Reserved',
      'Unavailable',
      'Faulted',
    ]);
    expect(VDV463_CHARGING_STATION_STATUSES).toEqual(['Available', 'Unavailable', 'Faulted']);
    expect(VDV463_CHARGING_POINT_FAULT_CODES).toHaveLength(4);
    expect(VDV463_CHARGING_STATION_FAULT_CODES).toHaveLength(6);
    expect(VDV463_PROCESS_STATUSES).toHaveLength(7);
    expect(VDV463_VEHICLE_CHARGING_STATUSES).toEqual([
      'ReadyToCharge',
      'Charging',
      'ChargingImpossible',
      'Unknown',
    ]);
  });

  it('refuses a misspelled enum value', () => {
    expect(
      provideChargingRequestsRequestSchema.safeParse({
        chargingRequestList: [{ ...request(), chargingInstruction: 'terminate' }],
      }).success,
    ).toBe(false);
  });
});

describe('priorityFromVdv', () => {
  it.each([
    [1, 10],
    [2, 9],
    [10, 1],
    [50, 1],
    [0, 10],
    [-3, 10],
    [undefined, 5],
  ])('maps VDV %s to %s', (vdv, ours) => {
    expect(priorityFromVdv(vdv)).toBe(ours);
  });
});

describe('checkChargingRequest', () => {
  it('turns a timed request into departure fields', () => {
    const r = checkChargingRequest(request(), NOW);
    expect(r).toEqual({
      ok: true,
      request: {
        externalRequestId: 'north/req-1',
        vehicleRef: 'EVTVDVTEST0000001',
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
      },
    });
  });

  it('rounds the minimum up and the maximum down', () => {
    const r = checkChargingRequest(
      request({
        chargingRequestData: {
          ...request().chargingRequestData,
          minTargetSoc: 80.2,
          maxTargetSoc: 94.8,
        },
      }),
      NOW,
    );
    expect(r.ok && r.request.minSocPercent).toBe(81);
    expect(r.ok && r.request.maxSocPercent).toBe(94);
  });

  it('reads an ad hoc request without a departure time', () => {
    const data = { minTargetSoc: 50, maxTargetSoc: 60, adHocCharging: true };
    const r = checkChargingRequest(request({ chargingRequestData: data }), NOW);
    expect(r.ok && r.request.adHoc).toBe(true);
    expect(r.ok && r.request.departureAt).toBeNull();
  });

  it('trims a charging process id', () => {
    const r = checkChargingRequest(request({ chargingProcessId: ' sess_1 ' }), NOW);
    expect(r.ok && r.request.chargingProcessRef).toBe('sess_1');
  });

  it('refuses an identifier longer than 255 characters, and takes 255', () => {
    const long = 'x'.repeat(256);
    for (const over of [
      { chargingRequestId: long },
      { vehicleId: long },
      { chargingPointId: long },
      { chargingProcessId: long },
    ]) {
      expect(checkChargingRequest(request(over), NOW)).toEqual({
        ok: false,
        reason: 'identifier_too_long',
      });
    }
    expect(checkChargingRequest(request({ chargingRequestId: 'x'.repeat(255) }), NOW).ok).toBe(
      true,
    );
  });

  it('reads Terminate', () => {
    const r = checkChargingRequest(request({ chargingInstruction: 'Terminate' }), NOW);
    expect(r.ok && r.request.terminate).toBe(true);
  });

  it.each([
    ['a minimum above 100', { minTargetSoc: 120 }, 'soc_out_of_range'],
    ['a negative maximum', { maxTargetSoc: -1 }, 'soc_out_of_range'],
    ['an arrival SoC above 100', { expectedSocAtArrival: 101 }, 'soc_out_of_range'],
    ['a minimum above the maximum', { minTargetSoc: 96 }, 'min_above_max'],
    [
      'no departure time and no ad hoc',
      { requestedTimeForDeparture: undefined },
      'no_departure_time',
    ],
    [
      'a departure an hour ago',
      { requestedTimeForDeparture: '2026-03-10T04:00:00Z' },
      'departure_in_past',
    ],
    [
      'a departure eight days ahead',
      { requestedTimeForDeparture: '2026-03-18T05:00:00Z' },
      'departure_too_far',
    ],
    [
      'an arrival after the departure',
      { expectedArrivalTimeAtChargingPoint: '2026-03-10T10:00:00Z' },
      'arrival_after_departure',
    ],
  ])('refuses %s', (_name, change, reason) => {
    const data = { ...request().chargingRequestData, ...change };
    if ('requestedTimeForDeparture' in change && change.requestedTimeForDeparture === undefined) {
      delete data.requestedTimeForDeparture;
    }
    expect(checkChargingRequest(request({ chargingRequestData: data }), NOW)).toEqual({
      ok: false,
      reason,
    });
  });

  it('accepts a departure two minutes ago as clock skew', () => {
    const r = checkChargingRequest(
      request({
        chargingRequestData: {
          ...request().chargingRequestData,
          requestedTimeForDeparture: '2026-03-10T04:58:00Z',
          expectedArrivalTimeAtChargingPoint: '2026-03-10T04:00:00Z',
        },
      }),
      NOW,
    );
    expect(r.ok).toBe(true);
  });

  it('reads automatic preconditioning and clips its finish to the departure', () => {
    const r = checkChargingRequest(
      request({
        automaticPreconditioning: {
          preconditioningRequest: 'HotWaterAndHeating',
          ambientTemperature: -3.6,
          requestedStartTime: '2026-03-10T08:40:00Z',
          requestedFinishTime: '2026-03-10T09:30:00Z',
        },
      }),
      NOW,
    );
    expect(r.ok && r.request.preconditioning).toEqual({
      climate: 'hot_water_heating',
      ambientTemperatureC: -4,
      startAt: new Date('2026-03-10T08:40:00Z'),
      finishAt: new Date('2026-03-10T09:15:00Z'),
      hvacStartAt: null,
      hvacKw: null,
      systemStartAt: null,
      systemKw: null,
    });
  });

  it('defaults the automatic finish to the departure', () => {
    const r = checkChargingRequest(
      request({ automaticPreconditioning: { preconditioningRequest: 'WarmWaterAndVentilation' } }),
      NOW,
    );
    expect(r.ok && r.request.preconditioning?.finishAt).toEqual(new Date('2026-03-10T09:15:00Z'));
  });

  it('reads manual preconditioning', () => {
    const r = checkChargingRequest(
      request({
        manualPreconditioning: {
          hvacPreconditioningStartTime: '2026-03-10T08:30:00Z',
          hvacAuxiliaryConsumerPower: 18,
          systemPreconditioningStartTime: '2026-03-10T08:50:00Z',
          systemAuxiliaryConsumerPower: 6,
        },
      }),
      NOW,
    );
    expect(r.ok && r.request.preconditioning).toMatchObject({
      climate: null,
      hvacKw: 18,
      systemKw: 6,
      hvacStartAt: new Date('2026-03-10T08:30:00Z'),
    });
  });

  it.each([
    [
      'a start after the finish',
      {
        automaticPreconditioning: {
          preconditioningRequest: 'HotWaterAndHeating' as const,
          requestedStartTime: '2026-03-10T09:10:00Z',
          requestedFinishTime: '2026-03-10T09:00:00Z',
        },
      },
    ],
    [
      'a manual start at the departure',
      {
        manualPreconditioning: {
          hvacPreconditioningStartTime: '2026-03-10T09:15:00Z',
          systemPreconditioningStartTime: '2026-03-10T08:00:00Z',
        },
      },
    ],
    [
      'a manual power above 500 kW',
      {
        manualPreconditioning: {
          hvacPreconditioningStartTime: '2026-03-10T08:00:00Z',
          systemPreconditioningStartTime: '2026-03-10T08:00:00Z',
          systemAuxiliaryConsumerPower: 900,
        },
      },
    ],
    [
      'manual preconditioning on an ad hoc request',
      {
        chargingRequestData: { minTargetSoc: 50, maxTargetSoc: 60, adHocCharging: true },
        manualPreconditioning: {
          hvacPreconditioningStartTime: '2026-03-10T08:00:00Z',
          systemPreconditioningStartTime: '2026-03-10T08:00:00Z',
        },
      },
    ],
  ])('refuses %s as an invalid preconditioning window', (_name, change) => {
    expect(checkChargingRequest(request(change), NOW)).toEqual({
      ok: false,
      reason: 'precondition_window_invalid',
    });
  });

  it('maps every preconditioning request to our climate names', () => {
    expect(VDV463_PRECONDITIONING_REQUESTS.map(climateOfRequest)).toEqual([
      'warm_water_ventilation',
      'hot_water_heating',
      'no_heating_cooling_ventilation',
      'none',
    ]);
  });
});

describe('charging point ids', () => {
  it('joins and splits at the last slash', () => {
    expect(chargingPointId('DEPOT/CS-1', 2)).toBe('DEPOT/CS-1/2');
    expect(parseChargingPointId('DEPOT/CS-1/2')).toEqual({
      stationOcppId: 'DEPOT/CS-1',
      evseId: 2,
    });
  });

  it.each(['CS-1', 'CS-1/', '/2', 'CS-1/0', 'CS-1/x', 'CS-1/12345'])(
    'reads %s as not ours',
    (value) => {
      expect(parseChargingPointId(value)).toBeNull();
    },
  );
});
