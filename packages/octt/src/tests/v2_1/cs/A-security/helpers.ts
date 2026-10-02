// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Shared steps of the A-security CS tests (Test System side of A00-A05).

import 'reflect-metadata';
import { X509Certificate } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import {
  type OcppTestServer,
  type TestServerTls,
  type TlsHandshakeInfo,
  type UpgradeAttempt,
  TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
  TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
  TLS_RSA_WITH_AES_128_GCM_SHA256,
  TLS_RSA_WITH_AES_256_GCM_SHA384,
} from '../../../../cs-server.js';
import { waitForMatchingMessage } from '../../../../cs-test-helpers.js';
import type { CsTestContext, CsTlsMaterial, StepResult } from '../../../../cs-types.js';

export function step(
  stepNo: number,
  description: string,
  ok: boolean,
  expected: string,
  actual: string,
): StepResult {
  return { step: stepNo, description, status: ok ? 'passed' : 'failed', expected, actual };
}

export function result(steps: StepResult[]): {
  status: 'passed' | 'failed';
  durationMs: number;
  steps: StepResult[];
} {
  return {
    status: steps.length > 0 && steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
    durationMs: 0,
    steps,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The first HTTP upgrade request after the first `after` ones, or null on timeout. */
export async function waitForUpgrade(
  server: OcppTestServer,
  after: number,
  timeoutMs: number,
  accepted = true,
): Promise<UpgradeAttempt | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = server.upgradeAttempts.slice(after).find((u) => u.accepted === accepted);
    if (found != null) return found;
    await sleep(50);
  }
  return null;
}

/** Waits until `condition` holds, polling every 50 ms. */
export async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(50);
  }
  return condition();
}

/** The Authorization header a station must send: Basic base64(<stationId>:<password>). */
export function basicAuthHeader(stationId: string, password: string): string {
  return 'Basic ' + Buffer.from(`${stationId}:${password}`).toString('base64');
}

/**
 * Tool validation of a TLS handshake (TC_A_04 step 2, TC_A_07 step 4): TLS 1.2
 * or above, and the required cipher suite pair offered.
 */
export function tlsHandshakeSteps(stepNo: number, tls: TlsHandshakeInfo | null): StepResult[] {
  const protocol = tls?.protocol ?? null;
  const versionOk = protocol === 'TLSv1.2' || protocol === 'TLSv1.3';
  const offered = new Set(tls?.offeredCipherSuites ?? []);
  const ecdsaPair =
    offered.has(TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256) &&
    offered.has(TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384);
  const rsaPair =
    offered.has(TLS_RSA_WITH_AES_128_GCM_SHA256) && offered.has(TLS_RSA_WITH_AES_256_GCM_SHA384);
  return [
    step(
      stepNo,
      'Charging Station uses TLS 1.2 or above',
      versionOk,
      'TLSv1.2 or TLSv1.3',
      protocol ?? 'no TLS handshake',
    ),
    step(
      stepNo,
      'Charging Station supports the required cipher suites',
      ecdsaPair || rsaPair,
      '(TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256 AND TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384) OR (TLS_RSA_WITH_AES_128_GCM_SHA256 AND TLS_RSA_WITH_AES_256_GCM_SHA384)',
      `ECDSA pair: ${String(ecdsaPair)}, RSA pair: ${String(rsaPair)}`,
    ),
  ];
}

const EC_CURVE_BITS: Record<string, number> = {
  prime256v1: 256,
  secp224r1: 224,
  secp384r1: 384,
  secp521r1: 521,
};

/** Key strength rule of A00.FR.502/503: RSA/DSA at least 2048 bits, EC at least 224 bits. */
export function keyStrengthOk(cert: X509Certificate, minEcBits = 224): boolean {
  const key = cert.publicKey;
  const details = key.asymmetricKeyDetails;
  if (key.asymmetricKeyType === 'ec') {
    return (EC_CURVE_BITS[details?.namedCurve ?? ''] ?? 0) >= minEcBits;
  }
  if (
    key.asymmetricKeyType === 'rsa' ||
    key.asymmetricKeyType === 'rsa-pss' ||
    key.asymmetricKeyType === 'dsa'
  ) {
    return (details?.modulusLength ?? 0) >= 2048;
  }
  return false;
}

/** The Test System PKI of a test case with `tls`. */
export function testPki(ctx: CsTestContext): CsTlsMaterial {
  if (ctx.tls == null) throw new Error(`${ctx.stationId}: the test case needs tls: true`);
  return ctx.tls;
}

/** wss:// settings of the main test server, as the executor configures them. */
export function validServerTls(tls: CsTlsMaterial): TestServerTls {
  return {
    cert: `${tls.server.pem}\n${tls.root.pem}`,
    key: tls.server.keyPem,
    ca: tls.root.pem,
    requestCert: true,
  };
}

/** Validation of a CSR in a SignCertificateRequest: PEM PKCS#10, signed, key size. */
export async function csrSteps(
  stepNo: number,
  csrPem: string | undefined,
  opts: { ecdsaOnly?: boolean; minEcBits?: number } = {},
): Promise<{ steps: StepResult[]; csr: x509.Pkcs10CertificateRequest | null }> {
  let csr: x509.Pkcs10CertificateRequest | null = null;
  let signatureOk = false;
  try {
    if (csrPem != null && csrPem.includes('-----BEGIN CERTIFICATE REQUEST-----')) {
      csr = new x509.Pkcs10CertificateRequest(csrPem);
      signatureOk = await csr.verify();
    }
  } catch {
    csr = null;
  }
  const steps = [
    step(
      stepNo,
      'CSR is a PEM encoded PKCS#10 request (RFC 2986) with a valid signature',
      csr != null && signatureOk,
      'PEM CERTIFICATE REQUEST, signature valid',
      csr == null ? 'not a PEM PKCS#10 request' : `signature valid: ${String(signatureOk)}`,
    ),
  ];
  if (csr != null) {
    const key = await csr.publicKey.export();
    const algorithm = key.algorithm as {
      name: string;
      namedCurve?: string;
      modulusLength?: number;
    };
    const isEc = algorithm.name === 'ECDSA' || algorithm.name === 'ECDH';
    const ecBits = Number((algorithm.namedCurve ?? 'P-0').split('-')[1] ?? '0');
    const minEc = opts.minEcBits ?? 224;
    const strengthOk = isEc
      ? ecBits >= minEc
      : opts.ecdsaOnly !== true && (algorithm.modulusLength ?? 0) >= 2048;
    steps.push(
      step(
        stepNo,
        opts.ecdsaOnly === true
          ? `CSR key is ECDSA of at least ${String(minEc)} bits`
          : 'CSR key is RSA/DSA of at least 2048 bits or EC of at least 224 bits',
        strengthOk,
        opts.ecdsaOnly === true ? `ECDSA >= ${String(minEc)} bits` : 'RSA >= 2048 or EC >= 224',
        isEc ? `EC ${String(ecBits)} bits` : `${algorithm.name} ${String(algorithm.modulusLength)}`,
      ),
    );
  }
  return { steps, csr };
}

/** Waits for a SecurityEventNotification of one of `types`. */
export function waitForSecurityEvent(
  server: OcppTestServer,
  types: string[],
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  return waitForMatchingMessage(
    server,
    'SecurityEventNotification',
    (p) => types.includes(p['type'] as string),
    timeoutMs,
  );
}

/**
 * Step 9 of TC_A_04/TC_A_07 and Reusable State Booted step 5: StatusNotification
 * Available and NotifyEvent AvailabilityState Available for the connector.
 */
export async function connectorAvailableSteps(
  server: OcppTestServer,
  stepNo: number,
): Promise<StepResult[]> {
  const status = await waitForMatchingMessage(
    server,
    'StatusNotification',
    (p) => (p['evseId'] as number) !== 0,
    15_000,
  );
  const connectorStatus = status?.['connectorStatus'] as string | undefined;
  const notify = await waitForMatchingMessage(
    server,
    'NotifyEvent',
    (p) => {
      const first = (p['eventData'] as Array<Record<string, unknown>> | undefined)?.[0];
      const component = first?.['component'] as Record<string, unknown> | undefined;
      const variable = first?.['variable'] as Record<string, unknown> | undefined;
      return component?.['name'] === 'Connector' && variable?.['name'] === 'AvailabilityState';
    },
    15_000,
  );
  const event = (notify?.['eventData'] as Array<Record<string, unknown>> | undefined)?.[0];
  return [
    step(
      stepNo,
      'StatusNotificationRequest with connectorStatus Available',
      connectorStatus === 'Available',
      'connectorStatus = Available',
      `connectorStatus = ${connectorStatus ?? 'not received'}`,
    ),
    step(
      stepNo,
      'NotifyEventRequest: trigger Delta, actualValue Available, Connector AvailabilityState',
      event?.['trigger'] === 'Delta' && event['actualValue'] === 'Available',
      'eventData[0]: trigger Delta, actualValue Available, component Connector, variable AvailabilityState',
      event == null
        ? 'not received'
        : `trigger ${String(event['trigger'])}, actualValue ${String(event['actualValue'])}`,
    ),
  ];
}

/** Sends GetVariables for one variable and returns its attributeValue. */
export async function getVariable(
  server: OcppTestServer,
  component: string,
  variable: string,
): Promise<string | undefined> {
  const res = await server.sendCommand('GetVariables', {
    getVariableData: [{ component: { name: component }, variable: { name: variable } }],
  });
  const first = (res['getVariableResult'] as Array<Record<string, unknown>> | undefined)?.[0];
  return first?.['attributeValue'] as string | undefined;
}

/** Sends SetVariables for one variable and returns its attributeStatus. */
export async function setVariable(
  server: OcppTestServer,
  component: string,
  variable: string,
  value: string,
): Promise<string | undefined> {
  const res = await server.sendCommand('SetVariables', {
    setVariableData: [
      { component: { name: component }, variable: { name: variable }, attributeValue: value },
    ],
  });
  const first = (res['setVariableResult'] as Array<Record<string, unknown>> | undefined)?.[0];
  return first?.['attributeStatus'] as string | undefined;
}
