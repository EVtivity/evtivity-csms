// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Builds the charging information payload (ProvideChargingInformation) from a
// snapshot of the depot system's sites. Pure: the services package reads the
// snapshot from the database (features/vdv-463.md, "Charging information").

import type {
  Vdv463ChargingPointFaultCode,
  Vdv463ChargingPointStatus,
  Vdv463ChargingStationFaultCode,
  Vdv463ChargingStationStatus,
  Vdv463ProcessStatus,
  Vdv463VehicleChargingStatus,
} from './constants.js';
import { vdv463Timestamp } from './frame.js';
import { chargingPointId } from './requests.js';
import type {
  ProvideChargingInformationRequest,
  Vdv463ChargingPointInfo,
  Vdv463ChargingPredictionData,
  Vdv463ChargingProcessInfo,
  Vdv463ChargingStationInfo,
  Vdv463ScheduledChargingProcess,
  Vdv463VehicleInfo,
} from './schemas.js';

/** The process state from OCPP, before the plan's Queued and rejected states. */
export type OcppProcessState =
  | 'Preparing'
  | 'Charging'
  | 'SuspendedEV'
  | 'SuspendedEVSE'
  | 'Finishing';

export interface PredictionSnapshot {
  minSocPercent: number | null;
  minReachedAt: Date | null;
  finalSocPercent: number | null;
  finalReachedAt: Date | null;
  departureAt: Date | null;
  socAtDeparture: number | null;
}

export interface VehicleSnapshot {
  vin: string;
  evccId: string | null;
  socPercent: number | null;
  /** OCPP 2.1 TransactionEvent preconditioningStatus of the session. */
  preconditioningStatus: string | null;
  /** A manual HVAC preconditioning window of the departure has started. */
  hvacPreconditioningActive: boolean;
}

export interface ProcessSnapshot {
  processId: string;
  /** Set only for a process of this depot system's own request. */
  presystemId: string | null;
  requestId: string | null;
  startedAt: Date;
  state: OcppProcessState;
  /** The current slot plans no power and a later slot does. */
  queued: boolean;
  /** The station refused the plan profile, or the session faulted. */
  rejected: boolean;
  deliveredWh: number | null;
  powerKw: number | null;
  currentA: number | null;
  voltageV: number | null;
  reactiveKvar: number | null;
  vehicle: VehicleSnapshot | null;
  prediction: PredictionSnapshot;
}

export interface ScheduledSnapshot {
  presystemId: string;
  requestId: string;
  processId: string;
  vin: string;
  startAt: Date | null;
  prediction: PredictionSnapshot;
}

export interface PointSnapshot {
  evseId: number;
  /** OCPP status of each connector of the EVSE. */
  connectorStatuses: string[];
  /** OCPP 1.6 StatusNotification error code of the EVSE, if any. */
  errorCode: string | null;
  errorAt: Date | null;
  errorText: string | null;
  allowedKw: number | null;
  meterWh: number | null;
  powerKw: number | null;
  temperatureC: number | null;
  process: ProcessSnapshot | null;
  scheduled: ScheduledSnapshot[];
}

export interface StationSnapshot {
  ocppId: string;
  isOnline: boolean;
  /** When the station went offline (the fault time). */
  offlineSince: Date | null;
  /** OCPP 1.6 error code reported for the whole station (connector 0). */
  stationErrorCode: string | null;
  stationErrorAt: Date | null;
  points: PointSnapshot[];
}

export interface DepotSnapshot {
  siteId: string;
  name: string;
  stations: StationSnapshot[];
}

const POINT_STATUS_RANK: Record<Vdv463ChargingPointStatus, number> = {
  Available: 0,
  Reserved: 1,
  Occupied: 2,
  Unavailable: 3,
  Faulted: 4,
};

/** One OCPP connector status as a charging point status. */
export function pointStatusOfConnector(status: string): Vdv463ChargingPointStatus {
  switch (status) {
    case 'Available':
      return 'Available';
    case 'Reserved':
      return 'Reserved';
    case 'Unavailable':
      return 'Unavailable';
    case 'Faulted':
      return 'Faulted';
    case 'Occupied':
    case 'Preparing':
    case 'Charging':
    case 'SuspendedEV':
    case 'SuspendedEVSE':
    case 'Finishing':
      return 'Occupied';
    default:
      return 'Unavailable';
  }
}

/** The worst connector status of an EVSE; an offline station's points are Unavailable. */
export function pointStatus(
  connectorStatuses: readonly string[],
  stationOnline: boolean,
): Vdv463ChargingPointStatus {
  if (!stationOnline) return 'Unavailable';
  let worst: Vdv463ChargingPointStatus = 'Available';
  if (connectorStatuses.length === 0) return 'Unavailable';
  for (const status of connectorStatuses) {
    const mapped = pointStatusOfConnector(status);
    if (POINT_STATUS_RANK[mapped] > POINT_STATUS_RANK[worst]) worst = mapped;
  }
  return worst;
}

/** VDV issue #2: Faulted wins, then Unavailable (or offline), else Available. */
export function stationStatus(
  points: readonly Vdv463ChargingPointStatus[],
  online: boolean,
): Vdv463ChargingStationStatus {
  if (points.includes('Faulted')) return 'Faulted';
  if (!online || points.includes('Unavailable')) return 'Unavailable';
  return 'Available';
}

const POINT_FAULTS: Record<string, Vdv463ChargingPointFaultCode> = {
  EVCommunicationError: 'CommunicationFailure',
  ConnectorLockFailure: 'UsageFailure',
  ReaderFailure: 'UsageFailure',
};

const STATION_FAULTS: Record<string, Vdv463ChargingStationFaultCode> = {
  GroundFailure: 'ElectricalOperationFailure',
  PowerSwitchFailure: 'ElectricalOperationFailure',
  OverCurrentFailure: 'ElectricalOperationFailure',
  OverVoltage: 'ElectricalOperationFailure',
  UnderVoltage: 'ElectricalOperationFailure',
  HighTemperature: 'ElectricalOperationFailure',
  PowerMeterFailure: 'ElectricalOperationFailure',
  LocalListConflict: 'ConfigurationFailure',
  InternalError: 'OtherChargingStationFailure',
  OtherError: 'OtherChargingStationFailure',
  WeakSignal: 'OtherChargingStationFailure',
};

/** An OCPP 1.6 error code as a point fault, or null when it belongs to the station. */
export function pointFaultOfErrorCode(code: string): Vdv463ChargingPointFaultCode | null {
  return POINT_FAULTS[code] ?? null;
}

/** An OCPP 1.6 error code as a station fault, or null when it belongs to the point. */
export function stationFaultOfErrorCode(code: string): Vdv463ChargingStationFaultCode | null {
  if (code === 'NoError') return null;
  return (
    STATION_FAULTS[code] ?? (POINT_FAULTS[code] != null ? null : 'OtherChargingStationFailure')
  );
}

/**
 * The vehicle state of a connected, identified vehicle from the OCPP charging
 * state: Charging while energy flows, else ReadyToCharge (connected; nothing
 * EVtivity receives over OCPP reports a vehicle malfunction, so
 * ChargingImpossible is never claimed). Unknown is for a vehicle EVtivity
 * cannot identify, which gets no vehicle structure at all.
 */
export function vehicleChargingStatus(state: OcppProcessState): Vdv463VehicleChargingStatus {
  return state === 'Charging' ? 'Charging' : 'ReadyToCharge';
}

export function processStatus(process: ProcessSnapshot): Vdv463ProcessStatus {
  if (process.rejected) return 'ChargingRejectedTechnically';
  if (process.state === 'Finishing') return 'Finishing';
  if (process.queued) return 'Queued';
  return process.state;
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** The prediction structure: only the parts the plan and the SoC make known. */
export function predictionData(prediction: PredictionSnapshot): Vdv463ChargingPredictionData {
  const out: Vdv463ChargingPredictionData = {};
  if (prediction.minSocPercent != null && prediction.minReachedAt != null) {
    out.chargingPredictionDataMinSoc = {
      requestedMinSoc: prediction.minSocPercent,
      predictedTime: vdv463Timestamp(prediction.minReachedAt),
    };
  }
  if (prediction.finalSocPercent != null && prediction.finalReachedAt != null) {
    out.chargingPredictionDataFinalSoc = {
      predictedFinalSoc: round(prediction.finalSocPercent, 1),
      predictedTime: vdv463Timestamp(prediction.finalReachedAt),
    };
  }
  if (prediction.socAtDeparture != null && prediction.departureAt != null) {
    out.chargingPredictionDataDepartureTime = {
      predictedDepartureTimeSoc: round(prediction.socAtDeparture, 1),
      predictedTime: vdv463Timestamp(prediction.departureAt),
    };
  }
  return out;
}

function vehicleInfo(vehicle: VehicleSnapshot, state: OcppProcessState): Vdv463VehicleInfo {
  const status: Vdv463VehicleInfo['vehicleStatusInfo'] = {};
  if (vehicle.preconditioningStatus != null && vehicle.preconditioningStatus !== 'Unknown') {
    status.systemPreconditioningActive = vehicle.preconditioningStatus === 'Preconditioning';
  }
  if (vehicle.hvacPreconditioningActive) status.hvacPreconditioningActive = true;
  return {
    vehicleId: vehicle.vin,
    ...(vehicle.evccId != null ? { evccId: vehicle.evccId } : {}),
    ...(vehicle.socPercent != null
      ? { tractionBatteryInfo: { stateOfCharge: vehicle.socPercent } }
      : {}),
    vehicleStatusInfo: status,
    vehicleChargingStatus: vehicleChargingStatus(state),
    preconditioningInfo: {},
  };
}

function processInfo(process: ProcessSnapshot): Vdv463ChargingProcessInfo {
  const electric: Vdv463ChargingProcessInfo['electricData'] = {
    ...(process.currentA != null ? { chargingCurrent: round(process.currentA, 1) } : {}),
    ...(process.voltageV != null ? { chargingVoltage: round(process.voltageV, 1) } : {}),
    // Required in 1.1: 0 until the station measured anything.
    chargingPower: round(process.powerKw ?? 0, 2),
    ...(process.reactiveKvar != null ? { reactivePower: round(process.reactiveKvar, 2) } : {}),
  };
  return {
    ...(process.presystemId != null ? { presystemId: process.presystemId } : {}),
    ...(process.requestId != null ? { chargingRequestId: process.requestId } : {}),
    chargingProcessId: process.processId,
    processStatus: processStatus(process),
    startTime: vdv463Timestamp(process.startedAt),
    chargingPredictionData: predictionData(process.prediction),
    electricData: electric,
    ...(process.deliveredWh != null ? { deliveredEnergy: Math.round(process.deliveredWh) } : {}),
  };
}

function scheduledInfo(s: ScheduledSnapshot): Vdv463ScheduledChargingProcess {
  return {
    presystemId: s.presystemId,
    chargingRequestId: s.requestId,
    chargingProcessId: s.processId,
    vehicleId: s.vin,
    ...(s.startAt != null ? { startTime: vdv463Timestamp(s.startAt) } : {}),
    chargingPredictionData: predictionData(s.prediction),
  };
}

function pointInfo(
  station: StationSnapshot,
  point: PointSnapshot,
  now: Date,
): Vdv463ChargingPointInfo {
  const status = pointStatus(point.connectorStatuses, station.isOnline);
  const info: Vdv463ChargingPointInfo = {
    chargingPointId: chargingPointId(station.ocppId, point.evseId),
    chargingPointStatus: status,
  };
  if (!station.isOnline) {
    info.chargingPointFaultInfo = {
      chargingPointFaultCode: 'CommunicationFailure',
      faultText: 'Charging station offline',
      faultTimeStamp: vdv463Timestamp(station.offlineSince ?? now),
    };
  } else if (point.errorCode != null && point.errorCode !== 'NoError') {
    const code = pointFaultOfErrorCode(point.errorCode);
    if (code != null) {
      info.chargingPointFaultInfo = {
        chargingPointFaultCode: code,
        ...(point.errorText != null ? { faultText: point.errorText.slice(0, 200) } : {}),
        faultTimeStamp: vdv463Timestamp(point.errorAt ?? now),
      };
    }
  } else if (status === 'Faulted') {
    info.chargingPointFaultInfo = {
      chargingPointFaultCode: 'OtherChargingPointFailure',
      faultTimeStamp: vdv463Timestamp(point.errorAt ?? now),
    };
  }
  if (point.temperatureC != null) info.connectorTemperature = round(point.temperatureC, 1);
  if (point.allowedKw != null) info.presentPower = round(point.allowedKw, 2);
  if (point.meterWh != null) info.energyMeterReading = Math.round(point.meterWh);
  if (point.process != null) {
    if (point.process.vehicle != null) {
      info.vehicleInfo = vehicleInfo(point.process.vehicle, point.process.state);
    }
    info.chargingProcessInfo = processInfo(point.process);
  }
  if (point.scheduled.length > 0)
    info.scheduledChargingProcessList = point.scheduled.map(scheduledInfo);
  return info;
}

function stationInfo(station: StationSnapshot, now: Date): Vdv463ChargingStationInfo {
  const points = station.points.map((p) => pointInfo(station, p, now));
  const info: Vdv463ChargingStationInfo = {
    chargingStationId: station.ocppId,
    chargingStationStatus: stationStatus(
      points.map((p) => p.chargingPointStatus),
      station.isOnline,
    ),
    chargingPointInfoList: points,
  };
  if (!station.isOnline) {
    info.chargingStationFaultInfo = {
      chargingStationFaultCode: 'CommunicationFailure',
      faultText: 'Charging station offline',
      faultTimeStamp: vdv463Timestamp(station.offlineSince ?? now),
    };
  } else if (station.stationErrorCode != null) {
    const code = stationFaultOfErrorCode(station.stationErrorCode);
    if (code != null) {
      info.chargingStationFaultInfo = {
        chargingStationFaultCode: code,
        faultTimeStamp: vdv463Timestamp(station.stationErrorAt ?? now),
      };
    }
  }
  const measured = station.points
    .map((p) => p.powerKw)
    .filter((kw): kw is number => kw != null && Number.isFinite(kw));
  if (measured.length > 0)
    info.totalPower = round(
      measured.reduce((a, b) => a + b, 0),
      2,
    );
  return info;
}

/** The payload of one ProvideChargingInformation request. */
export function buildChargingInformation(
  depots: readonly DepotSnapshot[],
  now: Date,
): ProvideChargingInformationRequest {
  return {
    depotInfoList: depots.map((depot) => ({
      depotId: depot.siteId,
      name: depot.name,
      chargingStationInfoList: depot.stations.map((s) => stationInfo(s, now)),
    })),
  };
}
