// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StatusCheckResult } from './station-status-check.js';

const stationCheckRateLimit = new Map<string, number[]>();
const CHECK_RATE_LIMIT = 5; // max TriggerMessage dispatches per minute per station
const CHECK_RATE_WINDOW = 60_000; // 1 minute

export function isStationCheckRateLimited(stationId: string): boolean {
  const now = Date.now();
  const timestamps = stationCheckRateLimit.get(stationId) ?? [];
  const recent = timestamps.filter((t) => now - t < CHECK_RATE_WINDOW);
  if (recent.length === 0 && timestamps.length > 0) {
    stationCheckRateLimit.delete(stationId);
  }
  if (recent.length >= CHECK_RATE_LIMIT) {
    stationCheckRateLimit.set(stationId, recent);
    return true;
  }
  recent.push(now);
  stationCheckRateLimit.set(stationId, recent);
  return false;
}

// Short-lived cache of the last connector status check per (stationId, evseId).
// Without this, the per-station rate limit becomes a denial of service at busy
// sites: once 5 drivers request a status refresh in 60s every subsequent
// driver gets 429 and cannot complete the pre-start flow. With this cache,
// drivers within the window get the most recent freshly-pulled status instead
// of being locked out.
type CachedStatus = StatusCheckResult & { cachedAt: number };
const statusCheckCache = new Map<string, CachedStatus>();
const STATUS_CACHE_TTL_MS = 30_000;

function statusCacheKey(stationId: string, evseId: number): string {
  return `${stationId}:${String(evseId)}`;
}

export function getCachedConnectorStatus(
  stationId: string,
  evseId: number,
): StatusCheckResult | null {
  const key = statusCacheKey(stationId, evseId);
  const cached = statusCheckCache.get(key);
  if (cached == null) return null;
  if (Date.now() - cached.cachedAt > STATUS_CACHE_TTL_MS) {
    statusCheckCache.delete(key);
    return null;
  }
  return cached.errorCode != null
    ? { status: null, errorCode: cached.errorCode }
    : { status: cached.status };
}

export function setCachedConnectorStatus(
  stationId: string,
  evseId: number,
  result: StatusCheckResult,
): void {
  statusCheckCache.set(statusCacheKey(stationId, evseId), { ...result, cachedAt: Date.now() });
}

// Per-API-key rate limiter: 60 requests per minute per key
const apiKeyRateLimit = new Map<string, number[]>();
const API_KEY_RATE_LIMIT = 60;
const API_KEY_RATE_WINDOW = 60_000;

export function isApiKeyRateLimited(tokenHash: string): boolean {
  const now = Date.now();
  const timestamps = apiKeyRateLimit.get(tokenHash) ?? [];
  const recent = timestamps.filter((t) => now - t < API_KEY_RATE_WINDOW);
  if (recent.length === 0 && timestamps.length > 0) {
    apiKeyRateLimit.delete(tokenHash);
  }
  if (recent.length >= API_KEY_RATE_LIMIT) {
    apiKeyRateLimit.set(tokenHash, recent);
    return true;
  }
  recent.push(now);
  apiKeyRateLimit.set(tokenHash, recent);
  return false;
}

// Rate limiter for the guest session polling endpoints (status, power and
// energy history). One guest page polls about 24 times a minute, so the limit
// is per IP and session token (30 a minute), with a higher ceiling per IP
// (120 a minute) for several guests behind one NAT (finding G4). A request
// is counted only when both allow it. Expired entries are swept once a window.
const guestSessionRateLimit = new Map<string, number[]>();
const guestIpRateLimit = new Map<string, number[]>();
export const GUEST_SESSION_RATE_LIMIT = 30;
export const GUEST_IP_RATE_LIMIT = 120;
const GUEST_SESSION_RATE_WINDOW = 60_000;
let guestRateLimitSweptAt = 0;

function sweepGuestRateLimits(now: number): void {
  if (now - guestRateLimitSweptAt < GUEST_SESSION_RATE_WINDOW) return;
  guestRateLimitSweptAt = now;
  for (const map of [guestSessionRateLimit, guestIpRateLimit]) {
    for (const [key, timestamps] of map) {
      const last = timestamps[timestamps.length - 1];
      if (last == null || now - last >= GUEST_SESSION_RATE_WINDOW) map.delete(key);
    }
  }
}

function recentHits(map: Map<string, number[]>, key: string, now: number): number[] {
  return (map.get(key) ?? []).filter((t) => now - t < GUEST_SESSION_RATE_WINDOW);
}

export function isGuestSessionRateLimited(ip: string, sessionToken: string): boolean {
  const now = Date.now();
  sweepGuestRateLimits(now);
  const sessionKey = `${ip}|${sessionToken}`;
  const sessionHits = recentHits(guestSessionRateLimit, sessionKey, now);
  const ipHits = recentHits(guestIpRateLimit, ip, now);
  if (sessionHits.length >= GUEST_SESSION_RATE_LIMIT || ipHits.length >= GUEST_IP_RATE_LIMIT) {
    guestSessionRateLimit.set(sessionKey, sessionHits);
    guestIpRateLimit.set(ip, ipHits);
    return true;
  }
  sessionHits.push(now);
  ipHits.push(now);
  guestSessionRateLimit.set(sessionKey, sessionHits);
  guestIpRateLimit.set(ip, ipHits);
  return false;
}

/** Entries the guest limiter holds (tests: the sweep drops expired ones). */
export function guestSessionRateLimitSize(): number {
  return guestSessionRateLimit.size + guestIpRateLimit.size;
}
