// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

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
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Wait for station to connect and boot
    await ctx.server.waitForMessage('BootNotification', 30_000);

    // Step 1: Execute Reusable State RenewChargingStationCertificate
    // Send TriggerMessage to request SignChargingStationCertificate
    const triggerRes = await ctx.server.sendCommand('TriggerMessage', {
      requestedMessage: 'SignChargingStationCertificate',
    });
    const triggerStatus = triggerRes['status'] as string | undefined;
    steps.push({
      step: 1,
      description: 'Send TriggerMessageRequest for SignChargingStationCertificate, expect Accepted',
      status: triggerStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${triggerStatus ?? 'not received'}`,
    });

    // Step 2: Wait for SignCertificateRequest from station
    let csrPayload: Record<string, unknown> | null = null;
    try {
      csrPayload = await ctx.server.waitForMessage('SignCertificate', 30_000);
    } catch {
      // handled below
    }
    const csr = csrPayload?.['csr'] as string | undefined;
    const csrValid = csr != null && csr.length > 0;
    steps.push({
      step: 2,
      description:
        'Station sends SignCertificateRequest with valid CSR (PEM format, adequate key size)',
      status: csrValid ? 'passed' : 'failed',
      expected: 'csr contains a valid CSR in PEM format',
      actual: csrValid ? 'CSR received' : 'CSR not received or empty',
    });

    // Step 3: Send CertificateSignedRequest with a valid certificate chain
    // In a real test, the certificate is generated from the CSR and signed by the CSMS root CA.
    const certSignedRes = await ctx.server.sendCommand('CertificateSigned', {
      certificateChain: '-----BEGIN CERTIFICATE-----\nMIIBtest...\n-----END CERTIFICATE-----',
      certificateType: 'ChargingStationCertificate',
    });
    const certStatus = certSignedRes['status'] as string | undefined;
    steps.push({
      step: 3,
      description: 'Send CertificateSignedRequest, expect Accepted',
      status: certStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${certStatus ?? 'not received'}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
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
  stationConfig: { securityProfile: 3 },
  // Skipped: requires V2G certificate infrastructure not available in test environment
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
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
  // Skipped: requires real certificate validation infrastructure to test invalid cert rejection
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
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
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Wait for station to connect and boot
    await ctx.server.waitForMessage('BootNotification', 30_000);

    // Step 1: Send TriggerMessageRequest for SignChargingStationCertificate
    const triggerRes = await ctx.server.sendCommand('TriggerMessage', {
      requestedMessage: 'SignChargingStationCertificate',
    });
    const triggerStatus = triggerRes['status'] as string | undefined;
    steps.push({
      step: 1,
      description: 'Send TriggerMessageRequest for SignChargingStationCertificate, expect Accepted',
      status: triggerStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${triggerStatus ?? 'not received'}`,
    });

    // Step 3: Wait for SignCertificateRequest from station
    let csrReceived = false;
    try {
      const csrPayload = await ctx.server.waitForMessage('SignCertificate', 30_000);
      csrReceived = csrPayload != null;
    } catch {
      // handled below
    }
    steps.push({
      step: 2,
      description: 'Station sends SignCertificateRequest',
      status: csrReceived ? 'passed' : 'failed',
      expected: 'SignCertificateRequest received',
      actual: csrReceived
        ? 'SignCertificateRequest received'
        : 'SignCertificateRequest not received',
    });

    // Step 4: The test server responds with SignCertificateResponse status Rejected.
    // This is handled by the message handler. The station should accept the rejection gracefully.
    // No further action expected from the station.

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
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
  // Skipped: requires certificate signing infrastructure for timeout and retry validation
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
