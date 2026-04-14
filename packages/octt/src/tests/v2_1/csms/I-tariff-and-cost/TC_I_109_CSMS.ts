// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

/**
 * TC_I_109_CSMS: Receive Driver Tariff - Goodflow
 * Use case: I08 (I08.FR.01)
 * Scenario:
 *   1. Send AuthorizeRequest with valid idToken
 *   2. CSMS responds with AuthorizeResponse containing tariff
 * Validations:
 *   idTokenInfo.status = Accepted, tariff fields present
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
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
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
    const prices = energy?.['prices'] as Record<string, unknown>[] | undefined;
    const priceKwh = prices?.[0]?.['priceKwh'];
    steps.push({
      step: 4,
      description: 'tariff.energy.prices[0].priceKwh = 0.25',
      status: priceKwh === 0.25 ? 'passed' : 'failed',
      expected: 'priceKwh = 0.25',
      actual: `priceKwh = ${String(priceKwh)}`,
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
    const idlePrices = idleTime?.['prices'] as Record<string, unknown>[] | undefined;
    const priceMinute = idlePrices?.[0]?.['priceMinute'];
    steps.push({
      step: 6,
      description: 'tariff.idleTime.prices[0].priceMinute = 0.10',
      status: priceMinute === 0.1 ? 'passed' : 'failed',
      expected: 'priceMinute = 0.10',
      actual: `priceMinute = ${String(priceMinute)}`,
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
    const fixedPrices = fixedFee?.['prices'] as Record<string, unknown>[] | undefined;
    const priceFixed = fixedPrices?.[0]?.['priceFixed'];
    steps.push({
      step: 8,
      description: 'tariff.fixedFee.prices[0].priceFixed = 0.50',
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

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
