// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Shapes of the bus depot system routes (`/v1/depot-systems`, the bus depot
// interface), the query keys and the helpers the settings page and the
// departure views share.

import {
  VDV463_INFO_INTERVAL_SECONDS,
  VDV463_KEEPALIVE_TIMEOUT_SECONDS,
  VDV463_MAX_RETRIES,
  VDV463_PRESYSTEM_TYPES,
  VDV463_REFUSAL_REASONS,
  VDV463_REQUEST_TIMEOUT_SECONDS,
  type Vdv463PresystemType,
  type Vdv463RefusalReason,
} from '@evtivity/lib/vdv463';

export {
  VDV463_INFO_INTERVAL_SECONDS,
  VDV463_KEEPALIVE_TIMEOUT_SECONDS,
  VDV463_MAX_RETRIES,
  VDV463_PRESYSTEM_TYPES,
  VDV463_REFUSAL_REASONS,
  VDV463_REQUEST_TIMEOUT_SECONDS,
};
export type DepotSystemType = Vdv463PresystemType;
export type DepotRefusalReason = Vdv463RefusalReason;

export interface DepotSystemRefusal {
  requestId: string;
  vehicleRef: string | null;
  reason: DepotRefusalReason;
  refusedAt: string;
}

/** One item of `GET /v1/depot-systems` (and the detail, with its refused requests). */
export interface DepotSystem {
  id: string;
  presystemId: string;
  name: string;
  systemType: DepotSystemType;
  isEnabled: boolean;
  siteIds: string[];
  infoIntervalSeconds: number;
  requestTimeoutSeconds: number;
  maxRetries: number;
  keepaliveTimeoutSeconds: number;
  locked: boolean;
  lastConnectedAt: string | null;
  lastBootAt: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
  refusedRequests?: DepotSystemRefusal[];
}

export interface DepotConnection {
  path: string;
  subprotocol: string;
}

export interface DepotSystemList {
  data: DepotSystem[];
  connection: DepotConnection;
}

/** A create or a new password answer: the password, shown once. */
export interface DepotSystemWithPassword extends DepotSystem {
  password: string;
}

/** `GET /v1/depot-systems/:id/identifiers`. */
export interface DepotSystemIdentifiers {
  depots: {
    depotId: string;
    name: string;
    stations: { chargingStationId: string; chargingPointIds: string[] }[];
  }[];
  /** Left out for a reader without fleets:read. */
  buses?: { vehicleId: string; licensePlate: string | null; batteryCapacityKwh: number | null }[];
  connection: DepotConnection;
}

export const DEPOT_SYSTEMS_KEY = ['depot-systems'] as const;
export const depotSystemKey = (id: string) => ['depot-systems', id] as const;
export const depotSystemIdentifiersKey = (id: string) =>
  ['depot-systems', id, 'identifiers'] as const;

export const DEPOT_TIMING_FIELDS = [
  { key: 'infoIntervalSeconds', range: VDV463_INFO_INTERVAL_SECONDS },
  { key: 'requestTimeoutSeconds', range: VDV463_REQUEST_TIMEOUT_SECONDS },
  { key: 'maxRetries', range: VDV463_MAX_RETRIES },
  { key: 'keepaliveTimeoutSeconds', range: VDV463_KEEPALIVE_TIMEOUT_SECONDS },
] as const;

export type DepotTimingKey = (typeof DEPOT_TIMING_FIELDS)[number]['key'];

/** The presystem id rule of the API: visible ASCII without spaces or a colon, 1 to 255. */
export function isValidPresystemId(value: string): boolean {
  return value.length >= 1 && value.length <= 255 && /^[\x21-\x39\x3b-\x7e]+$/.test(value);
}

/**
 * Connected now: a message arrived within the system's keepalive time, after
 * which the API closes a silent connection.
 */
export function isConnectedNow(system: DepotSystem, now: number = Date.now()): boolean {
  if (!system.isEnabled || system.lastMessageAt == null) return false;
  return now - new Date(system.lastMessageAt).getTime() <= system.keepaliveTimeoutSeconds * 1000;
}

/** The WebSocket URL a depot system connects to: wss on the API host plus the path. */
export function depotWebSocketUrl(apiBaseUrl: string, path: string): string {
  try {
    const url = new URL(apiBaseUrl, window.location.origin);
    url.protocol = 'wss:';
    url.pathname = path;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    // fail-open: an unparseable base URL shows the path alone.
    return path;
  }
}
