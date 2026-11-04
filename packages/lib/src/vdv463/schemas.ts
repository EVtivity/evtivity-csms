// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Payload schemas of VDV 463 1.1.0, written from the published data model:
// required fields, enum values and the no-extra-properties rule of each type.
// The interface says the schema wins over the text where they differ.

import { z } from 'zod';
import {
  VDV463_CHARGING_INSTRUCTIONS,
  VDV463_CHARGING_POINT_FAULT_CODES,
  VDV463_CHARGING_POINT_STATUSES,
  VDV463_CHARGING_STATION_FAULT_CODES,
  VDV463_CHARGING_STATION_STATUSES,
  VDV463_PRECONDITIONING_REQUESTS,
  VDV463_PRESYSTEM_TYPES,
  VDV463_PROCESS_STATUSES,
  VDV463_VEHICLE_CHARGING_STATUSES,
} from './constants.js';

const dateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i)
  .refine((v) => !Number.isNaN(Date.parse(v)), 'invalid date-time');

const identifier = z.string();

export const bootNotificationRequestSchema = z
  .object({ presystem: z.enum(VDV463_PRESYSTEM_TYPES) })
  .strict();
export type BootNotificationRequest = z.infer<typeof bootNotificationRequestSchema>;

export const bootNotificationResponseSchema = z
  .object({ status: z.enum(['Accepted', 'Rejected']) })
  .strict();
export type BootNotificationResponse = z.infer<typeof bootNotificationResponseSchema>;

export const emptyPayloadSchema = z.object({}).strict();

export const chargingRequestDataSchema = z
  .object({
    expectedArrivalTimeAtChargingPoint: dateTime.optional(),
    expectedSocAtArrival: z.number().optional(),
    minTargetSoc: z.number(),
    maxTargetSoc: z.number(),
    requestedTimeForDeparture: dateTime.optional(),
    adHocCharging: z.boolean().optional(),
  })
  .strict();

export const automaticPreconditioningSchema = z
  .object({
    preconditioningRequest: z.enum(VDV463_PRECONDITIONING_REQUESTS),
    ambientTemperature: z.number().optional(),
    requestedStartTime: dateTime.optional(),
    requestedFinishTime: dateTime.optional(),
  })
  .strict();

export const manualPreconditioningSchema = z
  .object({
    hvacPreconditioningStartTime: dateTime,
    hvacAuxiliaryConsumerPower: z.number().int().optional(),
    systemPreconditioningStartTime: dateTime,
    systemAuxiliaryConsumerPower: z.number().int().optional(),
  })
  .strict();

export const chargingRequestSchema = z
  .object({
    chargingPointId: identifier.optional(),
    vehicleId: identifier,
    chargingRequestId: identifier,
    chargingProcessId: identifier.optional(),
    priority: z.number().int().optional(),
    chargingInstruction: z.enum(VDV463_CHARGING_INSTRUCTIONS).optional(),
    chargingRequestData: chargingRequestDataSchema,
    automaticPreconditioning: automaticPreconditioningSchema.optional(),
    manualPreconditioning: manualPreconditioningSchema.optional(),
  })
  .strict();
export type Vdv463ChargingRequest = z.infer<typeof chargingRequestSchema>;

export const provideChargingRequestsRequestSchema = z
  .object({ chargingRequestList: z.array(chargingRequestSchema) })
  .strict();
export type ProvideChargingRequestsRequest = z.infer<typeof provideChargingRequestsRequestSchema>;

// --- ProvideChargingInformation ---

const faultInfo = <T extends readonly [string, ...string[]]>(codes: T, key: string) =>
  z
    .object({
      [key]: z.enum(codes),
      faultText: z.string().optional(),
      faultTimeStamp: dateTime,
    })
    .strict();

export const chargingPointFaultInfoSchema = faultInfo(
  VDV463_CHARGING_POINT_FAULT_CODES,
  'chargingPointFaultCode',
);
export const chargingStationFaultInfoSchema = faultInfo(
  VDV463_CHARGING_STATION_FAULT_CODES,
  'chargingStationFaultCode',
);

export const tractionBatteryInfoSchema = z
  .object({
    stateOfHealth: z.number().optional(),
    stateOfCharge: z.number().optional(),
    temperature: z.number().int().optional(),
  })
  .strict();

export const vehicleStatusInfoSchema = z
  .object({
    conservationChargingActive: z.boolean().optional(),
    systemPreconditioningActive: z.boolean().optional(),
    hvacPreconditioningActive: z.boolean().optional(),
    balancingActive: z.boolean().optional(),
    fossilFlameControlActive: z.boolean().optional(),
    batteryChargingVoltage: z.number().optional(),
  })
  .strict();

export const vehicleFaultInfoSchema = z
  .object({
    vehicleFaultCode: z.string(),
    faultText: z.string().optional(),
    faultTimeStamp: dateTime,
  })
  .strict();

export const preconditioningInfoSchema = z
  .object({
    hvBatteryPreconditioningTime: z.number().int().optional(),
    hvBatteryChargingEnergy: z.number().int().optional(),
    vehiclePreconditioningTime: z.number().int().optional(),
    vehiclePreconditioningEnergy: z.number().int().optional(),
  })
  .strict();

export const vehicleInfoSchema = z
  .object({
    vehicleId: identifier,
    evccId: identifier.optional(),
    mileage: z.number().int().optional(),
    tractionBatteryInfo: tractionBatteryInfoSchema.optional(),
    vehicleStatusInfo: vehicleStatusInfoSchema,
    vehicleChargingStatus: z.enum(VDV463_VEHICLE_CHARGING_STATUSES),
    vehicleFaultInfo: vehicleFaultInfoSchema.optional(),
    preconditioningInfo: preconditioningInfoSchema,
  })
  .strict();

export const electricDataSchema = z
  .object({
    chargingCurrent: z.number().optional(),
    chargingVoltage: z.number().optional(),
    chargingPower: z.number(),
    reactivePower: z.number().optional(),
  })
  .strict();

export const chargingPredictionDataSchema = z
  .object({
    chargingPredictionDataMinSoc: z
      .object({ requestedMinSoc: z.number(), predictedTime: dateTime })
      .strict()
      .optional(),
    chargingPredictionDataFinalSoc: z
      .object({ predictedFinalSoc: z.number(), predictedTime: dateTime })
      .strict()
      .optional(),
    chargingPredictionDataDepartureTime: z
      .object({ predictedDepartureTimeSoc: z.number(), predictedTime: dateTime })
      .strict()
      .optional(),
  })
  .strict();
export type Vdv463ChargingPredictionData = z.infer<typeof chargingPredictionDataSchema>;

export const chargingProcessInfoSchema = z
  .object({
    presystemId: identifier.optional(),
    chargingRequestId: identifier.optional(),
    chargingProcessId: identifier,
    processStatus: z.enum(VDV463_PROCESS_STATUSES),
    startTime: dateTime,
    chargingPredictionData: chargingPredictionDataSchema,
    electricData: electricDataSchema,
    deliveredEnergy: z.number().optional(),
  })
  .strict();

export const scheduledChargingProcessSchema = z
  .object({
    presystemId: identifier.optional(),
    chargingRequestId: identifier,
    chargingProcessId: identifier.optional(),
    vehicleId: identifier,
    startTime: dateTime.optional(),
    chargingPredictionData: chargingPredictionDataSchema,
  })
  .strict();

export const chargingPointInfoSchema = z
  .object({
    chargingPointId: identifier,
    chargingPointStatus: z.enum(VDV463_CHARGING_POINT_STATUSES),
    insideTemperature: z.number().optional(),
    outsideTemperature: z.number().optional(),
    connectorTemperature: z.number().optional(),
    presentPower: z.number().optional(),
    energyMeterReading: z.number().optional(),
    chargingPointFaultInfo: chargingPointFaultInfoSchema.optional(),
    vehicleInfo: vehicleInfoSchema.optional(),
    chargingProcessInfo: chargingProcessInfoSchema.optional(),
    scheduledChargingProcessList: z.array(scheduledChargingProcessSchema).optional(),
  })
  .strict();

export const chargingStationInfoSchema = z
  .object({
    chargingStationId: identifier,
    chargingStationStatus: z.enum(VDV463_CHARGING_STATION_STATUSES),
    chargingPointInfoList: z.array(chargingPointInfoSchema),
    chargingStationFaultInfo: chargingStationFaultInfoSchema.optional(),
    totalPower: z.number().optional(),
  })
  .strict();

export const depotInfoSchema = z
  .object({
    depotId: identifier,
    name: z.string().optional(),
    chargingStationInfoList: z.array(chargingStationInfoSchema),
  })
  .strict();

export const provideChargingInformationRequestSchema = z
  .object({ depotInfoList: z.array(depotInfoSchema) })
  .strict();
export type ProvideChargingInformationRequest = z.infer<
  typeof provideChargingInformationRequestSchema
>;
export type Vdv463DepotInfo = z.infer<typeof depotInfoSchema>;
export type Vdv463ChargingStationInfo = z.infer<typeof chargingStationInfoSchema>;
export type Vdv463ChargingPointInfo = z.infer<typeof chargingPointInfoSchema>;
export type Vdv463ChargingProcessInfo = z.infer<typeof chargingProcessInfoSchema>;
export type Vdv463ScheduledChargingProcess = z.infer<typeof scheduledChargingProcessSchema>;
export type Vdv463VehicleInfo = z.infer<typeof vehicleInfoSchema>;

/** The payload schema of a request frame by action. */
export const VDV463_REQUEST_SCHEMAS = {
  BootNotification: bootNotificationRequestSchema,
  ProvideChargingRequests: provideChargingRequestsRequestSchema,
  ProvideChargingInformation: provideChargingInformationRequestSchema,
} as const;

/** The payload schema of a confirmation frame by action. */
export const VDV463_CONFIRMATION_SCHEMAS = {
  BootNotification: bootNotificationResponseSchema,
  ProvideChargingRequests: emptyPayloadSchema,
  ProvideChargingInformation: emptyPayloadSchema,
} as const;

/** The first problem of a payload, short enough for an error frame. */
export function vdv463PayloadProblem(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue == null) return 'Invalid payload';
  const path = issue.path.map(String).join('.');
  return `Invalid payload${path !== '' ? ` at ${path}` : ''}: ${issue.message}`.slice(0, 300);
}
