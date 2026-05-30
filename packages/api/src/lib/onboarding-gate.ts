// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyReply } from 'fastify';

// Block portal/driver/guest entry points from operating on stations that
// have not yet been approved by an operator. Returns true when the station
// is fully onboarded and the caller may proceed; returns false after
// sending a 403 with STATION_PENDING or STATION_BLOCKED so the caller can
// just `return` immediately. Centralising the message keeps the two codes
// in lockstep across all three call sites (charger start, reservation
// create, guest start).
export async function checkStationOnboarded(
  station: { onboardingStatus: string | null },
  reply: FastifyReply,
): Promise<boolean> {
  if (station.onboardingStatus === 'accepted') return true;
  const code = station.onboardingStatus === 'pending' ? 'STATION_PENDING' : 'STATION_BLOCKED';
  const message =
    station.onboardingStatus === 'pending' ? 'Station is pending approval' : 'Station is blocked';
  await reply.status(403).send({ error: message, code });
  return false;
}
