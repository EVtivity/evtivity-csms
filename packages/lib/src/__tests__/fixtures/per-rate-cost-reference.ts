// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The split-session billing rule since audit N3 (owner decision 2026-10-04),
// written independently of the cost calculator: every segment's amounts are
// those of the frozen legacy calculator, but tax is rounded once per tax rate
// over the summed net amounts of the segments (and the reservation holding
// fee, at the first segment's rate) instead of once per segment. Net basis.

import { legacySessionCostTotal } from './legacy-cost-reference.js';
import type { LegacyStoredSegment, LegacyTariff } from './legacy-cost-reference.js';

interface ReferenceSegment {
  tariff: LegacyTariff;
  durationMinutes: number;
  energyDeliveredWh: number;
  idleMinutes: number;
  isFirstSegment: boolean;
}

function dollarsToCents(dollars: number): number {
  return Math.round(Number((dollars * 100).toPrecision(12)));
}

function rateOf(tariff: LegacyTariff | undefined): number {
  return tariff?.taxRate != null ? Number(tariff.taxRate) : 0;
}

export function perRateSplitSessionCostTotal(
  segments: ReferenceSegment[],
  gracePeriodMinutes: number,
  reservationHoldingMinutes = 0,
): { subtotalCents: number; taxCents: number; totalCents: number } {
  if (segments.length === 0) return { subtotalCents: 0, taxCents: 0, totalCents: 0 };
  const totalIdleMinutes = segments.reduce((sum, s) => sum + s.idleMinutes, 0);
  let remainingReduction = Math.min(totalIdleMinutes, gracePeriodMinutes);
  const adjusted = [...segments]
    .reverse()
    .map((seg) => {
      const deduct = Math.min(seg.idleMinutes, remainingReduction);
      remainingReduction -= deduct;
      return { ...seg, idleMinutes: seg.idleMinutes - deduct };
    })
    .reverse();

  const netByRate = new Map<number, number>();
  const add = (rate: number, net: number): void => {
    netByRate.set(rate, (netByRate.get(rate) ?? 0) + net);
  };
  for (const segment of adjusted) {
    const { subtotalCents } = legacySessionCostTotal(
      segment.isFirstSegment ? segment.tariff : { ...segment.tariff, pricePerSession: null },
      segment.energyDeliveredWh,
      segment.durationMinutes,
      segment.idleMinutes,
      0,
    );
    add(rateOf(segment.tariff), subtotalCents);
  }
  const firstTariff = segments[0]?.tariff;
  const feePerMinute =
    firstTariff?.reservationFeePerMinute != null ? Number(firstTariff.reservationFeePerMinute) : 0;
  add(rateOf(firstTariff), dollarsToCents(reservationHoldingMinutes * feePerMinute));

  let subtotalCents = 0;
  let taxCents = 0;
  for (const [rate, net] of netByRate) {
    subtotalCents += net;
    taxCents += Math.round(net * rate);
  }
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

/**
 * The OCPP final-cost assembly (as legacySessionCostCentsAt reads stored
 * segments) with tax rounded once per rate for split sessions. A session
 * priced from one tariff is billed as before.
 */
export function perRateSessionCostCentsAt(input: {
  tariff: LegacyTariff;
  startedAt: Date;
  endedAt: Date;
  energyWh: number;
  idleMinutes: number;
  gracePeriodMinutes: number;
  holdingMinutes: number;
  segments: LegacyStoredSegment[];
}): number {
  const { segments, endedAt } = input;
  if (segments.length > 1) {
    const closedIdleSum = segments.reduce(
      (sum, seg) => (seg.endedAt != null ? sum + seg.idleMinutes : sum),
      0,
    );
    const openIdleMinutes = Math.max(0, input.idleMinutes - closedIdleSum);
    return perRateSplitSessionCostTotal(
      segments.map((seg, index) => {
        const isOpen = seg.endedAt == null;
        const segEndMs = isOpen ? endedAt.getTime() : (seg.endedAt as Date).getTime();
        const segEnergyEnd = isOpen ? input.energyWh : (seg.energyWhEnd ?? 0);
        return {
          tariff: seg.tariff,
          durationMinutes: (segEndMs - seg.startedAt.getTime()) / 60000,
          energyDeliveredWh: segEnergyEnd - seg.energyWhStart,
          idleMinutes: isOpen ? openIdleMinutes : seg.idleMinutes,
          isFirstSegment: index === 0,
        };
      }),
      input.gracePeriodMinutes,
      input.holdingMinutes,
    ).totalCents;
  }
  return legacySessionCostTotal(
    input.tariff,
    input.energyWh,
    (endedAt.getTime() - input.startedAt.getTime()) / 60000,
    input.idleMinutes,
    input.gracePeriodMinutes,
    input.holdingMinutes,
  ).totalCents;
}
