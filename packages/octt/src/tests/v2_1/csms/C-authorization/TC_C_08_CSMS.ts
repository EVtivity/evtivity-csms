// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TestCase, StepResult } from '../../../../types.js';

export const TC_C_08_CSMS: TestCase = {
  id: 'TC_C_08_CSMS',
  name: 'Authorization through authorization cache - Accepted',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'This test case describes how the EV Driver is authorized to start a transaction while the Charging Station is offline using the authorization cache.',
  purpose:
    'To verify if the CSMS is able to respond correctly when an idToken which has status Accepted in the authorization cache is presented during a transaction.',
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

    // Step 2: Send StatusNotification
    await ctx.client.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Available',
      evseId: 1,
      connectorId: 1,
    });

    // Step 3: Send TransactionEvent Updated with valid cached idToken
    // TxStartPoint contains ParkingBayOccupancy, so transaction already started
    const txId = `OCTT-TX-${String(Date.now())}`;
    const txRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'Authorized',
      seqNo: 1,
      transactionInfo: { transactionId: txId, chargingState: 'EVConnected' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
    });

    const idTokenInfo = txRes['idTokenInfo'] as Record<string, unknown> | undefined;
    const authStatus = idTokenInfo?.['status'] as string | undefined;
    // TC_C_08 tests "Authorization through authorization cache - Accepted":
    // The CSMS should confirm the token status authoritatively. OCTT-TOKEN-001 is a valid
    // active token, so the CSMS correctly returns Accepted. The station used cache offline;
    // the CSMS confirms the cache was correct.
    const validStatuses = ['Accepted'];
    const statusValid = authStatus != null && validStatuses.includes(authStatus);

    steps.push({
      step: 2,
      description: 'Send TransactionEvent Updated with cached idToken (triggerReason Authorized)',
      status: statusValid ? 'passed' : 'failed',
      expected: 'idTokenInfo.status = Accepted',
      actual: `idTokenInfo.status = ${String(authStatus)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
