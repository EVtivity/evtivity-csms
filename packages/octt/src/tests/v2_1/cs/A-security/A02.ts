// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { X509Certificate } from 'node:crypto';
import type { CsTestCase, CsTestContext, StepResult } from '../../../../cs-types.js';
import { drainMessages } from '../../../../cs-test-helpers.js';
import {
  createRootCertificate,
  issueCertificate,
  signCertificateRequest,
} from '../../../../cs-security-pki.js';
import {
  csrSteps,
  result,
  setVariable,
  step,
  testPki,
  waitForSecurityEvent,
  waitForUpgrade,
} from './helpers.js';

/** TriggerMessage for a CSR (steps 1-2 of A02). */
async function triggerCsr(
  ctx: CsTestContext,
  requestedMessage: string,
  steps: StepResult[],
  extra: Record<string, unknown> = {},
): Promise<void> {
  const res = await ctx.server.sendCommand('TriggerMessage', { requestedMessage, ...extra });
  steps.push(
    step(
      2,
      `TriggerMessageResponse for ${requestedMessage}: Accepted`,
      res['status'] === 'Accepted',
      'status = Accepted',
      `status = ${String(res['status'])}`,
    ),
  );
}

/** Waits for the SignCertificateRequest of step 3; null on timeout. */
async function waitForSignCertificate(
  ctx: CsTestContext,
  timeoutMs = 15_000,
): Promise<Record<string, unknown> | null> {
  try {
    return await ctx.server.waitForMessage('SignCertificate', timeoutMs);
  } catch {
    return null;
  }
}

/**
 * Reusable State RenewChargingStationCertificate: TriggerMessage, SignCertificate,
 * CertificateSigned with a certificate generated from the CSR and signed by the
 * CSMS root, and the reconnection with the new certificate.
 */
async function renewChargingStationCertificate(
  ctx: CsTestContext,
  steps: StepResult[],
): Promise<void> {
  const tls = testPki(ctx);
  await triggerCsr(ctx, 'SignChargingStationCertificate', steps);

  const sign = await waitForSignCertificate(ctx);
  steps.push(
    step(
      3,
      'Charging Station sends SignCertificateRequest',
      sign != null,
      'received',
      sign != null ? 'received' : 'not received',
    ),
  );
  if (sign == null) return;
  const csrPem = sign['csr'] as string | undefined;
  const csrCheck = await csrSteps(3, csrPem);
  steps.push(...csrCheck.steps);
  if (csrCheck.csr == null || csrPem == null) return;

  // Step 5: CertificateSignedRequest with the certificate generated from the CSR
  const leafPem = (await signCertificateRequest(csrPem, tls.root)).chainPem;
  const upgradesBefore = ctx.server.upgradeAttempts.length;
  const signed = await ctx.server.sendCommand('CertificateSigned', {
    certificateChain: leafPem,
    certificateType: 'ChargingStationCertificate',
  });
  steps.push(
    step(
      6,
      'CertificateSignedResponse: Accepted',
      signed['status'] === 'Accepted',
      'status = Accepted',
      `status = ${String(signed['status'])}`,
    ),
  );
  if (signed['status'] !== 'Accepted') return;

  // Step 7: the station reconnects with the new certificate. The Test System waits,
  // then drops the connection to force a reconnection.
  let upgrade = await waitForUpgrade(ctx.server, upgradesBefore, 15_000);
  if (upgrade == null) {
    ctx.server.disconnectStation(false);
    upgrade = await waitForUpgrade(ctx.server, upgradesBefore, 30_000);
  }
  const newCert = new X509Certificate(leafPem);
  const presented = upgrade?.tls?.clientCertificate ?? null;
  steps.push(
    step(
      7,
      'Charging Station reconnects with the new certificate',
      presented != null && presented.fingerprint256 === newCert.fingerprint256,
      `client certificate serial ${newCert.serialNumber}`,
      presented == null
        ? 'no reconnection with a client certificate'
        : `serial ${presented.serialNumber}`,
    ),
  );
}

/**
 * TC_A_11_CS: Update Charging Station Certificate by request of CSMS - Success - Charging Station Certificate
 *
 * The CSMS requests the station to update its charging station certificate.
 * Executes the RenewChargingStationCertificate reusable state.
 */
export const TC_A_11_CS: CsTestCase = {
  id: 'TC_A_11_CS',
  name: 'Update Charging Station Certificate by request of CSMS - Success - Charging Station Certificate',
  module: 'A-security',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to request the Charging Station to update its charging station certificate using the TriggerMessage and CertificateSigned mechanism.',
  purpose: 'To verify if the Charging Station is able to update its Charging Station Certificate.',
  stationConfig: { securityProfile: 3 },
  tls: true,
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    // Step 1: Reusable State RenewChargingStationCertificate
    await renewChargingStationCertificate(ctx, steps);
    return result(steps);
  },
};

/**
 * TC_A_12_CS: Update Charging Station Certificate by request of CSMS - Success - V2G Certificate
 *
 * The CSMS requests the station to update its V2G certificate.
 * Executes the RenewV2GChargingStationCertificate memory state.
 */
export const TC_A_12_CS: CsTestCase = {
  id: 'TC_A_12_CS',
  name: 'Update Charging Station Certificate by request of CSMS - Success - V2G Certificate',
  module: 'A-security',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to request the Charging Station to update its charging station certificate using the TriggerMessage and CertificateSigned mechanism.',
  purpose:
    'To verify if the Charging Station is able to update its V2G Charging Station Certificate.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    // The V2G certificate chain the Test System provides
    const v2gRoot = await createRootCertificate('OCTT V2G Root CA');
    const v2gSubCa = await issueCertificate({
      subject: 'CN=OCTT V2G SubCA,O=OCTT,C=US',
      issuer: v2gRoot,
      ca: true,
    });

    // Prerequisite: the station trusts the V2G chain the Test System provides.
    const install = await ctx.server.sendCommand('InstallCertificate', {
      certificateType: 'V2GRootCertificate',
      certificate: v2gRoot.pem,
    });
    steps.push(
      step(
        0,
        'Prerequisite: V2G root certificate of the provided chain installed',
        install['status'] === 'Accepted',
        'status = Accepted',
        `status = ${String(install['status'])}`,
      ),
    );

    // Memory State RenewV2GChargingStationCertificate: the Test System looks up the
    // configured ISO15118Ctrlr.SeccId values with a GetBaseReport.
    const requestId = Math.floor(Math.random() * 1_000_000);
    await ctx.server.sendCommand('GetBaseReport', { requestId, reportBase: 'FullInventory' });
    const seccIds: Array<{ evseId: number | undefined; seccId: string }> = [];
    for (;;) {
      let report: Record<string, unknown>;
      try {
        report = await ctx.server.waitForMessage('NotifyReport', 10_000);
      } catch {
        break;
      }
      for (const item of (report['reportData'] as Array<Record<string, unknown>> | undefined) ??
        []) {
        const component = item['component'] as Record<string, unknown>;
        const variable = item['variable'] as Record<string, unknown>;
        if (component['name'] === 'ISO15118Ctrlr' && variable['name'] === 'SeccId') {
          const value = (item['variableAttribute'] as Array<Record<string, unknown>>)[0]?.['value'];
          if (typeof value === 'string') {
            seccIds.push({
              evseId: (component['evse'] as Record<string, unknown> | undefined)?.['id'] as
                | number
                | undefined,
              seccId: value,
            });
          }
        }
      }
      if (report['tbc'] !== true) break;
    }
    const targets = seccIds.length > 0 ? seccIds : [{ evseId: undefined, seccId: null }];

    for (const target of targets) {
      // Steps 1-2: TriggerMessage SignV2GCertificate (EVSE omitted when no seccId is configured)
      await triggerCsr(
        ctx,
        'SignV2GCertificate',
        steps,
        target.evseId != null ? { evse: { id: target.evseId } } : {},
      );

      // Steps 3-4: SignCertificateRequest, ECDSA of at least 256 bits, CN contains the seccId
      const sign = await waitForSignCertificate(ctx);
      steps.push(
        step(
          3,
          'Charging Station sends SignCertificateRequest',
          sign != null,
          'received',
          sign != null ? 'received' : 'not received',
        ),
      );
      if (sign == null) break;
      steps.push(
        step(
          3,
          'SignCertificateRequest certificateType is V2GCertificate',
          sign['certificateType'] === 'V2GCertificate',
          'V2GCertificate',
          String(sign['certificateType']),
        ),
      );
      const csrPem = sign['csr'] as string | undefined;
      const csrCheck = await csrSteps(3, csrPem, { ecdsaOnly: true, minEcBits: 256 });
      steps.push(...csrCheck.steps);
      if (target.seccId != null && csrCheck.csr != null) {
        steps.push(
          step(
            3,
            'CSR CN contains the seccId',
            csrCheck.csr.subject.includes(target.seccId),
            target.seccId,
            csrCheck.csr.subject,
          ),
        );
      }
      if (csrCheck.csr == null || csrPem == null) break;

      // Steps 5-6: CertificateSigned, signed by the V2G SubCA of the provided chain
      const leafPem = (await signCertificateRequest(csrPem, v2gSubCa)).chainPem;
      const signed = await ctx.server.sendCommand('CertificateSigned', {
        certificateChain: `${leafPem}\n${v2gSubCa.pem}`,
        certificateType: 'V2GCertificate',
      });
      steps.push(
        step(
          6,
          'CertificateSignedResponse: Accepted',
          signed['status'] === 'Accepted',
          'status = Accepted',
          `status = ${String(signed['status'])}`,
        ),
      );
    }

    return result(steps);
  },
};

/**
 * TC_A_14_CS: Update Charging Station Certificate by request of CSMS - Invalid certificate
 *
 * The CSMS sends an invalid certificate after requesting a CSR.
 * The station rejects the certificate and sends a SecurityEventNotification.
 */
export const TC_A_14_CS: CsTestCase = {
  id: 'TC_A_14_CS',
  name: 'Update Charging Station Certificate by request of CSMS - Invalid certificate',
  module: 'A-security',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to request the Charging Station to update its charging station certificate using the TriggerMessage and CertificateSigned mechanism.',
  purpose:
    'To verify if the Charging Station is able to discard an invalid certificate and report a security event.',
  stationConfig: { securityProfile: 3 },
  tls: true,
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Steps 1-2
    await triggerCsr(ctx, 'SignChargingStationCertificate', steps);

    // Steps 3-4: SignCertificateRequest, answered Accepted
    const sign = await waitForSignCertificate(ctx);
    steps.push(
      step(
        3,
        'Charging Station sends SignCertificateRequest',
        sign != null,
        'received',
        sign != null ? 'received' : 'not received',
      ),
    );
    if (sign == null) return result(steps);
    const csrPem = sign['csr'] as string | undefined;
    const csrCheck = await csrSteps(3, csrPem);
    steps.push(...csrCheck.steps);
    if (csrPem == null || csrCheck.csr == null) return result(steps);

    // Step 5: <Configured invalid_signingCertificate>: generated from the CSR but
    // signed by a CA outside the CSMS root hierarchy
    const untrustedRoot = await createRootCertificate('OCTT Untrusted Root CA');
    const invalidPem = (await signCertificateRequest(csrPem, untrustedRoot)).chainPem;
    const signed = await ctx.server.sendCommand('CertificateSigned', {
      certificateChain: invalidPem,
      certificateType: 'ChargingStationCertificate',
    });
    steps.push(
      step(
        6,
        'CertificateSignedResponse: Rejected',
        signed['status'] === 'Rejected',
        'status = Rejected',
        `status = ${String(signed['status'])}`,
      ),
    );

    // Step 7: SecurityEventNotification InvalidChargingStationCertificate
    const event = await waitForSecurityEvent(
      ctx.server,
      ['InvalidChargingStationCertificate'],
      10_000,
    );
    steps.push(
      step(
        7,
        'SecurityEventNotificationRequest type InvalidChargingStationCertificate',
        event != null,
        'type = InvalidChargingStationCertificate',
        event != null ? `type = ${String(event['type'])}` : 'not received',
      ),
    );

    return result(steps);
  },
};

/**
 * TC_A_15_CS: Update Charging Station Certificate by request of CSMS - SignCertificateRequest Rejected
 *
 * The CSMS triggers a certificate update but rejects the SignCertificateRequest.
 */
export const TC_A_15_CS: CsTestCase = {
  id: 'TC_A_15_CS',
  name: 'Update Charging Station Certificate by request of CSMS - SignCertificateRequest Rejected',
  module: 'A-security',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to request the Charging Station to update its charging station certificate using the TriggerMessage and CertificateSigned mechanism.',
  purpose:
    'To verify if the Charging Station is able to discard an invalid certificate and report a security event.',
  stationConfig: { securityProfile: 3 },
  tls: true,
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Step 4: the Test System answers the SignCertificateRequest with Rejected
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'SignCertificate') return { status: 'Rejected' };
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    // Steps 1-2
    await triggerCsr(ctx, 'SignChargingStationCertificate', steps);

    // Step 3: SignCertificateRequest
    const sign = await waitForSignCertificate(ctx);
    steps.push(
      step(
        3,
        'Charging Station sends SignCertificateRequest',
        sign != null,
        'received',
        sign != null ? 'received' : 'not received',
      ),
    );

    return result(steps);
  },
};

/**
 * TC_A_23_CS: Update Charging Station Certificate by request of CSMS - CertificateSignedRequest Timeout
 *
 * The CSMS withholds CertificateSignedRequest to test the station's retry behavior
 * with exponential backoff per CertSigningWaitMinimum.
 */
export const TC_A_23_CS: CsTestCase = {
  id: 'TC_A_23_CS',
  name: 'Update Charging Station Certificate by request of CSMS - CertificateSignedRequest Timeout',
  module: 'A-security',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to request the Charging Station to update its charging station certificate using the TriggerMessage and CertificateSigned mechanism.',
  purpose:
    'To verify if the Charging Station is able to send a new SignCertificateRequest when it did not receive a CertificateSignedRequest within the configured timeout.',
  stationConfig: { securityProfile: 3 },
  tls: true,
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const tls = testPki(ctx);
    const waitMinimumSec = 3;

    // Configuration State
    const waitStatus = await setVariable(
      ctx.server,
      'SecurityCtrlr',
      'CertSigningWaitMinimum',
      String(waitMinimumSec),
    );
    const repeatStatus = await setVariable(
      ctx.server,
      'SecurityCtrlr',
      'CertSigningRepeatTimes',
      '1',
    );
    steps.push(
      step(
        0,
        'Configure CertSigningWaitMinimum and CertSigningRepeatTimes = 1',
        waitStatus === 'Accepted' && repeatStatus === 'Accepted',
        'Accepted, Accepted',
        `${String(waitStatus)}, ${String(repeatStatus)}`,
      ),
    );

    // Steps 1-2
    await triggerCsr(ctx, 'SignChargingStationCertificate', steps);

    // Steps 3, 6, 9: the SignCertificateRequest and its two resends
    const csrs: string[] = [];
    const times: number[] = [];
    const timeouts = [15_000, waitMinimumSec * 1000 + 10_000, waitMinimumSec * 2000 + 10_000];
    for (const [i, timeoutMs] of timeouts.entries()) {
      const sign = await waitForSignCertificate(ctx, timeoutMs);
      const stepNo = [3, 6, 9][i] as number;
      steps.push(
        step(
          stepNo,
          `SignCertificateRequest ${String(i + 1)} of 3`,
          sign != null,
          'received',
          sign != null ? 'received' : 'not received',
        ),
      );
      if (sign == null) return result(steps);
      times.push(Date.now());
      const csrPem = sign['csr'] as string | undefined;
      const csrCheck = await csrSteps(stepNo, csrPem);
      steps.push(...csrCheck.steps);
      if (csrPem != null) csrs.push(csrPem);
    }

    // Steps 5 and 8: no resend before CertSigningWaitMinimum, then before two times that
    const firstGap = (times[1] as number) - (times[0] as number);
    const secondGap = (times[2] as number) - (times[1] as number);
    const toleranceMs = 250;
    steps.push(
      step(
        5,
        'No resend before <CertSigningWaitMinimum> expired',
        firstGap >= waitMinimumSec * 1000 - toleranceMs,
        `>= ${String(waitMinimumSec * 1000)} ms`,
        `${String(firstGap)} ms`,
      ),
      step(
        8,
        'No resend before <CertSigningWaitMinimum> times 2 expired',
        secondGap >= waitMinimumSec * 2000 - toleranceMs,
        `>= ${String(waitMinimumSec * 2000)} ms`,
        `${String(secondGap)} ms`,
      ),
    );

    // Steps 11-16: a CertificateSignedRequest for each CSR
    const statuses: string[] = [];
    for (const [i, csrPem] of csrs.entries()) {
      const leafPem = (await signCertificateRequest(csrPem, tls.root)).chainPem;
      const signed = await ctx.server.sendCommand('CertificateSigned', {
        certificateChain: leafPem,
        certificateType: 'ChargingStationCertificate',
      });
      const status = String(signed['status']);
      statuses.push(status);
      steps.push(
        step(
          12 + i * 2,
          `CertificateSignedResponse ${String(i + 1)}: Accepted or Rejected`,
          status === 'Accepted' || status === 'Rejected',
          'Accepted or Rejected',
          status,
        ),
      );
    }

    // Post scenario: at least one CertificateSignedResponse Accepted
    steps.push(
      step(
        17,
        'At least one CertificateSignedResponse has status Accepted',
        statuses.includes('Accepted'),
        'Accepted at least once',
        statuses.join(', '),
      ),
    );

    // No further resend once a certificate was accepted
    await drainMessages(ctx.server, 'SignCertificate', 100);
    return result(steps);
  },
};
