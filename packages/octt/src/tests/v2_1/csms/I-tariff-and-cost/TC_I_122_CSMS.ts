// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

/**
 * TC_I_122_CSMS: Local Cost Calculation - Cost Details of Transaction
 * Use case: I12
 * Scenario:
 *   1. CSMS sends SetDefaultTariffRequest for EVSE 0 with full tariff
 *   2. Respond Accepted
 *   3. EnergyTransferStarted
 *   4. TransactionEvent Updated with costDetails
 *   5. CSMS responds with TransactionEventResponse
 */
export const TC_I_122_CSMS: TestCase = {
  id: 'TC_I_122_CSMS',
  name: 'Local Cost Calculation - Cost Details of Transaction',
  module: 'I-tariff-and-cost',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'Charging Station calculates cost of the transaction locally and returns a break-down of the cost at end of transaction.',
  purpose:
    'To verify if the CSMS is able to process the cost details sent by the Charging Station.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    await ctx.client.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Available',
      evseId: 1,
      connectorId: 1,
    });

    let setTariffId = '';

    // Step 1: Wait for CSMS to send SetDefaultTariffRequest
    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'SetDefaultTariff') {
          const tariff = payload['tariff'] as Record<string, unknown> | undefined;
          setTariffId = String(tariff?.['tariffId'] ?? '');

          const evseId = payload['evseId'];
          const energy = tariff?.['energy'] as Record<string, unknown> | undefined;
          const chargingTime = tariff?.['chargingTime'] as Record<string, unknown> | undefined;
          const idleTime = tariff?.['idleTime'] as Record<string, unknown> | undefined;
          const fixedFee = tariff?.['fixedFee'] as Record<string, unknown> | undefined;
          const minCost = tariff?.['minCost'] as Record<string, unknown> | undefined;
          const maxCost = tariff?.['maxCost'] as Record<string, unknown> | undefined;

          const allPresent =
            evseId === 0 &&
            energy != null &&
            chargingTime != null &&
            idleTime != null &&
            fixedFee != null &&
            minCost != null &&
            maxCost != null;

          steps.push({
            step: 1,
            description: 'CSMS sends SetDefaultTariffRequest with full tariff',
            status: allPresent ? 'passed' : 'failed',
            expected: 'evseId=0, energy, chargingTime, idleTime, fixedFee, minCost, maxCost',
            actual: `evseId=${String(evseId)}, energy=${energy != null ? 'present' : 'missing'}, chargingTime=${chargingTime != null ? 'present' : 'missing'}, idleTime=${idleTime != null ? 'present' : 'missing'}, fixedFee=${fixedFee != null ? 'present' : 'missing'}, minCost=${minCost != null ? 'present' : 'missing'}, maxCost=${maxCost != null ? 'present' : 'missing'}`,
          });

          // Validate idleTime taxRates
          const idleTaxRates = idleTime?.['taxRates'] as Record<string, unknown>[] | undefined;
          const idleTax = idleTaxRates?.[0]?.['tax'];
          const idleTaxType = idleTaxRates?.[0]?.['type'];
          steps.push({
            step: 3,
            description: 'idleTime.taxRates present with tax=20, type=VAT',
            status: idleTax === 20 && idleTaxType === 'VAT' ? 'passed' : 'failed',
            expected: 'tax = 20, type = VAT',
            actual: `tax = ${String(idleTax)}, type = ${String(idleTaxType)}`,
          });

          // Validate fixedFee taxRates
          const fixedFeeTaxRates = fixedFee?.['taxRates'] as Record<string, unknown>[] | undefined;
          const fixedTax = fixedFeeTaxRates?.[0]?.['tax'];
          const fixedTaxType = fixedFeeTaxRates?.[0]?.['type'];
          steps.push({
            step: 4,
            description: 'fixedFee.taxRates present with tax=20, type=VAT',
            status: fixedTax === 20 && fixedTaxType === 'VAT' ? 'passed' : 'failed',
            expected: 'tax = 20, type = VAT',
            actual: `tax = ${String(fixedTax)}, type = ${String(fixedTaxType)}`,
          });

          // Validate minCost
          const minExclTax = minCost?.['exclTax'];
          const minInclTax = minCost?.['inclTax'];
          const minTaxRates = minCost?.['taxRates'] as Record<string, unknown>[] | undefined;
          steps.push({
            step: 5,
            description: 'minCost with exclTax, inclTax, taxRates',
            status:
              minExclTax != null &&
              minInclTax != null &&
              minTaxRates != null &&
              minTaxRates.length > 0
                ? 'passed'
                : 'failed',
            expected: 'minCost.exclTax, minCost.inclTax, minCost.taxRates present',
            actual: `exclTax=${String(minExclTax)}, inclTax=${String(minInclTax)}, taxRates=${minTaxRates != null ? 'present' : 'missing'}`,
          });

          // Validate maxCost
          const maxExclTax = maxCost?.['exclTax'];
          const maxInclTax = maxCost?.['inclTax'];
          const maxTaxRates = maxCost?.['taxRates'] as Record<string, unknown>[] | undefined;
          steps.push({
            step: 6,
            description: 'maxCost with exclTax, inclTax, taxRates',
            status:
              maxExclTax != null &&
              maxInclTax != null &&
              maxTaxRates != null &&
              maxTaxRates.length > 0
                ? 'passed'
                : 'failed',
            expected: 'maxCost.exclTax, maxCost.inclTax, maxCost.taxRates present',
            actual: `exclTax=${String(maxExclTax)}, inclTax=${String(maxInclTax)}, taxRates=${maxTaxRates != null ? 'present' : 'missing'}`,
          });

          return { status: 'Accepted' };
        }
        return {};
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'SetDefaultTariff', {
        stationId: ctx.stationId,
        evseId: 0,
        tariff: {
          tariffId: 'octt-tariff-122',
          currency: 'EUR',
          validFrom: new Date().toISOString(),
          energy: {
            prices: [{ priceKwh: 0.25 }],
            taxRates: [{ tax: 20, type: 'VAT' }],
          },
          chargingTime: {
            prices: [{ priceMinute: 0.05 }],
            taxRates: [{ tax: 20, type: 'VAT' }],
          },
          idleTime: {
            prices: [{ priceMinute: 0.1 }],
            taxRates: [{ tax: 20, type: 'VAT' }],
          },
          fixedFee: {
            prices: [{ priceFixed: 2.0 }],
            taxRates: [{ tax: 20, type: 'VAT' }],
          },
          minCost: {
            exclTax: 1.0,
            inclTax: 1.2,
            taxRates: [{ tax: 20, type: 'VAT' }],
          },
          maxCost: {
            exclTax: 50.0,
            inclTax: 60.0,
            taxRates: [{ tax: 20, type: 'VAT' }],
          },
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }

    // Step 3: EnergyTransferStarted
    const txId = `OCTT-TX-${String(Date.now())}`;
    const txStartTime = new Date().toISOString();
    await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: txStartTime,
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
    });

    // Step 4-5: TransactionEvent Updated with costDetails
    const txRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'RunningCost',
      seqNo: 1,
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
      costDetails: {
        totalCost: {
          currency: 'EUR',
          typeOfCost: 'NormalCost',
          total: { exclTax: 15, inclTax: 15.75 },
          fixed: {
            exclTax: 15,
            inclTax: 15.75,
            taxRates: [{ type: 't5_0', tax: 5.0 }],
          },
        },
        totalUsage: { energy: 12000, chargingTime: 900, idleTime: 0 },
        chargingPeriods: [
          {
            tariffId: setTariffId || 'test-tariff',
            startPeriod: txStartTime,
            dimensions: [
              { type: 'ChargingTime', volume: 15 },
              { type: 'Energy', volume: 12 },
            ],
          },
        ],
      },
    });

    steps.push({
      step: 7,
      description: 'TransactionEvent Updated with costDetails accepted',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(txRes).join(', ')}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
