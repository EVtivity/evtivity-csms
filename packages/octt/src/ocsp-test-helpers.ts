// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Shared steps of the OCSP-backed certificate tests (TC_C_50/51, TC_M_24).

import type { StepResult, TestContext } from './types.js';
import type { OcspTestService } from './ocsp-test-service.js';

/** Reusable State EVConnectedPreSession: cable plugged in, transaction started on EVConnected. */
export async function enterEvConnectedPreSession(ctx: TestContext): Promise<string> {
  await ctx.client.sendCall('StatusNotification', {
    timestamp: new Date().toISOString(),
    connectorStatus: 'Occupied',
    evseId: 1,
    connectorId: 1,
  });
  const transactionId = `OCTT-TX-${String(Date.now())}`;
  await ctx.client.sendCall('TransactionEvent', {
    eventType: 'Started',
    timestamp: new Date().toISOString(),
    triggerReason: 'CablePluggedIn',
    seqNo: 0,
    transactionInfo: { transactionId, chargingState: 'EVConnected' },
    evse: { id: 1, connectorId: 1 },
  });
  return transactionId;
}

/** Steps 2 and 3: the CSMS sent an OCSP request for the certificate and the request was valid. */
export function pushOcspRequestSteps(
  steps: StepResult[],
  ocsp: OcspTestService,
  serialNumber: string,
  expectedStatus: 'good' | 'revoked',
): void {
  const requests = ocsp.responder.requestsFor(serialNumber);
  steps.push({
    step: 2,
    description: 'CSMS sends an OCSP request for iso15118CertificateHashData',
    status: requests.length > 0 ? 'passed' : 'failed',
    expected: 'OCSP request for the contract certificate received by the Test System',
    actual:
      requests.length > 0
        ? `${String(requests.length)} request(s) received`
        : 'No OCSP request received (is the responder host in pnc.ocsp.allowedPrivateHosts?)',
  });
  const valid = requests.some((r) => r.status === expectedStatus);
  steps.push({
    step: 3,
    description: 'Test System checks the OCSP request is valid and answers',
    status: valid ? 'passed' : 'failed',
    expected: `Well-formed request for a known certificate, answered ${expectedStatus}`,
    actual: requests.map((r) => r.status).join(', ') || 'none',
  });
}

export function skippedWithoutOcsp(): {
  status: 'skipped';
  durationMs: number;
  steps: StepResult[];
} {
  return {
    status: 'skipped',
    durationMs: 0,
    steps: [
      {
        step: 1,
        description: 'Test System OCSP service',
        status: 'skipped',
        expected: 'Run with --ocsp-responder <url reachable from the CSMS>',
        actual: 'No OCSP responder configured',
      },
    ],
  };
}
