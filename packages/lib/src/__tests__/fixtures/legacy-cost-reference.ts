// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// A frozen copy of the session cost math as it billed before the single cost
// assembly (issue #33): the cost calculator totals and the OCPP final-cost
// assembly of packages/ocpp/src/server/session-cost.ts at 5f32cddb. Tests
// replay inputs through it and through calculateSessionCostAt to prove the
// net basis still charges the same amount to the cent. Do not change it.

export interface LegacyTariff {
  pricePerKwh: string | null;
  pricePerMinute: string | null;
  pricePerSession: string | null;
  idleFeePricePerMinute: string | null;
  reservationFeePerMinute: string | null;
  taxRate: string | null;
}

interface LegacySegment {
  tariff: LegacyTariff;
  durationMinutes: number;
  energyDeliveredWh: number;
  idleMinutes: number;
  isFirstSegment: boolean;
}

function dollarsToCents(dollars: number): number {
  return Math.round(Number((dollars * 100).toPrecision(12)));
}

export function legacySessionCostTotal(
  tariff: LegacyTariff,
  energyDeliveredWh: number,
  durationMinutes: number,
  idleMinutes = 0,
  gracePeriodMinutes = 0,
  reservationHoldingMinutes = 0,
): { subtotalCents: number; taxCents: number; totalCents: number } {
  const energyKwh = energyDeliveredWh / 1000;
  const pricePerKwh = tariff.pricePerKwh != null ? Number(tariff.pricePerKwh) : 0;
  const pricePerMinute = tariff.pricePerMinute != null ? Number(tariff.pricePerMinute) : 0;
  const pricePerSession = tariff.pricePerSession != null ? Number(tariff.pricePerSession) : 0;
  const idleFeePricePerMinute =
    tariff.idleFeePricePerMinute != null ? Number(tariff.idleFeePricePerMinute) : 0;
  const reservationFeePerMinute =
    tariff.reservationFeePerMinute != null ? Number(tariff.reservationFeePerMinute) : 0;
  const taxRate = tariff.taxRate != null ? Number(tariff.taxRate) : 0;

  const energyCostCents = dollarsToCents(energyKwh * pricePerKwh);
  const timeCostCents = dollarsToCents(durationMinutes * pricePerMinute);
  const sessionFeeCents = dollarsToCents(pricePerSession);
  const billableIdleMinutes = Math.max(0, idleMinutes - gracePeriodMinutes);
  const idleFeeCents = dollarsToCents(billableIdleMinutes * idleFeePricePerMinute);
  const reservationHoldingFeeCents = dollarsToCents(
    reservationHoldingMinutes * reservationFeePerMinute,
  );
  const subtotalCents =
    energyCostCents + timeCostCents + sessionFeeCents + idleFeeCents + reservationHoldingFeeCents;
  const taxCents = Math.round(subtotalCents * taxRate);
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

export function legacySplitSessionCostTotal(
  segments: LegacySegment[],
  gracePeriodMinutes: number,
  reservationHoldingMinutes = 0,
): { subtotalCents: number; taxCents: number; totalCents: number } {
  if (segments.length === 0) return { subtotalCents: 0, taxCents: 0, totalCents: 0 };
  const totalIdleMinutes = segments.reduce((sum, s) => sum + s.idleMinutes, 0);
  const billableTotalIdle = Math.max(0, totalIdleMinutes - gracePeriodMinutes);
  let remainingReduction = totalIdleMinutes - billableTotalIdle;
  const adjusted = [...segments]
    .reverse()
    .map((seg) => {
      const deduct = Math.min(seg.idleMinutes, remainingReduction);
      remainingReduction -= deduct;
      return { ...seg, idleMinutes: seg.idleMinutes - deduct };
    })
    .reverse();
  const parts = adjusted.map((segment) =>
    legacySessionCostTotal(
      segment.isFirstSegment ? segment.tariff : { ...segment.tariff, pricePerSession: null },
      segment.energyDeliveredWh,
      segment.durationMinutes,
      segment.idleMinutes,
      0,
    ),
  );
  const firstTariff = segments[0]?.tariff;
  const reservationFeePerMinute =
    firstTariff?.reservationFeePerMinute != null ? Number(firstTariff.reservationFeePerMinute) : 0;
  const firstTaxRate = firstTariff?.taxRate != null ? Number(firstTariff.taxRate) : 0;
  const holding = dollarsToCents(reservationHoldingMinutes * reservationFeePerMinute);
  const subtotalCents = parts.reduce((s, p) => s + p.subtotalCents, 0) + holding;
  const taxCents = parts.reduce((s, p) => s + p.taxCents, 0) + Math.round(holding * firstTaxRate);
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

/** A stored tariff segment as the legacy OCPP assembly read it. */
export interface LegacyStoredSegment {
  tariff: LegacyTariff;
  startedAt: Date;
  endedAt: Date | null;
  energyWhStart: number;
  energyWhEnd: number | null;
  idleMinutes: number;
}

/**
 * The legacy OCPP final-cost assembly (calculateSessionCostCentsAt) without
 * its database reads: segments when split billing is on and there are more
 * than one, else the session snapshot with the reservation fee of its tariff.
 */
export function legacySessionCostCentsAt(input: {
  tariff: LegacyTariff;
  startedAt: Date;
  endedAt: Date;
  energyWh: number;
  idleMinutes: number;
  gracePeriodMinutes: number;
  holdingMinutes: number;
  splitEnabled: boolean;
  segments: LegacyStoredSegment[];
}): number {
  const { segments, endedAt } = input;
  if (input.splitEnabled && segments.length > 1) {
    const closedIdleSum = segments.reduce(
      (sum, seg) => (seg.endedAt != null ? sum + seg.idleMinutes : sum),
      0,
    );
    const openIdleMinutes = Math.max(0, input.idleMinutes - closedIdleSum);
    const tariffSegments: LegacySegment[] = segments.map((seg, index) => {
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
    });
    return legacySplitSessionCostTotal(
      tariffSegments,
      input.gracePeriodMinutes,
      input.holdingMinutes,
    ).totalCents;
  }
  const durationMinutes = (endedAt.getTime() - input.startedAt.getTime()) / 60000;
  return legacySessionCostTotal(
    input.tariff,
    input.energyWh,
    durationMinutes,
    input.idleMinutes,
    input.gracePeriodMinutes,
    input.holdingMinutes,
  ).totalCents;
}
