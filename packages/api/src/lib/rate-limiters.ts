// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

const stationCheckRateLimit = new Map<string, number[]>();
const CHECK_RATE_LIMIT = 5; // max requests per minute per station
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

// Per-challengeId MFA attempt tracker: max 5 failed attempts per challenge
const mfaChallengeAttempts = new Map<number, number>();
const MFA_MAX_ATTEMPTS = 5;

export function isMfaChallengeExhausted(challengeId: number): boolean {
  const attempts = mfaChallengeAttempts.get(challengeId) ?? 0;
  return attempts >= MFA_MAX_ATTEMPTS;
}

export function recordMfaChallengeAttempt(challengeId: number): void {
  const attempts = mfaChallengeAttempts.get(challengeId) ?? 0;
  mfaChallengeAttempts.set(challengeId, attempts + 1);
}

export function clearMfaChallengeAttempts(challengeId: number): void {
  mfaChallengeAttempts.delete(challengeId);
}

// Per-IP rate limiter for guest session endpoints: 30 requests per minute
const guestSessionRateLimit = new Map<string, number[]>();
const GUEST_SESSION_RATE_LIMIT = 30;
const GUEST_SESSION_RATE_WINDOW = 60_000;

export function isGuestSessionRateLimited(ip: string): boolean {
  const now = Date.now();
  const timestamps = guestSessionRateLimit.get(ip) ?? [];
  const recent = timestamps.filter((t) => now - t < GUEST_SESSION_RATE_WINDOW);
  if (recent.length === 0 && timestamps.length > 0) {
    guestSessionRateLimit.delete(ip);
  }
  if (recent.length >= GUEST_SESSION_RATE_LIMIT) {
    guestSessionRateLimit.set(ip, recent);
    return true;
  }
  recent.push(now);
  guestSessionRateLimit.set(ip, recent);
  return false;
}
