// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// <Generated SignedMeterValueType> of the CSMS meter value cases (TC_E_11,
// TC_J_04, TC_J_11): readings signed by the simulator's OCMF meter signing unit
// (ECDSA secp256r1 / SHA-256), with the public key in the J02.FR.23 form.

import { OcmfMeterSigner } from '@evtivity/css/signed-meter-values';
import { ocppSchemaError } from './ocpp-schema-check.js';
import type { OcppVersion, StepResult } from './types.js';

const ENERGY = 'Energy.Active.Import.Register';

/** The signing unit of the test station's meter: one key pair per test. */
export function createTestMeterSigner(stationId: string): OcmfMeterSigner {
  return new OcmfMeterSigner({
    vendorName: 'OCTT',
    model: 'OCTT-Virtual',
    serialNumber: stationId,
    firmwareVersion: '1.0',
  });
}

/** An energy register SampledValue with its signed meter value. */
export function signedEnergySample(
  signer: OcmfMeterSigner,
  value: number,
  context: string,
  timestamp: string,
): Record<string, unknown> {
  return {
    value,
    context,
    measurand: ENERGY,
    signedMeterValue: signer.sign(
      { value, measurand: ENERGY, unit: 'Wh' },
      timestamp,
      context,
      true,
    ),
  };
}

/**
 * The MeterValue field of the TransactionEventRequest that ends the transaction
 * (Reusable State EVDisconnected): one signed sample with `context`
 * (Sample.Clock or Sample.Periodic), the last one with Transaction.End.
 */
export function signedTransactionEndMeterValues(
  signer: OcmfMeterSigner,
  context: 'Sample.Clock' | 'Sample.Periodic',
): Record<string, unknown>[] {
  const sampledAt = new Date().toISOString();
  const endedAt = new Date().toISOString();
  return [
    { timestamp: sampledAt, sampledValue: [signedEnergySample(signer, 4000, context, sampledAt)] },
    {
      timestamp: endedAt,
      sampledValue: [signedEnergySample(signer, 5000, 'Transaction.End', endedAt)],
    },
  ];
}

/**
 * Records whether the CSMS answered a call with a response that is valid for
 * the version of the test (the case documents' "The CSMS responds with a
 * <Action>Response"): a response missing a required field, or carrying a field
 * or value the version does not define, fails the step.
 */
export function pushValidResponseStep(
  steps: StepResult[],
  step: number,
  version: OcppVersion,
  action: string,
  response: Record<string, unknown>,
): void {
  const error = ocppSchemaError(version, action, 'response', response);
  steps.push({
    step,
    description: `The CSMS responds with a valid ${action}Response`,
    status: error == null ? 'passed' : 'failed',
    expected: `${action}Response valid for ${version}`,
    actual: error ?? 'Valid',
  });
}
