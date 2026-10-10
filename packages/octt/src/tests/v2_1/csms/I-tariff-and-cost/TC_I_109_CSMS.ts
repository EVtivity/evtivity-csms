// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';
import { conditionsOf, idleGraceSeconds, tariffPrices } from '../../../../tariff-test-helpers.js';
import { OCTT_THRESHOLD_KWH } from '../../../../tariff-test-constants.js';

/**
 * TC_I_109_CSMS: Receive Driver Tariff - Goodflow
 * Use case: I08 (I08.FR.01)
 * Scenario:
 *   1. Send AuthorizeRequest with valid idToken
 *   2. CSMS responds with AuthorizeResponse containing tariff
 * Validations:
 *   idTokenInfo.status = Accepted, tariff fields present
 *   The tariff is the OCTT pricing group as the CSMS bills it (runner.ts,
 *   split billing on): the energy-threshold tariff as a minEnergy condition
 *   ahead of the default, the idle fee after the idle grace (minIdleTime),
 *   the reservation fee as reservationTime, and no validFrom (I08.FR.09).
 */
export const TC_I_109_CSMS: TestCase = {
  id: 'TC_I_109_CSMS',
  name: 'Receive Driver Tariff - Goodflow',
  module: 'I-tariff-and-cost',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'To support receiving the driver-specific tariff to enable local cost calculation based on a tariff for this driver.',
  purpose: 'To verify if the CSMS supports driver tariffs.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    // Step 1-2: Authorize
    const authRes = await ctx.client.sendCall('Authorize', {
      idToken: { idToken: ctx.tokens.valid, type: 'ISO14443' },
    });

    const idTokenInfo = authRes['idTokenInfo'] as Record<string, unknown> | undefined;
    const authStatus = idTokenInfo?.['status'] as string;
    steps.push({
      step: 1,
      description: 'AuthorizeResponse - idTokenInfo.status = Accepted',
      status: authStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'idTokenInfo.status = Accepted',
      actual: `idTokenInfo.status = ${authStatus}`,
    });

    const tariff = authRes['tariff'] as Record<string, unknown> | undefined;
    const tariffId = tariff?.['tariffId'];
    steps.push({
      step: 2,
      description: 'tariff.tariffId present',
      status: tariffId != null ? 'passed' : 'failed',
      expected: 'tariff.tariffId present',
      actual: tariffId != null ? `tariffId = ${String(tariffId)}` : 'tariff omitted',
    });

    const currency = tariff?.['currency'];
    steps.push({
      step: 3,
      description: 'tariff.currency present',
      status: currency != null ? 'passed' : 'failed',
      expected: 'tariff.currency present',
      actual: currency != null ? `currency = ${String(currency)}` : 'currency omitted',
    });

    const energy = tariff?.['energy'] as Record<string, unknown> | undefined;
    const energyPrices = tariffPrices(tariff, 'energy');
    const defaultEnergy = energyPrices.find((p) => p['conditions'] == null);
    const priceKwh = defaultEnergy?.['priceKwh'];
    steps.push({
      step: 4,
      description: 'tariff.energy has the default price 0.25 without conditions',
      status: priceKwh === 0.25 ? 'passed' : 'failed',
      expected: 'priceKwh = 0.25',
      actual: `priceKwh = ${String(priceKwh)}`,
    });

    const minEnergy = OCTT_THRESHOLD_KWH * 1000;
    const bulk = energyPrices.find((p) => conditionsOf(p)['minEnergy'] === minEnergy);
    steps.push({
      step: 10,
      description: `tariff.energy has 0.20 from minEnergy ${String(minEnergy)} Wh, ahead of the default`,
      status:
        bulk?.['priceKwh'] === 0.2 &&
        defaultEnergy != null &&
        energyPrices.indexOf(bulk) < energyPrices.indexOf(defaultEnergy)
          ? 'passed'
          : 'failed',
      expected: `{ priceKwh: 0.2, conditions: { minEnergy: ${String(minEnergy)} } } first`,
      actual: JSON.stringify(energyPrices),
    });

    const energyTaxRates = energy?.['taxRates'] as Record<string, unknown>[] | undefined;
    const energyTax = energyTaxRates?.[0]?.['tax'];
    const energyTaxType = energyTaxRates?.[0]?.['type'];
    steps.push({
      step: 5,
      description: 'tariff.energy.taxRates present with tax=20, type=VAT',
      status: energyTax === 20 && energyTaxType === 'VAT' ? 'passed' : 'failed',
      expected: 'tax = 20, type = VAT',
      actual: `tax = ${String(energyTax)}, type = ${String(energyTaxType)}`,
    });

    const idleTime = tariff?.['idleTime'] as Record<string, unknown> | undefined;
    const graceSeconds = await idleGraceSeconds(ctx);
    const idlePrices = tariffPrices(tariff, 'idleTime').filter(
      (p) => conditionsOf(p)['minEnergy'] == null,
    );
    const idleFee = idlePrices.find((p) => p['priceMinute'] === 0.1);
    const idleFeeFrom = conditionsOf(idleFee)['minIdleTime'];
    const expectedFrom = graceSeconds > 0 ? graceSeconds : undefined;
    steps.push({
      step: 6,
      description: 'tariff.idleTime prices the idle fee 0.10 after the idle grace (minIdleTime)',
      status: idleFee != null && idleFeeFrom === expectedFrom ? 'passed' : 'failed',
      expected: `priceMinute = 0.10, minIdleTime = ${String(expectedFrom)}`,
      actual: JSON.stringify(idlePrices),
    });

    const idleTaxRates = idleTime?.['taxRates'] as Record<string, unknown>[] | undefined;
    const idleTax = idleTaxRates?.[0]?.['tax'];
    const idleTaxType = idleTaxRates?.[0]?.['type'];
    steps.push({
      step: 7,
      description: 'tariff.idleTime.taxRates present with tax=20, type=VAT',
      status: idleTax === 20 && idleTaxType === 'VAT' ? 'passed' : 'failed',
      expected: 'tax = 20, type = VAT',
      actual: `tax = ${String(idleTax)}, type = ${String(idleTaxType)}`,
    });

    const fixedFee = tariff?.['fixedFee'] as Record<string, unknown> | undefined;
    const priceFixed = tariffPrices(tariff, 'fixedFee').find((p) => p['conditions'] == null)?.[
      'priceFixed'
    ];
    steps.push({
      step: 8,
      description: 'tariff.fixedFee has the default price 0.50',
      status: priceFixed === 0.5 ? 'passed' : 'failed',
      expected: 'priceFixed = 0.50',
      actual: `priceFixed = ${String(priceFixed)}`,
    });

    const fixedTaxRates = fixedFee?.['taxRates'] as Record<string, unknown>[] | undefined;
    const fixedTax = fixedTaxRates?.[0]?.['tax'];
    const fixedTaxType = fixedTaxRates?.[0]?.['type'];
    steps.push({
      step: 9,
      description: 'tariff.fixedFee.taxRates present with tax=20, type=VAT',
      status: fixedTax === 20 && fixedTaxType === 'VAT' ? 'passed' : 'failed',
      expected: 'tax = 20, type = VAT',
      actual: `tax = ${String(fixedTax)}, type = ${String(fixedTaxType)}`,
    });

    const reservation = tariffPrices(tariff, 'reservationTime');
    steps.push({
      step: 11,
      description: 'tariff.reservationTime has the reservation fee 0.05 per minute',
      status: reservation.some((p) => p['priceMinute'] === 0.05) ? 'passed' : 'failed',
      expected: 'reservationTime.prices contains priceMinute = 0.05',
      actual: JSON.stringify(reservation),
    });

    steps.push({
      step: 12,
      description: 'tariff.validFrom omitted in an AuthorizeResponse (I08.FR.09)',
      status: tariff != null && tariff['validFrom'] == null ? 'passed' : 'failed',
      expected: 'validFrom omitted',
      actual: `validFrom = ${String(tariff?.['validFrom'])}`,
    });

    steps.forEach((step, index) => {
      step.step = index + 1;
    });
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
