// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// VDV 463 1.1.0, the interface between a depot management system or an ITCS
// (the "presystem") and EVtivity as the charging management system. Our own
// names for the protocol values (features/vdv-463.md).

/** WebSocket subprotocol of the 1.x interface (VDV 463, section 3.1.2). */
export const VDV463_SUBPROTOCOL_V1 = 'v1.463.vdv.de';

/** The subprotocols this server speaks, highest first. */
export const VDV463_SUBPROTOCOLS = [VDV463_SUBPROTOCOL_V1] as const;

/** The path the depot systems connect to. */
export const VDV463_PATH = '/vdv463';

/** Message types of the frame (section 4.1). */
export const VDV463_REQUEST = 1;
export const VDV463_CONFIRMATION = 2;
export const VDV463_ERROR = 3;
export type Vdv463MessageType = 1 | 2 | 3;

export const VDV463_ACTIONS = [
  'BootNotification',
  'ProvideChargingRequests',
  'ProvideChargingInformation',
] as const;
export type Vdv463Action = (typeof VDV463_ACTIONS)[number];

/** The Source item EVtivity writes, as the role it plays. */
export const VDV463_CMS_SOURCE = 'CMS';

export const VDV463_PRESYSTEM_TYPES = ['BMS', 'ITCS'] as const;
export type Vdv463PresystemType = (typeof VDV463_PRESYSTEM_TYPES)[number];

export const VDV463_CHARGING_INSTRUCTIONS = ['Normal', 'Changed', 'Terminate'] as const;

export const VDV463_PRECONDITIONING_REQUESTS = [
  'WarmWaterAndVentilation',
  'HotWaterAndHeating',
  'NoWaterCoolingOrVentilation',
  'NoClimaticPreconditioningOrSNA',
] as const;
export type Vdv463PreconditioningRequest = (typeof VDV463_PRECONDITIONING_REQUESTS)[number];

export const VDV463_CHARGING_POINT_STATUSES = [
  'Available',
  'Occupied',
  'Reserved',
  'Unavailable',
  'Faulted',
] as const;
export type Vdv463ChargingPointStatus = (typeof VDV463_CHARGING_POINT_STATUSES)[number];

export const VDV463_CHARGING_STATION_STATUSES = ['Available', 'Unavailable', 'Faulted'] as const;
export type Vdv463ChargingStationStatus = (typeof VDV463_CHARGING_STATION_STATUSES)[number];

export const VDV463_CHARGING_POINT_FAULT_CODES = [
  'NoFaultKnown',
  'UsageFailure',
  'CommunicationFailure',
  'OtherChargingPointFailure',
] as const;
export type Vdv463ChargingPointFaultCode = (typeof VDV463_CHARGING_POINT_FAULT_CODES)[number];

export const VDV463_CHARGING_STATION_FAULT_CODES = [
  'NoFaultKnown',
  'UsageFailure',
  'CommunicationFailure',
  'ElectricalOperationFailure',
  'ConfigurationFailure',
  'OtherChargingStationFailure',
] as const;
export type Vdv463ChargingStationFaultCode = (typeof VDV463_CHARGING_STATION_FAULT_CODES)[number];

export const VDV463_PROCESS_STATUSES = [
  'Preparing',
  'Charging',
  'SuspendedEVSE',
  'SuspendedEV',
  'Finishing',
  'Queued',
  'ChargingRejectedTechnically',
] as const;
export type Vdv463ProcessStatus = (typeof VDV463_PROCESS_STATUSES)[number];

export const VDV463_VEHICLE_CHARGING_STATUSES = [
  'ReadyToCharge',
  'Charging',
  'ChargingImpossible',
  'Unknown',
] as const;
export type Vdv463VehicleChargingStatus = (typeof VDV463_VEHICLE_CHARGING_STATUSES)[number];

/** Close codes the server uses. */
export const VDV463_CLOSE_NO_PROTOCOL = 1002;
export const VDV463_CLOSE_TOO_BIG = 1009;
export const VDV463_CLOSE_REPLACED = 4000;
export const VDV463_CLOSE_REJECTED = 4001;
export const VDV463_CLOSE_SILENT = 4002;
export const VDV463_CLOSE_NOT_CONFIRMED = 4003;
export const VDV463_CLOSE_RATE = 4004;
export const VDV463_CLOSE_DISABLED = 4005;

/** Limits of one connection. */
export const VDV463_MAX_FRAME_BYTES = 1024 * 1024;
export const VDV463_MAX_MESSAGES_PER_MINUTE = 60;
export const VDV463_MAX_CHARGING_REQUESTS = 2000;
export const VDV463_PING_INTERVAL_MS = 30_000;

/** Depot system settings ranges (depot_systems columns). */
export const VDV463_INFO_INTERVAL_SECONDS = { min: 10, max: 600, default: 30 } as const;
export const VDV463_REQUEST_TIMEOUT_SECONDS = { min: 5, max: 120, default: 30 } as const;
export const VDV463_MAX_RETRIES = { min: 0, max: 10, default: 3 } as const;
export const VDV463_KEEPALIVE_TIMEOUT_SECONDS = { min: 30, max: 900, default: 180 } as const;
