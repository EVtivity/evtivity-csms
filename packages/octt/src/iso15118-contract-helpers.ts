// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Shared setup of the ISO 15118 contract certificate tests (TC_M_26, TC_M_28,
// TC_M_100). The Test System's EV has its own OEM PKI. As an operator would,
// the test installs that OEM root in the CSMS (Certificates > Upload CA
// certificate) and creates contracts for the EV's PCID on the test driver
// (Driver > Plug & Charge contracts). The runner provides the local contract
// CA and the eMAID prefix.

import type { CallApiFn, StepResult, TestContext, TestResult } from './types.js';
import { callPncApi } from './pnc-api.js';
import { TestEv, type Edition } from './iso15118-test-ev.js';

export interface ContractSetup {
  ev: TestEv;
  emaids: string[];
  cleanup: () => Promise<void>;
}

export function skippedContractTest(reason: string): TestResult {
  return {
    status: 'skipped',
    durationMs: 0,
    steps: [{ step: 0, description: 'Precondition', status: 'skipped', actual: reason }],
  };
}

/**
 * Creates an EV, installs its OEM root, and creates `count` contracts for its
 * PCID. Returns the reason the test cannot run when the CSMS is not set up.
 */
export async function setUpContracts(
  ctx: TestContext,
  edition: Edition,
  count: number,
): Promise<ContractSetup | string> {
  const callApi: CallApiFn | undefined = ctx.callApi;
  if (callApi == null || ctx.testDriverId == null) {
    return 'Needs the CSMS API (--api-url) and provisioned stations to create contracts';
  }
  const ca = await callApi('GET', '/pnc/settings/local-ca');
  if (ca.body['configured'] !== true) return 'The CSMS has no local contract CA';

  const ev = await TestEv.create(edition);
  const root = await callPncApi(callApi, 'POST', '/pnc/ca-certificates', {
    certificateType: 'OEMRootCertificate',
    certificate: ev.oemRoot.toString('pem'),
  });
  const rootId = typeof root.body['id'] === 'number' ? root.body['id'] : null;
  if (root.status >= 300 || rootId == null) {
    return `Could not install the Test System OEM root (${String(root.status)})`;
  }
  const cleanup = async (): Promise<void> => {
    await callPncApi(callApi, 'DELETE', `/pnc/ca-certificates/${String(rootId)}`);
  };

  const emaids: string[] = [];
  for (let i = 0; i < count; i++) {
    const res = await callApi('POST', `/drivers/${ctx.testDriverId}/pnc-contracts`, {
      pcid: ev.pcid,
    });
    if (res.status >= 300 || typeof res.body['emaid'] !== 'string') {
      await cleanup();
      const code = typeof res.body['code'] === 'string' ? res.body['code'] : '';
      return `Could not create a contract (${String(res.status)} ${code})`;
    }
    emaids.push(res.body['emaid']);
  }
  return { ev, emaids, cleanup };
}

/** Steps for the OCTT validation of a Get15118EVCertificateResponse. */
export function pushResponseSteps(
  steps: StepResult[],
  step: number,
  response: Record<string, unknown>,
  expectedRemaining?: number,
): void {
  const status = response['status'];
  steps.push({
    step,
    description: 'Get15118EVCertificateResponse status',
    status: status === 'Accepted' ? 'passed' : 'failed',
    expected: 'status = Accepted',
    actual: `status = ${String(status)}`,
  });
  const exi = response['exiResponse'];
  steps.push({
    step,
    description: 'exiResponse holds the Base64 encoded CertificateInstallationRes',
    status: typeof exi === 'string' && exi.length > 0 ? 'passed' : 'failed',
    expected: 'exiResponse present',
    actual:
      typeof exi === 'string' && exi.length > 0 ? `${String(exi.length)} characters` : 'Missing',
  });
  if (expectedRemaining != null) {
    const remaining = response['remainingContracts'];
    steps.push({
      step,
      description: 'remainingContracts',
      status: remaining === expectedRemaining ? 'passed' : 'failed',
      expected: `remainingContracts = ${String(expectedRemaining)}`,
      actual: `remainingContracts = ${String(remaining)}`,
    });
  }
}
