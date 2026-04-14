// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TestCase, StepResult } from '../../../../types.js';

export const TC_C_108_CSMS: TestCase = {
  id: 'TC_C_108_CSMS',
  name: 'Integrated Payment Terminal - VAT number validation',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'To start/authorize a transaction from a payment terminal connected directly to the Charging Station.',
  purpose: 'To verify that the CSMS can validate VAT numbers correctly.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Step 1: Boot the station
    const bootRes = await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    steps.push({
      step: 1,
      description: 'Boot station',
      status: bootRes['status'] === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(bootRes['status'])}`,
    });

    // Step 2: Send VatNumberValidationRequest with valid VAT number and evseId
    try {
      const vatRes1 = await ctx.client.sendCall('VatNumberValidation', {
        vatNumber: 'NL123456789B01',
        evseId: 1,
      });

      const vatStatus1 = vatRes1['status'] as string | undefined;
      const vatNumber1 = vatRes1['vatNumber'] as string | undefined;
      const vatEvseId1 = vatRes1['evseId'] as number | undefined;

      steps.push({
        step: 2,
        description: 'Send VatNumberValidation with valid VAT number and evseId=1',
        status: vatStatus1 === 'Accepted' ? 'passed' : 'failed',
        expected: 'status = Accepted, vatNumber = NL123456789B01, evseId = 1',
        actual: `status = ${String(vatStatus1)}, vatNumber = ${String(vatNumber1)}, evseId = ${String(vatEvseId1)}`,
      });

      // Step 3: Send VatNumberValidationRequest with invalid VAT number and evseId
      const vatRes2 = await ctx.client.sendCall('VatNumberValidation', {
        vatNumber: 'INVALID-VAT',
        evseId: 1,
      });

      const vatStatus2 = vatRes2['status'] as string | undefined;

      steps.push({
        step: 3,
        description: 'Send VatNumberValidation with invalid VAT number and evseId=1',
        status: vatStatus2 === 'Rejected' ? 'passed' : 'failed',
        expected: 'status = Rejected',
        actual: `status = ${String(vatStatus2)}`,
      });

      // Step 4: Send VatNumberValidationRequest with valid VAT number without evseId
      const vatRes3 = await ctx.client.sendCall('VatNumberValidation', {
        vatNumber: 'NL123456789B01',
      });

      const vatStatus3 = vatRes3['status'] as string | undefined;

      steps.push({
        step: 4,
        description: 'Send VatNumberValidation with valid VAT number without evseId',
        status: vatStatus3 === 'Accepted' ? 'passed' : 'failed',
        expected: 'status = Accepted',
        actual: `status = ${String(vatStatus3)}`,
      });

      // Step 5: Send VatNumberValidationRequest with invalid VAT number without evseId
      const vatRes4 = await ctx.client.sendCall('VatNumberValidation', {
        vatNumber: 'INVALID-VAT',
      });

      const vatStatus4 = vatRes4['status'] as string | undefined;

      steps.push({
        step: 5,
        description: 'Send VatNumberValidation with invalid VAT number without evseId',
        status: vatStatus4 === 'Rejected' ? 'passed' : 'failed',
        expected: 'status = Rejected',
        actual: `status = ${String(vatStatus4)}`,
      });
    } catch {
      steps.push({
        step: 2,
        description: 'VatNumberValidation not supported by CSMS',
        status: 'failed',
        expected: 'VatNumberValidation supported',
        actual: 'VatNumberValidation call failed or not supported',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
