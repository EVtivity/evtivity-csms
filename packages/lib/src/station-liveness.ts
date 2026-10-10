// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Station liveness rules shared by the OCPP server (closing a silent
// connection) and the worker (the offline sweep).

// Close a connection with no inbound message for this long. Three heartbeat
// intervals, never less than 15 minutes (3x the default 300s interval).
export const MIN_HEARTBEAT_TIMEOUT_MS = 900_000;

// Every inbound message bumps charging_stations.last_heartbeat (the station's
// last activity), at most once per this many seconds per station: the write
// is skipped while the stored value is newer, unless the station is offline.
export const LIVENESS_WRITE_INTERVAL_SECONDS = 30;

// Added to the heartbeat timeout before the offline sweep acts. It covers the
// liveness write interval above and the asynchronous projection lag, and a
// pod closing a silent connection at the timeout publishes
// station.Disconnected itself first.
export const OFFLINE_SWEEP_SLACK_MS = 60_000;

export function heartbeatTimeoutFor(heartbeatSeconds: number): number {
  return Math.max(MIN_HEARTBEAT_TIMEOUT_MS, heartbeatSeconds * 3 * 1000);
}

/**
 * How long an online station may stay silent before the offline sweep may
 * mark it offline: the OCPP server's own heartbeat timeout plus slack. A live
 * pod closes a silent connection at the timeout, so the sweep never acts on
 * a station a running pod still treats as connected.
 */
export function offlineSweepThresholdMs(heartbeatSeconds: number): number {
  return heartbeatTimeoutFor(heartbeatSeconds) + OFFLINE_SWEEP_SLACK_MS;
}

/**
 * The offline sweep decision. A station is offline only when no OCPP pod
 * holds its connection registry key AND nothing arrived from it since
 * `staleBefore`. A registry key means a pod holds the connection, however
 * quiet the station is.
 */
export function shouldMarkStationOffline(input: {
  registryOwner: string | null;
  lastActivityAt: Date | null;
  staleBefore: Date;
}): boolean {
  if (input.registryOwner != null) return false;
  if (input.lastActivityAt == null) return true;
  return input.lastActivityAt.getTime() < input.staleBefore.getTime();
}

/**
 * Whether the tariff boundary job may switch a session's tariff segment at
 * wall clock (finding B6): the station is online and sent something within
 * one heartbeat interval (plus the liveness write interval). A station that is
 * offline or silent may be queueing readings and its transaction end, which
 * arrive later with their own timestamps: the MeterValues projection then
 * switches at the reading timestamp and the Ended projection ends the
 * segments at the reported end, so the job leaves such a session alone.
 */
export function isStationLiveForSegmentSwitch(input: {
  isOnline: boolean;
  lastActivityAt: Date | null;
  now: Date;
  heartbeatSeconds: number;
}): boolean {
  if (!input.isOnline || input.lastActivityAt == null) return false;
  const maxSilenceMs = (input.heartbeatSeconds + LIVENESS_WRITE_INTERVAL_SECONDS) * 1000;
  return input.now.getTime() - input.lastActivityAt.getTime() <= maxSilenceMs;
}
