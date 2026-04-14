// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TestCase, StepResult } from '../../../../types.js';

export const TC_A_14_CSMS: TestCase = {
  id: 'TC_A_14_CSMS',
  name: 'Update Charging Station Certificate by request of CSMS - Invalid certificate',
  module: 'A-security',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS requests the Charging Station to update its charging station certificate. The Charging Station rejects the new certificate as invalid.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station rejecting the new Charging Station certificate.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Boot the station first
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

    // Step 1: The CSMS sends a TriggerMessageRequest for SignChargingStationCertificate.
    let triggerMessageReceived = false;
    let triggerRequestedMessage = '';
    let certificateSignedReceived = false;

    ctx.client.setIncomingCallHandler(async (_messageId, action, payload) => {
      if (action === 'TriggerMessage') {
        triggerMessageReceived = true;
        triggerRequestedMessage = String(payload['requestedMessage'] ?? '');
        return { status: 'Accepted' };
      }
      if (action === 'CertificateSigned') {
        certificateSignedReceived = true;
        // Step 6: Reject the certificate as invalid
        return { status: 'Rejected' };
      }
      return { status: 'NotSupported' };
    });

    // Wait for the CSMS to send TriggerMessage
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'TriggerMessage', {
        stationId: ctx.stationId,
        requestedMessage: 'SignChargingStationCertificate',
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    if (triggerMessageReceived) {
      // Validate step 1: TriggerMessage for SignChargingStationCertificate
      steps.push({
        step: 1,
        description: 'CSMS sends TriggerMessageRequest for SignChargingStationCertificate',
        status: triggerRequestedMessage === 'SignChargingStationCertificate' ? 'passed' : 'failed',
        expected: 'requestedMessage = SignChargingStationCertificate',
        actual: `requestedMessage = ${triggerRequestedMessage}`,
      });

      // Step 2-3: Send SignCertificateRequest
      const signRes = await ctx.client.sendCall('SignCertificate', {
        csr: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0Z3VS5JJcds3xfn/ygWeCXIQP+cFgMB+no',
        certificateType: 'ChargingStationCertificate',
      });

      // Step 4: Validate SignCertificateResponse status Accepted
      const signStatus = signRes['status'] as string;
      steps.push({
        step: 2,
        description: 'CSMS responds to SignCertificateRequest with status Accepted',
        status: signStatus === 'Accepted' ? 'passed' : 'failed',
        expected: 'status = Accepted',
        actual: `status = ${signStatus}`,
      });

      // Step 5: Wait for CertificateSignedRequest from CSMS
      await new Promise((resolve) => setTimeout(resolve, 5000));

      steps.push({
        step: 3,
        description: 'CSMS sends CertificateSignedRequest',
        status: certificateSignedReceived ? 'passed' : 'failed',
        expected: 'CertificateSignedRequest received',
        actual: certificateSignedReceived
          ? 'CertificateSignedRequest received'
          : 'No CertificateSignedRequest within timeout',
      });

      // Step 6: CertificateSignedResponse with Rejected (handled above)
      // Step 7: Send SecurityEventNotification with InvalidChargingStationCertificate
      if (certificateSignedReceived) {
        try {
          await ctx.client.sendCall('SecurityEventNotification', {
            type: 'InvalidChargingStationCertificate',
            timestamp: new Date().toISOString(),
          });
          steps.push({
            step: 4,
            description:
              'Send SecurityEventNotificationRequest with type InvalidChargingStationCertificate',
            status: 'passed',
            expected: 'SecurityEventNotificationResponse received',
            actual: 'Response received',
          });
        } catch {
          steps.push({
            step: 4,
            description:
              'Send SecurityEventNotificationRequest with type InvalidChargingStationCertificate',
            status: 'failed',
            expected: 'SecurityEventNotificationResponse received',
            actual: 'Error or rejection',
          });
        }
      }
    } else {
      steps.push({
        step: 1,
        description: 'CSMS sends TriggerMessageRequest for SignChargingStationCertificate',
        status: 'failed',
        expected: 'TriggerMessageRequest received',
        actual: 'No TriggerMessageRequest received within timeout',
      });
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
