// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export interface TariffInput {
  pricePerKwh: string | null;
  pricePerMinute: string | null;
  pricePerSession: string | null;
  idleFeePricePerMinute: string | null;
  reservationFeePerMinute: string | null;
  taxRate: string | null;
  currency: string;
}

export interface CostBreakdown {
  energyCostCents: number;
  timeCostCents: number;
  sessionFeeCents: number;
  idleFeeCents: number;
  reservationHoldingFeeCents: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  currency: string;
}

export interface TariffSegment {
  tariff: TariffInput;
  durationMinutes: number;
  energyDeliveredWh: number;
  idleMinutes: number;
  isFirstSegment: boolean;
}

function dollarsToCents(dollars: number): number {
  return Math.round(Number((dollars * 100).toPrecision(12)));
}

export function calculateSessionCost(
  tariff: TariffInput,
  energyDeliveredWh: number,
  durationMinutes: number,
  idleMinutes: number = 0,
  gracePeriodMinutes: number = 0,
  reservationHoldingMinutes: number = 0,
): CostBreakdown {
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
  const totalCents = subtotalCents + taxCents;

  return {
    energyCostCents,
    timeCostCents,
    sessionFeeCents,
    idleFeeCents,
    reservationHoldingFeeCents,
    subtotalCents,
    taxCents,
    totalCents,
    currency: tariff.currency,
  };
}

export function calculateSplitSessionCost(
  segments: TariffSegment[],
  gracePeriodMinutes: number,
  reservationHoldingMinutes: number = 0,
): CostBreakdown {
  if (segments.length === 0) {
    return {
      energyCostCents: 0,
      timeCostCents: 0,
      sessionFeeCents: 0,
      idleFeeCents: 0,
      reservationHoldingFeeCents: 0,
      subtotalCents: 0,
      taxCents: 0,
      totalCents: 0,
      currency: 'USD',
    };
  }

  // Validate currency consistency across segments
  const currencies = new Set(segments.map((s) => s.tariff.currency));
  if (currencies.size > 1) {
    throw new Error(`Mixed currencies in split-billing segments: ${[...currencies].join(', ')}`);
  }

  // Apply grace period once across all segments. Distribute idle reduction
  // from last segment backward (idle typically accumulates at end of session).
  const totalIdleMinutes = segments.reduce((sum, s) => sum + s.idleMinutes, 0);
  const billableTotalIdle = Math.max(0, totalIdleMinutes - gracePeriodMinutes);
  let remainingReduction = totalIdleMinutes - billableTotalIdle;

  // Reduce idle from segments, starting from the last
  const adjustedSegments = [...segments];
  for (let i = adjustedSegments.length - 1; i >= 0 && remainingReduction > 0; i--) {
    const seg = adjustedSegments[i];
    if (seg == null) continue;
    const deduct = Math.min(seg.idleMinutes, remainingReduction);
    adjustedSegments[i] = { ...seg, idleMinutes: seg.idleMinutes - deduct };
    remainingReduction -= deduct;
  }

  let totalEnergyCostCents = 0;
  let totalTimeCostCents = 0;
  let totalSessionFeeCents = 0;
  let totalIdleFeeCents = 0;
  const currency = segments[0]?.tariff.currency ?? 'USD';
  const taxRate = segments[0]?.tariff.taxRate != null ? Number(segments[0].tariff.taxRate) : 0;

  for (const segment of adjustedSegments) {
    // Zero out session fee for non-first segments
    const tariff = segment.isFirstSegment
      ? segment.tariff
      : { ...segment.tariff, pricePerSession: null };

    // Calculate segment cost without tax (tax applied on aggregate subtotal)
    const breakdown = calculateSessionCost(
      { ...tariff, taxRate: null },
      segment.energyDeliveredWh,
      segment.durationMinutes,
      segment.idleMinutes,
      0, // Grace period already applied at the aggregate level
    );

    totalEnergyCostCents += breakdown.energyCostCents;
    totalTimeCostCents += breakdown.timeCostCents;
    totalIdleFeeCents += breakdown.idleFeeCents;
    totalSessionFeeCents += breakdown.sessionFeeCents;
  }

  // Reservation holding fee is a session-level charge, not per-segment.
  // Use the first segment's tariff rate (tariff active at session start).
  const firstTariff = segments[0]?.tariff;
  const reservationFeePerMinute =
    firstTariff?.reservationFeePerMinute != null ? Number(firstTariff.reservationFeePerMinute) : 0;
  const reservationHoldingFeeCents = dollarsToCents(
    reservationHoldingMinutes * reservationFeePerMinute,
  );

  const subtotalCents =
    totalEnergyCostCents +
    totalTimeCostCents +
    totalSessionFeeCents +
    totalIdleFeeCents +
    reservationHoldingFeeCents;
  // Apply tax once on the aggregate subtotal to avoid per-segment rounding drift
  const totalTaxCents = Math.round(subtotalCents * taxRate);
  const totalCents = subtotalCents + totalTaxCents;

  return {
    energyCostCents: totalEnergyCostCents,
    timeCostCents: totalTimeCostCents,
    sessionFeeCents: totalSessionFeeCents,
    idleFeeCents: totalIdleFeeCents,
    reservationHoldingFeeCents,
    subtotalCents,
    taxCents: totalTaxCents,
    totalCents,
    currency,
  };
}
